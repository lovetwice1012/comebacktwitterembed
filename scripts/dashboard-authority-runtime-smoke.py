#!/usr/bin/env python3
"""Test an isolated Next listener with disposable lease evidence; no DB writes."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--environment-pid', type=int, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists(): raise ValueError('Report must be new')
    stage = args.stage.resolve(strict=True)
    env = {k.decode():v.decode() for item in Path(f'/proc/{args.environment_pid}/environ').read_bytes().split(b'\0') if b'=' in item for k,v in [item.split(b'=',1)]}
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    checks=[]
    with tempfile.TemporaryDirectory(prefix='cbte-dashboard-authority-') as temporary:
        lease = Path(temporary)/'lease.json'
        def evidence(state, epoch=13, node='primary'):
            lease.write_text(json.dumps({'state':state,'node':node,'epoch':epoch,'instanceId':f'{node}:runtime-fixture-{epoch}','validUntilUnixMs':int(time.time()*1000)+60000}))
        evidence('stopped')
        env.update(DASHBOARD_NEXT_DIST_DIR='.next-account-ui-preview',DASHBOARD_FLEET_LEASE_MODE='shared-current',CBTE_FLEET_LEASE_FILE=str(lease),CBTE_FLEET_NODE='primary',CBTE_FLEET_EPOCH='13',NEXT_TELEMETRY_DISABLED='1',DASHBOARD_ADMIN_ANALYTICS_PREWARM='false')
        log=Path(temporary)/'next.private.log'
        with log.open('xb') as output:
            os.chmod(log,0o600)
            process=subprocess.Popen(['/usr/local/bin/node',str(stage/'dashboard/node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',str(port)],cwd=stage/'dashboard',env=env,stdout=output,stderr=subprocess.STDOUT)
            def request(path,method='GET',extra=None):
                headers={'Host':'cbte.sprink.cloud','X-Forwarded-Proto':'https','Origin':'https://cbte.sprink.cloud','Content-Type':'application/json',**(extra or {})}
                req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,headers=headers,method=method,data=None if method=='GET' else b'{}')
                try:response=urllib.request.urlopen(req,timeout=10)
                except urllib.error.HTTPError as error:response=error
                with response:return response.status,response.read(1000000)
            try:
                for _ in range(100):
                    if process.poll() is not None:raise ValueError('Isolated Next stopped during startup')
                    try:
                        status,body=request('/api/health')
                        if status==200:break
                    except OSError:time.sleep(.2)
                else:raise ValueError('Isolated Next readiness deadline')
                assert json.loads(body)['authorityAvailable'] is False
                checks.append({'check':'HTTP-health-survives-stopped-lease','status':status,'authorityAvailable':False})
                for path in ['/','/api/auth/providers','/api/auth/session','/api/auth/csrf']:
                    status,_=request(path);assert status==200
                    checks.append({'check':'view-or-auth-reachable','path':path,'status':status})
                for method,path in [('POST','/api/__dashboard_authority_probe__'),('PATCH','/api/guilds/000000000000000000/settings'),('DELETE','/api/me/personal-links/saved/fixture-never-created')]:
                    status,body=request(path,method);assert status==503 and json.loads(body)['code']=='DASHBOARD_AUTHORITY_UNAVAILABLE'
                    checks.append({'check':'mutation-rejected-before-handler','method':method,'path':path,'status':status})
                status,body=request('/api/__dashboard_authority_probe__','POST',{'x-middleware-subrequest':'middleware:middleware:middleware:middleware:middleware'})
                assert status==503 and json.loads(body)['code']=='DASHBOARD_AUTHORITY_UNAVAILABLE'
                checks.append({'check':'forged-middleware-subrequest-cannot-bypass-guard','status':status})
                evidence('active',99)
                status,body=request('/api/health');assert status==200 and json.loads(body)['authorityAvailable'] is True and json.loads(body)['epoch']==99
                checks.append({'check':'renewed-epoch-without-Next-restart','status':status,'epoch':99})
                status,_=request('/api/__dashboard_authority_probe__','POST');assert status==404
                checks.append({'check':'active-authority-admits-nonexistent-handler-only','status':status})
                evidence('active',99,'oci')
                status,body=request('/api/health');assert status==200 and json.loads(body)['authorityAvailable'] is False
                status,_=request('/api/__dashboard_authority_probe__','POST');assert status==503
                checks.append({'check':'wrong-node-still-fails-closed','status':status})
            finally:
                process.terminate()
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    report={'checks':checks,'isolatedRuntime':True,'disposableLeaseOnly':True,'productionLeaseModified':False,'databaseMutations':0,'productionPointerChanged':False,'nextProcessStopped':True}
    args.report.write_text(json.dumps(report,indent=2)+'\n');os.chmod(args.report,0o600)
    print(json.dumps(report))


if __name__=='__main__':
    try:main()
    except (OSError,ValueError,AssertionError,subprocess.TimeoutExpired) as error:
        print(f'Stopped: {type(error).__name__}: {error}');raise SystemExit(1)
