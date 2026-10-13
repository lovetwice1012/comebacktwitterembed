#!/usr/bin/env python3
"""Prepare/promote an independently supervised dashboard without restarting Bot.

Run as root only after reviewing the exact stage, artifact report, and unit.
Secrets are captured directly from /proc into a private JSON file and are never
printed or placed in command arguments. Existing installations fail closed.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.request


@dataclass(frozen=True)
class Layout:
    current: Path = Path("/opt/cbte-dashboard/current")
    runtime_env: Path = Path("/etc/cbte-dashboard/environment.json")
    unit: Path = Path("/etc/systemd/system/cbte-dashboard.service")
    bot_dropin: Path = Path("/etc/systemd/system/cbte.service.d/98-independent-dashboard.conf")
    nginx_gateway: Path = Path("/etc/nginx/conf.d/cbte-admin-gateway.conf")
    nginx_origin: Path = Path("/etc/nginx/conf.d/cbte-dashboard-origin.conf")
    proc: Path = Path("/proc")


LAYOUT = Layout()
SERVICE = "cbte-dashboard.service"


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1048576), b""):
            result.update(chunk)
    return result.hexdigest()


def bytes_sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        # Command output can contain config values. Keep diagnostics private.
        raise RuntimeError(f"Command failed ({result.returncode}): {command[0]}")
    return result.stdout.strip()


def service_field(service: str, field: str) -> str:
    return run(["systemctl", "show", service, "-p", field, "--value"])


def new_file(path: Path, content: bytes, mode: int = 0o600) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, "wb") as file:
        file.write(content)
        file.flush()
        os.fsync(file.fileno())


def atomic_file(path: Path, content: bytes, mode: int = 0o600) -> None:
    temporary = path.with_name(f".{path.name}.dashboard-{os.getpid()}.tmp")
    new_file(temporary, content, mode)
    try:
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, indent=2) + "\n").encode()


def process_identity(pid: int, layout: Layout) -> dict:
    stat = (layout.proc / str(pid) / "stat").read_text()
    fields = stat[stat.rfind(")") + 2:].split()
    return {"pid": pid, "parentPid": int(fields[1]), "startTicks": fields[19],
            "cwd": str((layout.proc / str(pid) / "cwd").resolve(strict=True))}


def identities(args, layout: Layout) -> dict:
    if service_field("cbte.service", "ActiveState") != "active":
        raise ValueError("Bot service is not active")
    if service_field("cbte.service", "MainPID") != str(args.expected_bot_main_pid):
        raise ValueError("Bot MainPID changed")
    release = args.expected_live_release.resolve(strict=True)
    main = process_identity(args.expected_bot_main_pid, layout)
    bot = process_identity(args.expected_bot_workload_pid, layout)
    wrapper = process_identity(args.expected_wrapper_pid, layout)
    child = process_identity(args.expected_next_pid, layout)
    if bot["cwd"] != str(release) or wrapper["cwd"] != str(release / "dashboard") or child["cwd"] != wrapper["cwd"]:
        raise ValueError("Observed workload/dashboard release changed")
    if bot["parentPid"] != main["pid"] or wrapper["parentPid"] != bot["pid"] or child["parentPid"] != wrapper["pid"]:
        raise ValueError("Observed guardian/Bot/dashboard process ancestry changed")
    return {"main": main, "bot": bot, "wrapper": wrapper, "next": child}


def environment(pid: int, layout: Layout) -> dict[str, str]:
    raw = (layout.proc / str(pid) / "environ").read_bytes()
    return {key.decode(): value.decode() for item in raw.split(b"\0") if item
            for key, value in [item.split(b"=", 1)]}


def artifact(args) -> dict:
    if sha256(args.artifact_report) != args.expected_artifact_report_sha256.lower():
        raise ValueError("Reviewed artifact report hash mismatch")
    report = json.loads(args.artifact_report.read_text())
    stage = args.stage_root.resolve(strict=True)
    build = Path(report["buildPath"]).resolve(strict=True)
    if Path(report["stageRoot"]).resolve(strict=True) != stage or stage / "dashboard" not in build.parents:
        raise ValueError("Report does not identify this isolated dashboard build")
    if report["buildId"] != args.expected_build_id or (build / "BUILD_ID").read_text().strip() != args.expected_build_id:
        raise ValueError("Reviewed BUILD_ID mismatch")
    if report["missingTraceFiles"] or report["externalTracePaths"]:
        raise ValueError("Build trace report has unresolved references")
    for traced in report.get("tracePaths", []):
        if not Path(traced).exists():
            raise ValueError("A reviewed external build dependency disappeared")
    if not report.get("artifactFiles"):
        raise ValueError("Artifact report contains no files")
    for name, expected in report["artifactFiles"].items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            raise ValueError("Unsafe artifact report path")
        path = build / name
        if not path.is_file() or path.is_symlink() or sha256(path) != expected:
            raise ValueError(f"Reviewed artifact changed: {name}")
    return {"stage": stage, "build": build, "buildId": report["buildId"]}


def health(port: int, timeout: float = 40) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(f"http://127.0.0.1:{port}/api/health",
                                             headers={"User-Agent": "CBTE-Dashboard-Deployment/1.0"})
            with urllib.request.urlopen(request, timeout=2) as response:
                body = json.loads(response.read(16384))
                if response.status == 200 and body.get("ok") is True:
                    return {"status": 200, "ok": True, "authorityAvailable": body.get("authorityAvailable")}
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError(f"Dashboard health unavailable on loopback port {port}")


def public_health(origin: str) -> dict:
    request = urllib.request.Request(origin + "/api/health", headers={"User-Agent": "CBTE-Dashboard-Deployment/1.0"})
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.loads(response.read(16384))
        if response.status != 200 or body.get("ok") is not True:
            raise RuntimeError("Canonical public dashboard health check failed")
    return {"status": 200, "ok": True}


def free_port(port: int) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", port))


def validate_unit(source: Path) -> bytes:
    content = source.read_bytes()
    text = content.decode()
    if re.search(r"^(?:PartOf|BindsTo|Requires|After)=.*cbte\.service", text, re.M):
        raise ValueError("Dashboard unit is coupled to Bot service")
    for required in ("Restart=always", "start-dashboard.js serve", "DASHBOARD_RUNTIME_ENV_FILE=/etc/cbte-dashboard/environment.json",
                     "DASHBOARD_FLEET_LEASE_MODE=shared-current", "DASHBOARD_HOSTNAME=127.0.0.1"):
        if required not in text:
            raise ValueError("Reviewed unit is missing an independent-service requirement")
    return content


def prepare(args, layout: Layout = LAYOUT) -> dict:
    observed = identities(args, layout)
    built = artifact(args)
    unit_bytes = validate_unit(args.unit_source)
    if built["stage"] == args.expected_live_release.resolve():
        raise ValueError("Independent dashboard source must be isolated")
    pointer = built["stage"] / "dashboard/.next-builds/current.json"
    protected = (layout.current, layout.runtime_env, layout.unit, layout.bot_dropin, pointer, args.backup_dir)
    if any(path.exists() or path.is_symlink() for path in protected):
        raise ValueError("An installation target already exists; preserve and inspect it before retrying")
    if service_field(SERVICE, "LoadState") != "not-found":
        raise ValueError("An independent dashboard unit is already loaded; preserve it")
    free_port(args.port)
    captured = environment(args.expected_next_pid, layout)
    if captured.get("CBTE_FLEET_NODE") not in {"primary", "oci"} or not Path(captured.get("CBTE_FLEET_LEASE_FILE", "")).is_absolute():
        raise ValueError("Observed Next environment has no valid fleet node/lease reference")
    for name in ("DASHBOARD_DISABLED", "DISABLE_DASHBOARD", "DASHBOARD_NEXT_DIST_DIR", "DASHBOARD_NPM_SCRIPT"):
        captured.pop(name, None)
    captured.update(PORT=str(args.port), DASHBOARD_PORT=str(args.port),
                    DASHBOARD_FLEET_LEASE_MODE="shared-current", DASHBOARD_MANAGED_EXTERNALLY="true",
                    NEXTAUTH_URL=args.canonical_origin, DASHBOARD_BASE_URL=args.canonical_origin,
                    DASHBOARD_INTEGRATED_MEDIA_SERVER="true")
    args.backup_dir.mkdir(parents=True, mode=0o700)
    metadata = {"version": 1, "status": "preparing", "stageRoot": str(built["stage"]), "buildId": built["buildId"],
                "port": args.port, "canonicalOrigin": args.canonical_origin, "observed": observed,
                "artifactReportSha256": args.expected_artifact_report_sha256.lower(),
                "unitSha256": bytes_sha256(unit_bytes), "paths": {"current": str(layout.current), "unit": str(layout.unit),
                "runtimeEnvironment": str(layout.runtime_env), "stagePointer": str(pointer), "botDropin": str(layout.bot_dropin)},
                "publicRoutingChanged": False, "botRestartRequested": False}
    new_file(args.backup_dir / "prepare.json", json_bytes(metadata))
    created: list[Path] = []
    started = False
    try:
        pointer.parent.mkdir(parents=True, exist_ok=True)
        new_file(pointer, json_bytes({"version": 1, "distDir": built["build"].relative_to(built["stage"] / "dashboard").as_posix(),
                                    "buildId": built["buildId"], "builtAt": datetime.now(timezone.utc).isoformat()}))
        created.append(pointer)
        layout.current.parent.mkdir(parents=True, exist_ok=True)
        layout.current.symlink_to(built["stage"], target_is_directory=True)
        created.append(layout.current)
        layout.runtime_env.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        new_file(layout.runtime_env, json_bytes(captured))
        created.append(layout.runtime_env)
        new_file(layout.unit, unit_bytes, mode=0o644)
        created.append(layout.unit)
        if identities(args, layout) != observed:
            raise ValueError("Processes changed during preparation")
        run(["systemctl", "daemon-reload"])
        started = True
        run(["systemctl", "start", SERVICE])
        metadata["health"] = health(args.port)
        if service_field(SERVICE, "ActiveState") != "active":
            raise ValueError("Independent dashboard service is not active")
        metadata["dashboardMainPID"] = service_field(SERVICE, "MainPID")
        metadata["runtimeEnvironmentSha256"] = sha256(layout.runtime_env)
        metadata["stagePointerSha256"] = sha256(pointer)
        metadata["status"] = "prepared"
        atomic_file(args.backup_dir / "prepare.json", json_bytes(metadata))
        return {"status": "prepared", "buildId": built["buildId"], "dashboardMainPID": metadata["dashboardMainPID"],
                "port": args.port, "publicRoutingChanged": False, "botRestartRequested": False}
    except Exception as error:
        if started:
            try:
                run(["systemctl", "stop", SERVICE])
            except RuntimeError:
                metadata["serviceStopFailed"] = True
        # Preserve the source/build and evidence. Roll back only newly created
        # installation references, unless stopping this new service failed.
        if not metadata.get("serviceStopFailed"):
            for path in reversed(created):
                if path.is_file() or path.is_symlink():
                    path.unlink()
            try:
                run(["systemctl", "daemon-reload"])
            except RuntimeError:
                pass
        metadata.update(status="prepare_failed", failureType=type(error).__name__)
        atomic_file(args.backup_dir / "prepare.json", json_bytes(metadata))
        raise


def promote(args, layout: Layout = LAYOUT) -> dict:
    metadata = json.loads((args.backup_dir / "prepare.json").read_text())
    if metadata["status"] != "prepared":
        raise ValueError("A successful, unpromoted prepare record is required")
    observed = identities(args, layout)
    built = artifact(args)
    if observed != metadata["observed"] or built["buildId"] != metadata["buildId"] or str(built["stage"]) != metadata["stageRoot"]:
        raise ValueError("Prepared installation or process identities changed")
    if args.port != metadata["port"] or args.canonical_origin != metadata["canonicalOrigin"]:
        raise ValueError("Prepared port or canonical origin changed")
    if not layout.current.is_symlink() or layout.current.resolve() != built["stage"]:
        raise ValueError("Stable dashboard source pointer changed")
    for path, expected in ((layout.runtime_env, metadata["runtimeEnvironmentSha256"]), (layout.unit, metadata["unitSha256"]),
                           (Path(metadata["paths"]["stagePointer"]), metadata["stagePointerSha256"])):
        if sha256(path) != expected:
            raise ValueError("Prepared environment, unit, or build pointer changed")
    if layout.bot_dropin.exists() or layout.bot_dropin.is_symlink():
        raise ValueError("Bot compatibility drop-in already exists; preserve it")
    if service_field(SERVICE, "ActiveState") != "active" or service_field(SERVICE, "MainPID") != metadata["dashboardMainPID"]:
        raise ValueError("Independent dashboard service identity changed")
    health(args.port)
    backup = args.backup_dir / "nginx"
    if backup.exists():
        raise ValueError("Nginx backup directory already exists; preserve prior attempt")
    changes = []
    pattern = re.compile(rb"(?m)(^\s*proxy_pass\s+http://127\.0\.0\.1:)30989(?=(?:/)?\s*;)")
    for path in (layout.nginx_gateway, layout.nginx_origin):
        if not path.is_file() or path.is_symlink():
            raise ValueError("Nginx configuration must be an existing regular file")
        original = path.read_bytes()
        updated, count = pattern.subn(lambda match: match.group(1) + str(args.port).encode(), original)
        if count != 1:
            raise ValueError(f"Expected exactly one dashboard upstream in {path.name}")
        changes.append({"path": path, "original": original, "updated": updated, "mode": path.stat().st_mode & 0o777})
    backup.mkdir(mode=0o700)
    transaction = {"status": "promoting", "configs": [], "oldWrapperPid": args.expected_wrapper_pid,
                   "botRestartRequested": False}
    for change in changes:
        saved = backup / change["path"].name
        new_file(saved, change["original"])
        transaction["configs"].append({"path": str(change["path"]), "backup": str(saved),
                                      "beforeSha256": bytes_sha256(change["original"]), "afterSha256": bytes_sha256(change["updated"])})
    new_file(args.backup_dir / "promote.json", json_bytes(transaction))
    applied = []
    reload_attempted = False
    dropin_created = False
    enable_attempted = False
    old_wrapper_stop_requested = False
    try:
        for change in changes:
            if change["path"].read_bytes() != change["original"]:
                raise ValueError("Nginx configuration changed concurrently")
            atomic_file(change["path"], change["updated"], change["mode"])
            applied.append(change)
        run(["nginx", "-t"])
        reload_attempted = True
        run(["systemctl", "reload", "nginx"])
        health(30987)
        health(args.port)
        transaction["publicHealth"] = public_health(args.canonical_origin)
        if identities(args, layout) != observed:
            raise ValueError("Bot/dashboard processes changed before ownership handoff")
        dropin = ("[Service]\nEnvironment=DASHBOARD_MANAGED_EXTERNALLY=true\nEnvironment=DASHBOARD_DISABLED=true\n"
                  "Environment=DASHBOARD_INTEGRATED_MEDIA_SERVER=true\n"
                  f"Environment=NEXTAUTH_URL={args.canonical_origin}\nEnvironment=DASHBOARD_BASE_URL={args.canonical_origin}\n").encode()
        layout.bot_dropin.parent.mkdir(parents=True, exist_ok=True)
        new_file(layout.bot_dropin, dropin, mode=0o644)
        dropin_created = True
        transaction["botDropinSha256"] = bytes_sha256(dropin)
        run(["systemctl", "daemon-reload"])
        enable_attempted = True
        run(["systemctl", "enable", SERVICE])
        transaction["dashboardServiceEnabled"] = True
        health(args.port)
        if service_field(SERVICE, "ActiveState") != "active" or service_field(SERVICE, "MainPID") != metadata["dashboardMainPID"]:
            raise ValueError("Independent dashboard changed immediately before ownership handoff")
        if identities(args, layout) != observed:
            raise ValueError("Processes changed immediately before stopping old wrapper")
        # Exact PID plus parent/start-ticks checks prevent stopping a replacement
        # workload. Do not signal Bot or the old Next child independently.
        os.kill(args.expected_wrapper_pid, signal.SIGTERM)
        old_wrapper_stop_requested = True
        transaction.update(status="promoted", publicRoutingChanged=True, oldWrapperStopRequested=True)
        atomic_file(args.backup_dir / "promote.json", json_bytes(transaction))
        return {"status": "promoted", "port": args.port, "publicRoutingChanged": True,
                "botRestartRequested": False, "oldWrapperStopRequested": True,
                "dashboardMainPID": metadata["dashboardMainPID"]}
    except Exception as error:
        if old_wrapper_stop_requested:
            # Returning to the old upstream after stopping its wrapper would
            # create an outage. Keep the verified independent upstream serving.
            transaction.update(status="promoted_metadata_failure", failureType=type(error).__name__,
                               publicRoutingChanged=True, oldWrapperStopRequested=True)
            try:
                atomic_file(args.backup_dir / "promote.json", json_bytes(transaction))
            except OSError:
                pass
            raise
        if enable_attempted:
            try:
                run(["systemctl", "disable", SERVICE])
            except RuntimeError:
                transaction["serviceDisableRollbackFailed"] = True
        if dropin_created and layout.bot_dropin.exists() and sha256(layout.bot_dropin) == transaction.get("botDropinSha256"):
            layout.bot_dropin.unlink()
            try:
                run(["systemctl", "daemon-reload"])
            except RuntimeError:
                pass
        conflicts = []
        for change in reversed(applied):
            if change["path"].read_bytes() == change["updated"]:
                atomic_file(change["path"], change["original"], change["mode"])
            else:
                conflicts.append(str(change["path"]))
        if reload_attempted:
            try:
                run(["nginx", "-t"])
                run(["systemctl", "reload", "nginx"])
            except RuntimeError:
                transaction["nginxRestoreReloadFailed"] = True
        transaction.update(status="promote_failed", failureType=type(error).__name__, rollbackConflicts=conflicts)
        atomic_file(args.backup_dir / "promote.json", json_bytes(transaction))
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "promote"))
    parser.add_argument("--stage-root", type=Path, required=True)
    parser.add_argument("--artifact-report", type=Path, required=True)
    parser.add_argument("--expected-artifact-report-sha256", required=True)
    parser.add_argument("--expected-build-id", required=True)
    parser.add_argument("--expected-bot-main-pid", type=int, required=True)
    parser.add_argument("--expected-bot-workload-pid", type=int, required=True)
    parser.add_argument("--expected-wrapper-pid", type=int, required=True)
    parser.add_argument("--expected-next-pid", type=int, required=True)
    parser.add_argument("--expected-live-release", type=Path, required=True)
    parser.add_argument("--unit-source", type=Path, required=True)
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=31089)
    parser.add_argument("--canonical-origin", default="https://cbte.sprink.cloud")
    args = parser.parse_args()
    if os.name != "posix" or os.geteuid() != 0:
        raise ValueError("This installer requires the root Linux production host")
    if not 1024 <= args.port <= 65535 or args.port in {30987, 30988, 30989}:
        raise ValueError("Independent dashboard port must be outside the current origins")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::[0-9]+)?", args.canonical_origin):
        raise ValueError("Canonical origin must be an HTTPS origin without credentials or path")
    if not all(path.is_absolute() for path in (args.stage_root, args.expected_live_release, args.artifact_report, args.unit_source, args.backup_dir)):
        raise ValueError("All source, report, release, and backup paths must be absolute")
    result = prepare(args) if args.command == "prepare" else promote(args)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"Stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
