#!/usr/bin/env python3
"""Prepare an isolated dashboard source; never select a production build.

Manifest: {"files": [{"path": "dashboard/...", "sha256": "..."}]}.
Run on the Linux production host after the exact overlay manifest is reviewed.
The --build option invokes Next directly, deliberately bypassing the activating
dashboard/scripts/start-dashboard.js build command.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def safe_overlay_name(value: str) -> str:
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value:
        raise ValueError(f"Unsafe overlay path: {value}")
    name = str(path)
    if not name.startswith("dashboard/"):
        raise ValueError(f"Only dashboard files may be overlaid: {name}")
    # These exact entrypoints are part of the authorized dashboard isolation
    # and authenticated UI opt-in rollout. Other APIs, dependencies and Bot
    # modules still stay outside a dashboard overlay.
    scoped_runtime = {
        "dashboard/app/api/health/route.ts",
        "dashboard/app/api/me/dashboard-ui/route.ts",
        "dashboard/middleware.ts",
        "dashboard/next.config.ts",
        "dashboard/scripts/start-dashboard.js",
    }
    blocked = ("dashboard/app/api/", "dashboard/components/automation/",
               "dashboard/prisma/",
               "dashboard/node_modules/", "dashboard/scripts/", "dashboard/public/")
    if (name.startswith(blocked) and name not in scoped_runtime) or any(p.startswith(".next") for p in path.parts):
        raise ValueError(f"Outside the normal-dashboard UI scope: {name}")
    if name in {"dashboard/package.json", "dashboard/package-lock.json"}:
        raise ValueError(f"Dependencies and build configuration must stay live-compatible: {name}")
    if name.startswith("dashboard/app/dashboard/automation/"):
        raise ValueError(f"Automation must remain the live source: {name}")
    if any(part.startswith(".env") for part in path.parts):
        raise ValueError("Environment files cannot be overlaid")
    return name


def proc_environment(pid: int) -> dict[str, str]:
    raw = Path(f"/proc/{pid}/environ").read_bytes()
    return {key.decode(): value.decode() for item in raw.split(b"\0") if item
            for key, value in [item.split(b"=", 1)]}


def ignore_dashboard(directory: str, entries: list[str]) -> set[str]:
    return {name for name in entries if name == "node_modules" or name == ".git"
            or name.startswith(".next") or name.endswith(".tsbuildinfo")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live-release", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, help="Current Bot/config runtime when dashboard source comes from an earlier verified UI stage")
    parser.add_argument("--stage-root", type=Path, required=True)
    parser.add_argument("--overlay-root", type=Path, required=True)
    parser.add_argument("--overlay-manifest", type=Path, required=True)
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--node", type=Path, default=Path("/usr/local/bin/node"))
    parser.add_argument("--environment-pid", type=int)
    parser.add_argument("--dist-dir", default=".next-account-ui-preview")
    args = parser.parse_args()
    live = args.live_release.resolve(strict=True)
    runtime = args.runtime_root.resolve(strict=True) if args.runtime_root else live
    stage = args.stage_root.absolute()
    overlay = args.overlay_root.resolve(strict=True)
    if stage.exists() or stage.is_symlink():
        raise ValueError("Stage must be a new path; existing contents are never overwritten")
    if live == stage or live in stage.parents:
        raise ValueError("Stage must be outside the live release")
    if not re.fullmatch(r"\.next-[a-z0-9][a-z0-9-]{1,80}", args.dist_dir):
        raise ValueError("Use a simple isolated .next-... directory")
    if args.build and not args.environment_pid:
        raise ValueError("Building requires the observed live Next PID to inherit its environment privately")
    raw_manifest = json.loads(args.overlay_manifest.read_text())
    entries = raw_manifest["files"] if isinstance(raw_manifest, dict) else raw_manifest
    files: dict[str, str] = {}
    for entry in entries:
        name = safe_overlay_name(entry["path"])
        expected = entry["sha256"].lower()
        if name in files or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError(f"Duplicate path or invalid hash: {name}")
        source = overlay / name
        if not source.is_file() or source.is_symlink() or sha256(source) != expected:
            raise ValueError(f"Overlay hash mismatch: {name}")
        files[name] = expected
    if not files:
        raise ValueError("Empty overlay")
    stage.mkdir(parents=True)
    # No root Bot/data/config/backend files are copied or changed. Their live
    # references remain intact, including package and runtime dependencies.
    for entry in runtime.iterdir():
        if entry.name not in {"dashboard", ".git", ".dashboard-account-stage.json"}:
            (stage / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
    shutil.copytree(live / "dashboard", stage / "dashboard", symlinks=True,
                    ignore=ignore_dashboard)
    (stage / "dashboard/node_modules").symlink_to(runtime / "dashboard/node_modules", target_is_directory=True)
    # Avoid creating a second copy of any live dotenv secret.
    for source in (live / "dashboard").glob(".env*"):
        destination = stage / "dashboard" / source.name
        if destination.is_file() or destination.is_symlink():
            destination.unlink()
            destination.symlink_to(source)
    for name in files:
        destination = stage / name
        if destination.is_symlink():
            raise ValueError(f"Refusing to overwrite a live symlink: {name}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if (stage / "dashboard").resolve() not in destination.resolve().parents:
            raise ValueError(f"Overlay parent resolves outside staged dashboard: {name}")
        shutil.copy2(overlay / name, destination)
    unchanged: dict[str, str] = {}
    for directory, directories, filenames in os.walk(live / "dashboard", followlinks=False):
        directories[:] = [name for name in directories if name not in {"node_modules", ".git"} and not name.startswith(".next")]
        for filename in filenames:
            source = Path(directory) / filename
            relative = source.relative_to(live)
            if source.is_file() and not source.is_symlink() and not source.name.endswith(".tsbuildinfo"):
                name = relative.as_posix()
                if name not in files:
                    expected = sha256(source)
                    if sha256(stage / relative) != expected:
                        raise ValueError(f"Non-overlay source changed: {name}")
                    unchanged[name] = expected
    report = {"version": 1, "liveRelease": str(live), "runtimeRoot": str(runtime), "stageRoot": str(stage),
              "overlayManifestSha256": sha256(args.overlay_manifest), "overlayFiles": files,
              "unchangedDashboardFiles": unchanged, "distDir": args.dist_dir,
              "productionPointerChanged": False}
    (stage / ".dashboard-account-stage.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"stageRoot": str(stage), "overlayCount": len(files),
                      "unchangedCount": len(unchanged), "productionPointerChanged": False}))
    if args.build:
        env = proc_environment(args.environment_pid)
        env.update(DASHBOARD_NEXT_DIST_DIR=args.dist_dir, NEXT_TELEMETRY_DISABLED="1",
                   DASHBOARD_ADMIN_ANALYTICS_PREWARM="false")
        return subprocess.run([str(args.node), str(runtime / "dashboard/node_modules/next/dist/bin/next"), "build"],
                              cwd=stage / "dashboard", env=env).returncode
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError) as error:
        print(f"Stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
