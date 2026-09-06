"""Prepare root-only primary runtime configuration without printing credentials."""
import json
import os
import pathlib
import re
import secrets
import shlex
import subprocess
import sys
from urllib.parse import urlsplit

OWNER = "796972193287503913"
ADMINS = "933314562487386122,796972193287503913"
FLEET_FIELDS = {"CBTE_FLEET_LEASE_FILE", "CBTE_FLEET_NODE", "CBTE_FLEET_EPOCH"}
STATUS_FIELDS = {"RECOVERY_CONTROLLER_URL", "RECOVERY_CONTROLLER_TOKEN"}
PRESERVE_RECOVERY = {
    "core": STATUS_FIELDS | {"RECOVERY_INTENT_TOKEN", "RECOVERY_NODE"},
    "bot": STATUS_FIELDS | FLEET_FIELDS,
    "analysis": FLEET_FIELDS,
    "reports": FLEET_FIELDS,
    "executor": set(),
}


class ConfigurationError(Exception):
    pass


def read_environment(path):
    if path.is_symlink():
        raise ConfigurationError("Refusing a symbolic-link environment file")
    if not path.exists():
        return {}
    if not path.is_file() or path.stat().st_size > 256 * 1024:
        raise ConfigurationError("Existing environment file has an invalid type or size")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, raw = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            raise ConfigurationError("Existing environment assignments are invalid or duplicated")
        try:
            parts = shlex.split(raw, comments=False, posix=True)
        except ValueError:
            raise ConfigurationError("Existing environment quoting is invalid") from None
        if len(parts) > 1:
            raise ConfigurationError("Existing environment values containing spaces must be quoted")
        values[key] = parts[0] if parts else ""
    return values


def environment_text(values):
    lines = []
    for key, raw in sorted(values.items()):
        value = str(raw)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or any(char in value for char in "\r\n\0"):
            raise ConfigurationError("Environment values contain unsupported control characters")
        # systemd EnvironmentFile and shlex preserve these values; never source
        # the resulting files as shell programs.
        value = value.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(key + '="' + value + '"\n')
    return "".join(lines)


def atomic_private(path, content):
    if path.is_symlink() or path.parent.is_symlink() or (path.exists() and not path.is_file()):
        raise ConfigurationError("Refusing an unexpected configuration output path")
    temporary = path.with_name("." + path.name + "." + secrets.token_hex(8) + ".tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        if os.name == "posix":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def hash_password(binary, password):
    try:
        result = subprocess.run([str(binary), "password-hash"], input=(password + "\n").encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ConfigurationError("Password hasher could not complete") from None
    value = result.stdout.decode("utf-8", "replace").strip()
    if result.returncode or not re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", value):
        raise ConfigurationError("Password hasher returned an invalid result")
    return value


def write_configuration(source, revision, directory, account, binary=pathlib.Path("/opt/cbte-admin/current/cbte-admin")):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ConfigurationError("Invalid release revision")
    if type(account.pw_gid) is not int or not 1 <= account.pw_gid <= 2147483647:
        raise ConfigurationError("cbte-admin must have a numeric nonzero group ID")
    if directory.is_symlink():
        raise ConfigurationError("Refusing a symbolic-link configuration directory")
    directory.mkdir(mode=0o700, exist_ok=True)
    config = json.loads((source / "config.json").read_text(encoding="utf-8"))
    if not isinstance(config, dict) or not isinstance(config.get("dashboard") or {}, dict):
        raise ConfigurationError("Production configuration must contain valid objects")
    dashboard = config.get("dashboard") or {}
    all_existing = {name: read_environment(directory / (name + ".env")) for name in PRESERVE_RECOVERY}
    existing = all_existing["core"]
    token = existing.get("ADMIN_AGENT_TOKEN") or secrets.token_hex(32)
    public = dashboard.get("publicBaseUrl", "https://cbte.sprink.cloud").rstrip("/")
    origin = urlsplit(public)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path:
        raise ConfigurationError("Production management URL must be a fixed HTTPS origin")
    owner = OWNER
    if len(token) < 32:
        raise ConfigurationError("Existing management token is too short")
    client_id = dashboard.get("clientId") or config.get("clientId") or ""
    client_secret = dashboard.get("clientSecret") or config.get("clientSecret") or ""
    if not isinstance(client_id, str) or not re.fullmatch(r"[0-9]{17,20}", client_id) or not isinstance(client_secret, str) or len(client_secret) < 16:
        raise ConfigurationError("Production Discord OAuth credentials are missing or invalid")
    password_hash = existing.get("ADMIN_AGENT_PASSWORD_HASH", "")
    if not password_hash:
        bootstrap = directory / "bootstrap-password"
        if bootstrap.is_symlink():
            raise ConfigurationError("Refusing a symbolic-link bootstrap password")
        if bootstrap.exists():
            password = bootstrap.read_text(encoding="utf-8").strip()
            if not 14 <= len(password.encode()) <= 72 or any(c in password for c in "\r\n\0"):
                raise ConfigurationError("Stored bootstrap password is invalid")
        else:
            password = secrets.token_urlsafe(24)
            atomic_private(bootstrap, password + "\n")
        password_hash = hash_password(binary, password)
    elif not re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", password_hash):
        raise ConfigurationError("Stored administrator password hash is invalid")
    shared = "/var/lib/cbte-admin-shared"
    common = {
        "ADMIN_AGENT_TOKEN": token, "ADMIN_OWNER_ID": owner, "BOT_BUILD_REVISION": revision,
        "ADMIN_ALLOWED_USER_IDS": ADMINS, "DASHBOARD_ADMIN_USER_IDS": ADMINS,
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
        "ADMIN_DISCORD_CLIENT_ID": client_id, "ADMIN_DISCORD_CLIENT_SECRET": client_secret,
        "ADMIN_DISCORD_REDIRECT_URI": public + "/ops/auth/discord/callback",
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
        "ADMIN_SAVE_CONTROL_GID": str(account.pw_gid),
        "ADMIN_ANALYSIS_STATE_DIR": "/var/lib/cbte-admin-analysis",
        "SAVES_DIR": "/var/lib/cbte-admin-analysis/saves", "ADMIN_WORKER_DEADLINE_MS": "110000",
    }
    reports = {
        **common, "ADMIN_ANALYSIS_LISTEN": "127.0.0.1:30991",
        "ADMIN_ANALYSIS_STATE_DIR": "/var/lib/cbte-admin-reports", "ADMIN_ANALYSIS_ACTIONS": "reports.build",
        "ADMIN_WORKER_DEADLINE_MS": "640000", "DASHBOARD_REPORT_QUERY_TIMEOUT_MS": "120000",
        "DASHBOARD_DB_CONNECTION_LIMIT": "16",
    }
    executor = {
        "ADMIN_AGENT_EXECUTOR_SOCKET": "/run/cbte-admin-executor/executor.sock",
        "ADMIN_AGENT_EXECUTOR_STATE_DIR": "/var/lib/cbte-admin-executor",
        "ADMIN_AGENT_EXECUTOR_ALLOWED_UID": str(account.pw_uid),
        "ADMIN_AGENT_EXECUTOR_GROUP_GID": str(account.pw_gid), "ADMIN_AGENT_BOT_UNIT": "cbte.service",
    }
    bot = {
        "ADMIN_AGENT_TOKEN": token, "ADMIN_OWNER_ID": owner, "ADMIN_AGENT_URL": "http://127.0.0.1:30988",
        "ADMIN_ALLOWED_USER_IDS": ADMINS, "DASHBOARD_ADMIN_USER_IDS": ADMINS,
        "ADMIN_SAVE_CONTROL_GID": str(account.pw_gid),
        "ADMIN_AGENT_PUBLIC_URL": public + "/ops/",
        "ADMIN_AGENT_EXECUTOR_SOCKET": "/run/cbte-admin-executor/executor.sock",
        "ADMIN_TELEMETRY_DIR": "/var/lib/cbte-admin-bot-spool",
        "ADMIN_PROVIDER_OVERRIDE_FILE": shared + "/provider-source-overrides.json",
        "DASHBOARD_PORT": "30989", "PORT": "30989", "BOT_BUILD_REVISION": revision, "APP_REVISION": revision,
    }
    services = {"core": core, "analysis": analysis, "reports": reports, "executor": executor, "bot": bot}
    for name, allowed in PRESERVE_RECOVERY.items():
        services[name].update({key: all_existing[name][key] for key in allowed if key in all_existing[name]})
    outputs = {directory / (name + ".env"): environment_text(values) for name, values in services.items()}
    for path in outputs:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ConfigurationError("Refusing an unexpected configuration output path")
    for path, content in outputs.items():
        atomic_private(path, content)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Expected primary source path and release revision")
    source = pathlib.Path(sys.argv[1]).resolve()
    revision = sys.argv[2]
    if source != pathlib.Path("/root/comebacktwitterembed") or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit("Unexpected release source or revision")
    if os.name != "posix" or os.geteuid() != 0:
        raise SystemExit("Primary configuration generation requires root")
    import pwd
    try:
        write_configuration(source, revision, pathlib.Path("/etc/cbte-admin"), pwd.getpwnam("cbte-admin"))
    except Exception:
        raise SystemExit("Primary configuration generation failed; inspect protected input files and permissions locally") from None
    print("Wrote protected primary configuration. Preserved configured recovery integration.")


if __name__ == "__main__":
    main()
