#!/usr/bin/env python3
"""Inspect or explicitly select an already staged build; never restart Bot.

inspect reads build traces and reports immutable artifact hashes.
prepare-link adds a new symlink only, keeping current.json unchanged.
activate requires the observed pointer hash and process identities, saves a
rollback copy, then atomically replaces only dashboard/.next-builds/current.json.
No command executes systemctl restart, kills a process, or edits live sources.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_new(path: Path, payload: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(payload)
        file.flush()
        os.fsync(file.fileno())


def inspect_build(build: Path, stage: Path, live: Path) -> dict:
    # These are the two dependency trees already used by the live release.
    # Release node_modules are versioned symlinks; resolve only these explicit
    # roots rather than admitting arbitrary paths outside the staged source.
    dependency_roots = ((live / "node_modules").resolve(strict=True),
                        (live / "dashboard/node_modules").resolve(strict=True))
    build_id = (build / "BUILD_ID").read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", build_id):
        raise ValueError("Invalid BUILD_ID")
    artifact = {p.relative_to(build).as_posix(): digest(p)
                for p in sorted(build.rglob("*")) if p.is_file() and not p.is_symlink()}
    paths: set[str] = set()
    missing: list[str] = []
    escapes: list[str] = []
    for trace in build.rglob("*.nft.json"):
        for value in json.loads(trace.read_text()).get("files", []):
            path = (trace.parent / value).resolve()
            paths.add(str(path))
            if not path.exists():
                missing.append(str(path))
            if not any(path == allowed or allowed in path.parents for allowed in (stage, live, *dependency_roots)):
                escapes.append(str(path))
    return {"version": 1, "buildPath": str(build), "stageRoot": str(stage),
            "liveRelease": str(live), "buildId": build_id,
            "approvedLiveDependencyRoots": [str(path) for path in dependency_roots],
            "artifactFiles": artifact, "tracePaths": sorted(paths),
            "missingTraceFiles": sorted(set(missing)), "externalTracePaths": sorted(set(escapes)),
            "productionPointerChanged": False}


def check_identity(wrapper: int, child: int, bot_main: int, live_dashboard: Path) -> None:
    if Path(f"/proc/{wrapper}/cwd").resolve() != live_dashboard:
        raise ValueError("Wrapper cwd changed")
    if Path(f"/proc/{child}/cwd").resolve() != live_dashboard:
        raise ValueError("Next child cwd changed")
    stat = Path(f"/proc/{child}/stat").read_text()
    # The comm field may contain spaces, so parse after its closing parenthesis.
    parent_pid = int(stat[stat.rfind(")") + 2:].split()[1])
    if parent_pid != wrapper:
        raise ValueError("Observed Next process is no longer the wrapper child")
    current = subprocess.check_output(["systemctl", "show", "cbte.service", "-p", "MainPID", "--value"], text=True).strip()
    if current != str(bot_main):
        raise ValueError("Bot systemd MainPID changed; rerun the preflight")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "prepare-link", "activate"))
    parser.add_argument("--live-release", type=Path, required=True)
    parser.add_argument("--stage-root", type=Path, required=True)
    parser.add_argument("--dist-dir", default=".next-account-ui-preview")
    parser.add_argument("--link-name", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--expected-report-sha256")
    parser.add_argument("--expected-pointer-sha256")
    parser.add_argument("--expected-wrapper-pid", type=int)
    parser.add_argument("--expected-next-child-pid", type=int)
    parser.add_argument("--expected-bot-main-pid", type=int)
    args = parser.parse_args()
    if not re.fullmatch(r"account-ui-preview-[a-z0-9][a-z0-9-]{1,80}", args.link_name):
        raise ValueError("Use a unique account-ui-preview-... link name")
    if not re.fullmatch(r"\.next-[a-z0-9][a-z0-9-]{1,80}", args.dist_dir):
        raise ValueError("Invalid dist directory")
    live = args.live_release.resolve(strict=True)
    stage = args.stage_root.resolve(strict=True)
    build = (stage / "dashboard" / args.dist_dir).resolve(strict=True)
    if stage not in build.parents or live == stage:
        raise ValueError("The build must be isolated from the live release")
    if args.command == "inspect":
        report = inspect_build(build, stage, live)
        write_new(args.report, (json.dumps(report, indent=2) + "\n").encode())
        print(json.dumps({"buildId": report["buildId"], "artifactCount": len(report["artifactFiles"]),
                          "traceCount": len(report["tracePaths"]), "missingCount": len(report["missingTraceFiles"]),
                          "externalTraceCount": len(report["externalTracePaths"]), "reportSha256": digest(args.report)}))
        return 0 if not report["missingTraceFiles"] and not report["externalTracePaths"] else 1
    if not args.expected_report_sha256 or digest(args.report) != args.expected_report_sha256:
        raise ValueError("Reviewed trace report hash is required")
    report = json.loads(args.report.read_text())
    if report["buildPath"] != str(build) or report["liveRelease"] != str(live):
        raise ValueError("Trace report belongs to a different build/release")
    if report["missingTraceFiles"] or report["externalTracePaths"]:
        raise ValueError("Trace report has unresolved paths")
    actual = inspect_build(build, stage, live)
    if actual != report:
        raise ValueError("Build artifact or trace paths changed after inspection")
    dashboard = live / "dashboard"
    root = dashboard / ".next-builds"
    if not root.is_dir():
        raise ValueError("Observed live build root is missing")
    target = root / args.link_name
    if args.command == "prepare-link":
        if target.exists() or target.is_symlink():
            raise ValueError("Link destination already exists; no overwrite allowed")
        target.symlink_to(build, target_is_directory=True)
        print(json.dumps({"preparedLink": str(target), "productionPointerChanged": False}))
        return 0
    if not target.is_symlink() or target.resolve() != build:
        raise ValueError("Expected prepared link is missing")
    pointer = root / "current.json"
    if not args.expected_pointer_sha256 or digest(pointer) != args.expected_pointer_sha256:
        raise ValueError("Current build pointer changed or expected hash was omitted")
    identities = (args.expected_wrapper_pid, args.expected_next_child_pid, args.expected_bot_main_pid)
    if not all(identities):
        raise ValueError("All observed process identities are required")
    check_identity(*identities, dashboard)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = root / f"current.before-{args.link_name}-{stamp}.json"
    previous = pointer.read_bytes()
    write_new(backup, previous)
    payload = {"version": 1, "distDir": f".next-builds/{args.link_name}",
               "buildId": report["buildId"], "builtAt": datetime.now(timezone.utc).isoformat()}
    temporary = root / f"current.account-preview-{os.getpid()}.tmp"
    write_new(temporary, (json.dumps(payload, indent=2) + "\n").encode())
    # Recheck immediately before selecting the build. Never overwrite a
    # concurrent deployment's pointer.
    if pointer.read_bytes() != previous:
        temporary.unlink()
        raise ValueError("Pointer changed while preparing activation")
    os.replace(temporary, pointer)
    print(json.dumps({"activatedBuildId": report["buildId"], "rollbackPointer": str(backup),
                      "previousPointerSha256": hashlib.sha256(previous).hexdigest(),
                      "productionPointerChanged": True, "botRestartRequested": False}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
