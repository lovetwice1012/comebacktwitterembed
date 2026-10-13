#!/usr/bin/env python3
"""Authorized production Bot-only restart with dashboard/lease/heartbeat proof."""
import argparse
import datetime
import json
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request


def field(unit, name):
    return subprocess.check_output(['systemctl','show',unit,'-p',name,'--value'],text=True).strip()


def identity(pid):
    p=Path(f'/proc/{pid}')
    text=(p/'stat').read_text(); parts=text[text.rfind(')')+2:].split()
    return {'pid':pid,'parentPid':int(parts[1]),'startTicks':parts[19],'cgroup':(p/'cgroup').read_text().splitlines()[-1]}


def request(url,method='GET'):
    req=urllib.request.Request(url,method=method,data=b'{}' if method=='POST' else None,headers={'Origin':'https://cbte.sprink.cloud','Content-Type':'application/json','User-Agent':'CBTE-Dashboard-Continuity/1.0'})
    try:r=urllib.request.urlopen(req,timeout=6)
    except urllib.error.HTTPError as error:r=error
    with r:return r.status,r.read(200000)


def heartbeat():
    with sqlite3.connect('file:/var/lib/cbte-admin/state.db?mode=ro',uri=True,timeout=2) as db:
        row=db.execute('SELECT payload,occurred_at FROM latest_heartbeat WHERE id=1').fetchone()
    payload=json.loads(row[0]);details=payload.get('details') or {}
    if isinstance(details,str):details=json.loads(details)
    return {'occurredAt':row[1],'pid':details.get('pid'),'ready':details.get('ready'),'shards':details.get('shard_summary'),'recordingFailure':details.get('recording_failure'),'buildRevision':payload.get('build_revision')}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-dashboard-main-pid',type=int,required=True)
    parser.add_argument('--expected-next-pid',type=int,required=True)
    parser.add_argument('--expected-bot-main-pid',type=int,required=True)
    parser.add_argument('--expected-bot-workload-pid',type=int,required=True)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('--deadline',type=int,default=300)
    args=parser.parse_args()
    if args.report.exists():raise ValueError('Use a new report path')
    assert field('cbte-dashboard.service','MainPID')==str(args.expected_dashboard_main_pid)
    assert field('cbte-dashboard.service','ActiveState')=='active'
    assert field('cbte.service','MainPID')==str(args.expected_bot_main_pid)
    before={'dashboard':identity(args.expected_dashboard_main_pid),'next':identity(args.expected_next_pid),'botMainPid':args.expected_bot_main_pid,'bot':identity(args.expected_bot_workload_pid),'heartbeat':heartbeat()}
    assert before['next']['parentPid']==args.expected_dashboard_main_pid
    assert before['next']['cgroup'].endswith('/cbte-dashboard.service')
    assert before['heartbeat']['pid']==args.expected_bot_workload_pid and before['heartbeat']['ready'] is True
    status,body=request('https://cbte.sprink.cloud/api/health');assert status==200 and json.loads(body).get('authorityAvailable') is True
    dropin=Path('/etc/systemd/system/cbte.service.d/98-independent-dashboard.conf').read_text()
    assert 'DASHBOARD_DISABLED=true' in dropin and 'DASHBOARD_INTEGRATED_MEDIA_SERVER=true' in dropin
    started=datetime.datetime.now(datetime.timezone.utc).isoformat();start=time.monotonic()
    restarted=subprocess.run(['systemctl','restart','cbte.service'],capture_output=True,text=True)
    if restarted.returncode:raise ValueError('Bot-only restart command failed')
    samples=[];failures=[];saw_gap=False;saw_reacquired=False;previous=None;final_heartbeat=None
    while time.monotonic()-start<args.deadline:
        sample={'elapsedSeconds':round(time.monotonic()-start,3)}
        try:
            status,body=request('https://cbte.sprink.cloud/api/health');health=json.loads(body)
            sample.update(healthStatus=status,authorityAvailable=health.get('authorityAvailable'),instanceId=health.get('instanceId'))
            if status!=200:failures.append({'check':'public-health','status':status})
            for name,path in [('home','/'),('auth','/api/auth/providers')]:
                code,_=request('https://cbte.sprink.cloud'+path);sample[name+'Status']=code
                if code!=200:failures.append({'check':name,'status':code})
            code,_=request('https://cbte.sprink.cloud/api/__dashboard_authority_probe__','POST')
            sample['nonexistentMutationStatus']=code
            if sample['authorityAvailable'] is False:
                saw_gap=True
                if code!=503:
                    # The lease may be reacquired between these two separate
                    # HTTP requests. Confirm the new state before calling a
                    # valid newly admitted request a guard failure.
                    verify_status,verify_body=request('https://cbte.sprink.cloud/api/health')
                    transitioned=verify_status==200 and json.loads(verify_body).get('authorityAvailable') is True and code==404
                    sample['authorityChangedDuringSample']=transitioned
                    if transitioned:saw_reacquired=True
                    else:failures.append({'check':'authority-gap-write-guard','status':code})
            elif sample['authorityAvailable'] is True:
                if code not in [404,503]:failures.append({'check':'active-nonexistent-handler','status':code})
                if saw_gap:saw_reacquired=True
            sample['dashboardMainPid']=int(field('cbte-dashboard.service','MainPID'))
            if sample['dashboardMainPid']!=args.expected_dashboard_main_pid or identity(args.expected_next_pid)!=before['next']:
                failures.append({'check':'dashboard-process-identity-changed'})
            state=(sample['authorityAvailable'],sample['nonexistentMutationStatus'],sample['dashboardMainPid'])
            if state!=previous:
                print(json.dumps({'progress':sample}),flush=True);previous=state
            final_heartbeat=heartbeat()
            lease=json.loads(Path('/run/cbte-recovery/primary-lease.json').read_text())
            shards=final_heartbeat.get('shards') or {}
            fresh=final_heartbeat['occurredAt']>=started
            ready=fresh and final_heartbeat['pid']==lease.get('childPid') and final_heartbeat['pid']!=args.expected_bot_workload_pid and final_heartbeat['ready'] is True and shards.get('total',0)>0 and shards.get('online')==shards.get('total') and shards.get('offline')==0 and shards.get('unknown')==0
            sample['botReady']=ready
            samples.append(sample)
            if ready and saw_reacquired and time.monotonic()-start>20:break
        except Exception as error:
            failures.append({'check':'sample-failure','type':type(error).__name__})
            sample['errorType']=type(error).__name__;samples.append(sample)
        time.sleep(2)
    after={'dashboard':identity(args.expected_dashboard_main_pid),'next':identity(args.expected_next_pid),'botMainPid':int(field('cbte.service','MainPID')),'heartbeat':final_heartbeat,'dashboardRestarts':int(field('cbte-dashboard.service','NRestarts'))}
    passed=not failures and saw_gap and saw_reacquired and bool(samples[-1].get('botReady')) and before['dashboard']==after['dashboard'] and before['next']==after['next']
    report={'startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passed':passed,'botOnlyRestartExecuted':True,'before':before,'after':after,'samples':samples,'failures':failures,'authorityGapObserved':saw_gap,'authorityReacquiredWithoutDashboardRestart':saw_reacquired,'databaseMutations':0,'privateDataRequests':0}
    args.report.write_text(json.dumps(report,indent=2)+'\n');args.report.chmod(0o600)
    print(json.dumps({'passed':passed,'samples':len(samples),'failures':failures,'dashboardMainPid':after['dashboard']['pid'],'nextPid':after['next']['pid'],'botMainPid':after['botMainPid'],'heartbeat':final_heartbeat,'authorityGapObserved':saw_gap,'authorityReacquiredWithoutDashboardRestart':saw_reacquired}),flush=True)
    if not passed:raise SystemExit(1)


if __name__=='__main__':main()
