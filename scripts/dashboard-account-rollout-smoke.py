#!/usr/bin/env python3
"""Start the staged symlink build on loopback and always stop only this probe.

The current production pointer remains unchanged. The exact live Next child
environment is inherited privately; authentication/DB secrets are never printed.
This verifies build relocation/runtime loading and unauthenticated routes only.
It does not assert authenticated old/new UI parity.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live-release", type=Path, required=True)
    parser.add_argument("--link-name", required=True)
    parser.add_argument("--environment-pid", type=int, required=True)
    parser.add_argument("--port", type=int, default=30990)
    parser.add_argument("--node", type=Path, default=Path("/usr/local/bin/node"))
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"account-ui-preview-[a-z0-9][a-z0-9-]{1,80}", args.link_name):
        raise ValueError("Invalid prepared build link name")
    if not 1024 <= args.port <= 65535 or args.port in {30987, 30988, 30989}:
        raise ValueError("Use a free nonproduction port")
    if args.report.exists() or args.report.with_suffix(".log").exists():
        raise ValueError("Probe report/log must be new paths")
    live = args.live_release.resolve(strict=True)
    dashboard = live / "dashboard"
    link = dashboard / ".next-builds" / args.link_name
    if not link.is_symlink() or not (link / "BUILD_ID").is_file():
        raise ValueError("Prepared symlink build is missing")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", args.port))
    raw = Path(f"/proc/{args.environment_pid}/environ").read_bytes()
    env = {key.decode(): value.decode() for item in raw.split(b"\0") if item
           for key, value in [item.split(b"=", 1)]}
    env.update(DASHBOARD_NEXT_DIST_DIR=f".next-builds/{args.link_name}",
               PORT=str(args.port), DASHBOARD_PORT=str(args.port),
               NEXT_TELEMETRY_DISABLED="1", DASHBOARD_ADMIN_ANALYTICS_PREWARM="false")
    pointer = dashboard / ".next-builds/current.json"
    previous = pointer.read_bytes()
    results = []
    process = None
    started = time.monotonic()
    try:
        fd = os.open(args.report.with_suffix(".log"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as log:
            process = subprocess.Popen([str(args.node), str(dashboard / "node_modules/next/dist/bin/next"),
                                        "start", "--hostname", "127.0.0.1", "--port", str(args.port)],
                                       cwd=dashboard, env=env, stdout=log, stderr=subprocess.STDOUT)
            opener = urllib.request.build_opener(NoRedirect())
            while time.monotonic() - started < 40:
                if process.poll() is not None:
                    raise ValueError("Probe Next process exited during startup; inspect private probe log")
                try:
                    with opener.open(f"http://127.0.0.1:{args.port}/api/health", timeout=2) as response:
                        body = json.loads(response.read())
                        if response.status == 200 and body.get("ok") is True:
                            results.append({"path": "/api/health", "status": 200, "ok": True})
                            break
                except (OSError, urllib.error.HTTPError, json.JSONDecodeError):
                    time.sleep(.2)
            else:
                raise ValueError("Probe health did not become ready within 40 seconds")
            for endpoint, acceptable in (("/api/auth/session", {200}), ("/api/auth/providers", {200}),
                                         ("/dashboard", {302, 303, 307, 308}), ("/", {200, 302, 307})):
                try:
                    with opener.open(f"http://127.0.0.1:{args.port}{endpoint}", timeout=10) as response:
                        status = response.status
                except urllib.error.HTTPError as response:
                    status = response.code
                if status not in acceptable:
                    raise ValueError(f"Probe route failed: {endpoint} HTTP {status}")
                results.append({"path": endpoint, "status": status})
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if pointer.read_bytes() != previous:
            raise ValueError("Production pointer changed during probe; check concurrent work")
    report = {"loopbackPort": args.port, "probePid": process.pid, "probeStopped": process.poll() is not None,
              "buildId": (link / "BUILD_ID").read_text().strip(), "checks": results,
              "productionPointerChanged": False, "authenticatedUIVerified": False,
              "elapsedSeconds": round(time.monotonic() - started, 2)}
    fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(report, file, indent=2)
        file.write("\n")
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"Stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
