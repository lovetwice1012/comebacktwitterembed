"""Prepare root-only runtime configuration without printing credentials."""
import json
import os
import pathlib
import pwd
import secrets
import subprocess
import sys

source = pathlib.Path(sys.argv[1]).resolve()
revision = sys.argv[2]
if source != pathlib.Path("/root/comebacktwitterembed") or len(revision) != 40:
    raise SystemExit("Unexpected release source")
directory = pathlib.Path("/etc/cbte-admin")
directory.mkdir(mode=0o700, exist_ok=True)
config = json.loads((source / "config.json").read_text())
existing = {}
core_file = directory / "core.env"
if core_file.exists():
    for line in core_file.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            existing[key] = value
token = existing.get("ADMIN_AGENT_TOKEN") or secrets.token_hex(32)
public = config.get("dashboard", {}).get("publicBaseUrl", "https://cbte.sprink.cloud").rstrip("/")
owner = existing.get("ADMIN_OWNER_ID", "796972193287503913")
password_hash = existing.get("ADMIN_AGENT_PASSWORD_HASH", "")
if not password_hash:
    bootstrap = directory / "bootstrap-password"
    if bootstrap.exists():
        password = bootstrap.read_text().strip()
    else:
        password = secrets.token_urlsafe(24)
        fd = os.open(str(bootstrap), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(password + "\n")
    password_hash = subprocess.check_output(
        ["/opt/cbte-admin/current/cbte-admin", "password-hash"],
        input=(password + "\n").encode()).decode().strip()
shared = "/var/lib/cbte-admin-shared"
common = {
    "ADMIN_AGENT_TOKEN": token, "ADMIN_OWNER_ID": owner, "BOT_BUILD_REVISION": revision,
    "ADMIN_AGENT_WORKER": "/opt/cbte-admin/worker-runtime/src/adminSupport/worker.js",
    "ADMIN_AGENT_WORKER_DIR": "/opt/cbte-admin/worker-runtime",
    "ADMIN_AGENT_NODE": "/usr/local/bin/node", "ADMIN_SUPPORT_DATA_DIR": shared,
    "ADMIN_QUERY_REGISTRY_DIR": shared + "/report-queries",
    "ADMIN_PROVIDER_OVERRIDE_FILE": shared + "/provider-source-overrides.json",
    "ADMIN_TELEMETRY_ENABLED": "0",
}
core = {
    **common, "ADMIN_AGENT_LISTEN": "127.0.0.1:30988", "ADMIN_AGENT_STATE_DIR": "/var/lib/cbte-admin",
    "ADMIN_AGENT_PUBLIC_URL": public + "/ops/", "ADMIN_AGENT_BASE_PATH": "/ops",
    "ADMIN_AGENT_PASSWORD_HASH": password_hash, "ADMIN_AGENT_COOKIE_SECURE": "true",
    "ADMIN_AGENT_WORKER_URL": "http://127.0.0.1:30990/execute",
    "ADMIN_AGENT_REPORT_WORKER_URL": "http://127.0.0.1:30991/execute",
    "ADMIN_AGENT_LOCAL_HEALTH_URL": "http://127.0.0.1:30989/api/health",
    "ADMIN_AGENT_PUBLIC_HEALTH_URL": public + "/api/health",
    "ADMIN_AGENT_EXECUTOR_SOCKET": "/run/cbte-admin-executor/executor.sock",
    "ADMIN_AGENT_BOT_UNIT": "cbte.service",
    "ADMIN_AGENT_DISCORD_WEBHOOK": config.get("errorNotificationURL") or config.get("URL", ""),
    "ADMIN_AGENT_PUSH_WEBHOOK": existing.get("ADMIN_AGENT_PUSH_WEBHOOK", ""),
}
analysis = {
    **common, "ADMIN_ANALYSIS_LISTEN": "127.0.0.1:30990",
    "ADMIN_ANALYSIS_STATE_DIR": "/var/lib/cbte-admin-analysis",
    "SAVES_DIR": "/var/lib/cbte-admin-analysis/saves", "ADMIN_WORKER_DEADLINE_MS": "110000",
}
reports = {
    **common, "ADMIN_ANALYSIS_LISTEN": "127.0.0.1:30991",
    "ADMIN_ANALYSIS_STATE_DIR": "/var/lib/cbte-admin-reports", "ADMIN_ANALYSIS_ACTIONS": "reports.build",
    "ADMIN_WORKER_DEADLINE_MS": "640000", "DASHBOARD_REPORT_QUERY_TIMEOUT_MS": "120000",
    "DASHBOARD_DB_CONNECTION_LIMIT": "16",
}
account = pwd.getpwnam("cbte-admin")
executor = {
    "ADMIN_AGENT_EXECUTOR_SOCKET": "/run/cbte-admin-executor/executor.sock",
    "ADMIN_AGENT_EXECUTOR_STATE_DIR": "/var/lib/cbte-admin-executor",
    "ADMIN_AGENT_EXECUTOR_ALLOWED_UID": str(account.pw_uid),
    "ADMIN_AGENT_EXECUTOR_GROUP_GID": str(account.pw_gid), "ADMIN_AGENT_BOT_UNIT": "cbte.service",
}
bot = {
    "ADMIN_AGENT_TOKEN": token, "ADMIN_OWNER_ID": owner, "ADMIN_AGENT_URL": "http://127.0.0.1:30988",
    "ADMIN_AGENT_PUBLIC_URL": public + "/ops/",
    "ADMIN_AGENT_EXECUTOR_SOCKET": "/run/cbte-admin-executor/executor.sock",
    "ADMIN_TELEMETRY_DIR": "/var/lib/cbte-admin-bot-spool",
    "ADMIN_PROVIDER_OVERRIDE_FILE": shared + "/provider-source-overrides.json",
    "DASHBOARD_PORT": "30989", "PORT": "30989", "BOT_BUILD_REVISION": revision, "APP_REVISION": revision,
}
for name, values in (("core", core), ("analysis", analysis), ("reports", reports), ("executor", executor), ("bot", bot)):
    for key, value in values.items():
        if "\n" in str(value) or "\r" in str(value):
            raise SystemExit("Invalid newline in environment value: " + key)
    destination = directory / (name + ".env")
    fd = os.open(str(destination), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as output:
        output.write("".join(key + "=" + str(value) + "\n" for key, value in values.items()))
    os.chmod(destination, 0o600)
print("Wrote protected configuration for core, isolated workers, executor, and Bot.")
