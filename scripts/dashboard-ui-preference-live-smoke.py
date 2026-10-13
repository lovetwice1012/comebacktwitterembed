#!/usr/bin/env python3
"""Exercise only UI cookies using synthetic sessions; no Discord/DB mutations."""
import argparse
import json
import os
from pathlib import Path
import subprocess

NODE_PROBE = r'''
const fs = require('node:fs');
const { encode } = require(process.env.PROBE_RELEASE + '/dashboard/node_modules/next-auth/jwt');
const config = JSON.parse(fs.readFileSync(process.env.PROBE_RELEASE + '/config.json', 'utf8'));
const secret = process.env.NEXTAUTH_SECRET || config.dashboard?.nextAuthSecret || config.nextAuthSecret;
if (!secret) throw new Error('Session signing is unavailable');
const base = process.env.PROBE_BASE;
const origin = process.env.NEXTAUTH_URL || 'https://cbte.sprink.cloud';
const checks = [];
const ordinary = '123456789012345678';
const other = '223456789012345678';
const jars = new Map();
async function auth(id) {
 if (!id) return '';
 return '__Secure-next-auth.session-token=' + await encode({ secret, maxAge: 300, token: {discordId:id,username:'UI preference verification',accessToken:'synthetic-ui-only-not-sent-to-discord',expiresAt:Date.now()+3600000} });
}
async function request(id, path='/', options={}) {
 const cookie = [await auth(id), jars.get(id)].filter(Boolean).join('; ');
 return fetch(base + path, {redirect:'manual',...options,headers:{Host:'cbte.sprink.cloud','X-Forwarded-Proto':'https',Cookie:cookie,...options.headers}});
}
async function view(id, expected, label) {
 const response=await request(id); const html=await response.text();
 const version=/data-dashboard-ui="([^"]+)"/.exec(html)?.[1];
 if (response.status!==200 || version!==expected) throw new Error('UI preference render failed: '+label);
 const toggle=html.includes('data-dashboard-ui-preference');
 if (toggle !== Boolean(id)) throw new Error('Preference control visibility failed: '+label);
 checks.push({check:label,status:response.status,version,toggle});
}
async function set(id, version) {
 const response=await request(id,'/api/me/dashboard-ui',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({version,viewerId:other})});
 const body=await response.json();
 const cookie=response.headers.get('set-cookie');
 if (response.status!==200 || body.version!==version || !cookie?.includes('cbte_dashboard_ui_'+id+'=')) throw new Error('Preference POST failed');
 if (!/httponly/i.test(cookie)|| !/secure/i.test(cookie)|| !/samesite=lax/i.test(cookie)) throw new Error('Preference cookie protections missing');
 jars.set(id,cookie.split(';')[0]);
 checks.push({check:'authenticated-'+version,status:200,cookieAccountBound:true,httpOnly:true,secure:true,sameSite:'lax'});
}
(async()=>{
 await view(ordinary,'legacy','ordinary-default-legacy');
 await set(ordinary,'preview');
 const previewCookie=jars.get(ordinary);
 await view(ordinary,'preview','ordinary-opt-in');
 await view(ordinary,'preview','ordinary-preference-survives-next-request');
 await view(other,'legacy','other-account-unaffected');
 const denied=await request(ordinary,'/admin');
 if(denied.status!==404) throw new Error('UI preference changed admin permissions');
 checks.push({check:'ordinary-admin-still-denied',status:denied.status});
 await set(ordinary,'legacy'); await view(ordinary,'legacy','ordinary-return-to-legacy');
 await view(null,'legacy','guest-legacy-no-toggle');
 const guest=await request(null,'/api/me/dashboard-ui',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{"version":"preview"}'});
 if(guest.status!==401)throw new Error('Guest preference unexpectedly accepted');
 checks.push({check:'guest-preference-denied',status:guest.status});
 jars.set(other,previewCookie.replace('cbte_dashboard_ui_'+ordinary,'cbte_dashboard_ui_'+other));
 await view(other,'legacy','copied-account-cookie-rejected');
 const cross=await request(ordinary,'/api/me/dashboard-ui',{method:'POST',headers:{Origin:'https://invalid.example','Content-Type':'application/json'},body:'{"version":"preview"}'});
 if(cross.status!==403)throw new Error('Cross-origin preference accepted');
 checks.push({check:'cross-origin-denied',status:cross.status});
 process.stdout.write(JSON.stringify({checks,sessionModel:'Short-lived signed synthetic sessions; not actual OAuth',cookieOnlyChanges:true,privateDataRequests:0,databaseMutations:0,discordRequests:0}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--environment-pid', type=int, required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists(): raise ValueError('Use a new report path')
    env = {k.decode(): v.decode() for item in Path(f'/proc/{args.environment_pid}/environ').read_bytes().split(b'\0') if b'=' in item for k,v in [item.split(b'=',1)]}
    env.update(PROBE_RELEASE=str(args.release.resolve(strict=True)), PROBE_BASE=f'http://127.0.0.1:{args.port}')
    result = subprocess.run(['/usr/local/bin/node', '-e', NODE_PROBE], env=env, cwd=args.release/'dashboard', capture_output=True, text=True, timeout=60)
    if result.returncode: raise ValueError(result.stderr.strip() or 'UI preference probe failed')
    report = json.loads(result.stdout)
    report.update(port=args.port, actualOAuthLoginVerified=False)
    args.report.write_text(json.dumps(report, indent=2)+'\n')
    os.chmod(args.report, 0o600)
    print(json.dumps(report))


if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f'Stopped: {error}')
        raise SystemExit(1)
