#!/usr/bin/env python3
"""Read-only staging parity using short-lived signed synthetic sessions.

Tokens/secrets stay in memory and never enter evidence or logs. No Discord
access token is reused. Only HTML/auth/session/health GET requests are made.
"""
from __future__ import annotations
import argparse, hashlib, json, os, pathlib, socket, subprocess, time, urllib.request

NODE_PROBE = r'''
const fs = require('node:fs');
const { encode } = require(process.env.UI_PROBE_LIVE + '/dashboard/node_modules/next-auth/jwt');
const config = JSON.parse(fs.readFileSync(process.env.UI_PROBE_LIVE + '/config.json', 'utf8'));
const secret = process.env.NEXTAUTH_SECRET || config.dashboard?.nextAuthSecret || config.nextAuthSecret;
if (!secret) throw new Error('Runtime signing secret unavailable');
const cookieName = 'https://cbte.sprink.cloud'.startsWith('https:') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
async function check(id, endpoint, expected, expectedStatus) {
  const cookie = id ? `${cookieName}=${await encode({ secret, maxAge: 300, token: { discordId: id, username: 'UI rollout verification', accessToken: 'synthetic-ui-only-never-sent-to-discord', expiresAt: Date.now() + 3600000 } })}` : 'dashboard_ui=preview';
  const response = await fetch(process.env.UI_PROBE_BASE + endpoint, { redirect: 'manual', headers: { Cookie: cookie, Host: 'cbte.sprink.cloud', 'X-Forwarded-Proto': 'https' } });
  const body = await response.text();
  const version = /data-dashboard-ui="([^"]+)"/.exec(body)?.[1];
  const redirect = /NEXT_REDIRECT/.test(body) && /url=\/?[";]|;\/;/.test(body);
  const genericDenial = expectedStatus === 404 && response.status === 404 && version === undefined;
  if ((!genericDenial && version !== expected) || response.status !== expectedStatus) throw new Error(`Parity failed for ${id || 'guest'} ${endpoint}: HTTP ${response.status}, UI ${version}`);
  if (!genericDenial && !/private|no-store/i.test(response.headers.get('cache-control') || '')) throw new Error('Authenticated HTML lacks private caching policy');
  return { identity: id || 'anonymous', path: endpoint, status: response.status, version: genericDenial ? 'not-rendered' : version, accessDenied: genericDenial, streamedRedirect: redirect, cacheControl: response.headers.get('cache-control') };
}
(async () => {
 const results = [];
 for (const endpoint of ['/api/health', '/api/auth/providers', '/api/auth/session']) {
   const response = await fetch(process.env.UI_PROBE_BASE + endpoint, {headers:{Host:'cbte.sprink.cloud','X-Forwarded-Proto':'https'}});
   const data = await response.json();
   if (response.status !== 200 || endpoint === '/api/health' && data.ok !== true) throw new Error(`Probe prerequisite failed: ${endpoint} HTTP ${response.status}`);
   results.push({path:endpoint,status:response.status,...(endpoint === '/api/health' ? {ok:data.ok,node:data.node,epoch:data.epoch,instanceId:data.instanceId}: {})});
 }
 results.push(await check('796972193287503913', '/admin', 'preview', 200));
 results.push(await check('933314562487386122', '/admin?ui=preview&viewerId=796972193287503913', 'legacy', 200));
 results.push(await check('123456789012345678', '/admin?ui=preview&viewerId=796972193287503913', 'legacy', 404));
 results.push(await check(null, '/?ui=preview&viewerId=796972193287503913', 'legacy', 200));
 const guest = await fetch(process.env.UI_PROBE_BASE + '/dashboard', {redirect:'manual',headers:{Host:'cbte.sprink.cloud','X-Forwarded-Proto':'https'}});
 const html = await guest.text();
 const denied = [302,303,307,308].includes(guest.status) || guest.status === 200 && html.includes('NEXT_REDIRECT') && (html.includes('url=/') || html.includes(';\/;'));
 if (!denied) throw new Error(`Anonymous dashboard denial missing: HTTP ${guest.status}`);
 results.push({identity:'anonymous',path:'/dashboard',status:guest.status,loginRedirectVerified:denied});
 process.stdout.write(JSON.stringify({sessionModel:'Short-lived signed synthetic sessions; not a real OAuth login',privateDataRequests:0,mutations:0,checks:results}));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'''

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--live-release', type=pathlib.Path, required=True)
    parser.add_argument('--link-name', required=True)
    parser.add_argument('--environment-pid', type=int, required=True)
    parser.add_argument('--report', type=pathlib.Path, required=True)
    parser.add_argument('--live-port', type=int)
    args = parser.parse_args()
    live = args.live_release.resolve(strict=True)
    dashboard = live / 'dashboard'
    if not args.link_name.startswith('account-ui-preview-') or '/' in args.link_name or '..' in args.link_name:
        raise ValueError('Unexpected preview link name')
    if args.report.exists(): raise ValueError('Report must be a fresh path')
    env = {key.decode(): value.decode() for item in pathlib.Path('/proc/%s/environ' % args.environment_pid).read_bytes().split(b'\0') if b'=' in item for key,value in [item.split(b'=',1)]}
    pointer = dashboard / '.next-builds/current.json'
    before = pointer.read_bytes()
    process = None
    log = None
    try:
        if args.live_port:
            port = args.live_port
        else:
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
            env.update(DASHBOARD_NEXT_DIST_DIR='.next-builds/' + args.link_name, PORT=str(port), DASHBOARD_PORT=str(port), NEXT_TELEMETRY_DISABLED='1', DASHBOARD_ADMIN_ANALYTICS_PREWARM='false')
            log = open(str(args.report) + '.private.log', 'xb')
            os.chmod(str(args.report) + '.private.log', 0o600)
            process = subprocess.Popen(['/usr/local/bin/node', str(dashboard/'node_modules/next/dist/bin/next'), 'start', '--hostname','127.0.0.1','--port',str(port)], cwd=dashboard, env=env, stdout=log, stderr=subprocess.STDOUT)
            for _ in range(200):
                if process.poll() is not None: raise ValueError('Staged probe exited during startup')
                try:
                    with urllib.request.urlopen('http://127.0.0.1:%s/api/health' % port, timeout=2) as response:
                        if response.status == 200: break
                except OSError: time.sleep(.2)
            else: raise ValueError('Probe health deadline exceeded')
        env.update(UI_PROBE_LIVE=str(live), UI_PROBE_BASE='http://127.0.0.1:%s' % port)
        result = subprocess.run(['/usr/local/bin/node', '-e', NODE_PROBE], cwd=dashboard, env=env, capture_output=True, text=True, timeout=50)
        if result.returncode: raise ValueError(result.stderr.strip() or 'Signed parity probe failed')
        report = json.loads(result.stdout)
        report.update(probePort=port, productionPointerChanged=pointer.read_bytes()!=before, actualOAuthLoginVerified=False)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait(timeout=5)
        if log: log.close()
        if pointer.read_bytes()!=before: raise ValueError('Production pointer changed during probe')
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    os.chmod(args.report,0o600)
    print(json.dumps(report))

if __name__=='__main__':
    try: main()
    except (OSError, ValueError, subprocess.TimeoutExpired) as error: print('Stopped: %s' % error); raise SystemExit(1)
