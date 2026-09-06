#!/usr/bin/env python3
"""Prepare protected OCI runtime files without arming or starting recovery.

Existing authority/controller configuration supplies the role and NAS tokens.
Generated management credentials and bootstrap passwords survive repeated runs.
No credential values or subprocess output are printed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess

OWNER = "796972193287503913"
ADMINS = "933314562487386122,796972193287503913"
PUBLIC_URL = "https://cbte.sprink.cloud"
MANAGEMENT_URL = "https://cbte-recovery.sprink.cloud/ops/"
NAS_RECIPIENT = "age1l8y4rcpcrnmh958848vyjy8vqv8cpscjrdg5hnkns8rj9lq24sasxlgmqf"
STATE = Path("/var/lib/cbte-recovery")
LEASE = "/run/cbte-recovery/oci-lease.json"


class ConfigurationError(Exception):
    pass


def physical(path, *, directory=False, private=False):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise ConfigurationError("Configured filesystem paths must be physical absolute paths.")
    for ancestor in [*reversed(path.parents), path]:
        info = ancestor.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ConfigurationError("Configuration paths may not contain symbolic links.")
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ConfigurationError("A configured path has an unexpected file type.")
    if os.name == "posix":
        permitted = 0o700 if directory else 0o600
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ConfigurationError("Configuration inputs must be root-owned and not writable by other users.")
        if private and stat.S_IMODE(info.st_mode) != permitted:
            raise ConfigurationError("Private configuration must use directory 0700 or file 0600 permissions.")
    return path


def read_json(path):
    path = physical(path, private=True)
    if path.stat().st_size > 1024 * 1024:
        raise ConfigurationError("Configuration JSON exceeds its size limit.")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ConfigurationError("Configuration JSON must be an object.")
    return value


def read_env(path):
    if not path.exists() and not path.is_symlink():
        return {}
    path = physical(path, private=True)
    if path.stat().st_size > 256 * 1024:
        raise ConfigurationError("Environment file exceeds its size limit.")
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            raise ConfigurationError("Existing environment assignments are invalid or duplicated.")
        parts = shlex.split(value, comments=False, posix=True)
        if len(parts) > 1:
            raise ConfigurationError("Environment values containing spaces must be quoted.")
        values[key] = parts[0] if parts else ""
    return values


def env_text(values):
    lines = []
    for key, raw in sorted(values.items()):
        value = str(raw)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or any(char in value for char in "\r\n\x00"):
            raise ConfigurationError("Environment values contain unsupported control characters.")
        # Double-quoted syntax is shared by systemd EnvironmentFile and the
        # workload's shlex parser. Never source these files through a shell.
        value = value.replace("\\", "\\\\").replace('"', '\\"')
        lines.append(key + '="' + value + '"\n')
    return "".join(lines)


def atomic_private(path, content):
    physical(path.parent, directory=True, private=True)
    if path.exists() or path.is_symlink():
        physical(path, private=True)
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


def role_token(value):
    if not isinstance(value, str) or len(value) < 32 or any(char in value for char in "\r\n\x00"):
        raise ConfigurationError("A required existing role token is missing or invalid.")
    return value


def preserved_value(environments, key):
    values = {environment[key] for environment in environments.values() if environment.get(key)}
    if len(values) > 1:
        raise ConfigurationError("Existing service credentials disagree; no files were rewritten.")
    return next(iter(values), "")


def password_hash(binary, password):
    try:
        result = subprocess.run([str(binary), "password-hash"], input=(password + "\n").encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ConfigurationError("The management password hasher could not complete.") from None
    value = result.stdout.decode("utf-8", "replace").strip()
    if result.returncode != 0 or not re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", value):
        raise ConfigurationError("The management password hasher returned an invalid result.")
    return value


def configure(release_dir, node, admin_binary, config_dir):
    release = physical(release_dir, directory=True)
    node = physical(node)
    binary = physical(admin_binary)
    directory = physical(config_dir, directory=True, private=True)
    authority = read_json(directory / "authority.json")
    controller = read_json(directory / "controller.json")
    production = read_json(directory / "bot-config.json")
    tokens = authority.get("tokens", {})
    if not isinstance(tokens, dict) or set(tokens) != {"primary", "oci", "controller"}:
        raise ConfigurationError("Authority configuration must contain three distinct role tokens.")
    roles = {name: role_token(value) for name, value in tokens.items()}
    if len(set(roles.values())) != 3:
        raise ConfigurationError("Authority role tokens must be distinct.")
    status_token = role_token(controller.get("statusToken"))
    exporter_token = role_token(controller.get("exporterToken"))
    if controller.get("authorityControllerToken") != roles["controller"]:
        raise ConfigurationError("Controller and authority role credentials disagree.")
    if controller.get("authorityUrl", "http://127.0.0.1:34210").rstrip("/") != "http://127.0.0.1:34210":
        raise ConfigurationError("The OCI authority must use the fixed local endpoint.")
    if controller.get("exporterUrl", "http://127.0.0.1:33443").rstrip("/") != "http://127.0.0.1:33443":
        raise ConfigurationError("NAS exporter must use the fixed local tunnel.")
    state_dir = Path(controller.get("stateDir", str(STATE / "controller")))
    candidate_root = Path(controller.get("candidateRoot", str(STATE / "candidates")))
    for path in [state_dir, candidate_root]:
        if not path.is_absolute() or ".." in path.parts or path == Path(path.anchor):
            raise ConfigurationError("Controller state paths must be absolute non-root paths.")
    dashboard = production.get("dashboard") or {}
    if not isinstance(dashboard, dict):
        raise ConfigurationError("Production dashboard configuration is invalid.")
    client_id = dashboard.get("clientId") or production.get("clientId")
    client_secret = dashboard.get("clientSecret") or production.get("clientSecret")
    if not isinstance(client_id, str) or not re.fullmatch(r"[0-9]{17,20}", client_id) or not isinstance(client_secret, str) or len(client_secret) < 16:
        raise ConfigurationError("Production Discord OAuth client credentials are missing or invalid.")
    admin = directory / "admin"
    admin.mkdir(mode=0o700, exist_ok=True)
    physical(admin, directory=True, private=True)
    existing = {name: read_env(admin / (name + ".env")) for name in ["common", "core", "analysis", "reports", "bot"]}
    management_token = preserved_value(existing, "ADMIN_AGENT_TOKEN") or secrets.token_hex(32)
    role_token(management_token)
    saved_hash = preserved_value(existing, "ADMIN_AGENT_PASSWORD_HASH")
    bootstrap = directory / "bootstrap-password"
    bootstrap_text = None
    if not saved_hash:
        if bootstrap.exists() or bootstrap.is_symlink():
            physical(bootstrap, private=True)
            password = bootstrap.read_text(encoding="utf-8").strip()
            if not 14 <= len(password.encode()) <= 72 or any(char in password for char in "\r\n\x00"):
                raise ConfigurationError("Stored bootstrap password is invalid.")
        else:
            password = secrets.token_urlsafe(32)
            bootstrap_text = password + "\n"
        saved_hash = password_hash(binary, password)
    elif not re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", saved_hash):
        raise ConfigurationError("Stored administrator password hash is invalid.")
    next_auth = preserved_value(existing, "NEXTAUTH_SECRET") or dashboard.get("nextAuthSecret") or production.get("nextAuthSecret") or secrets.token_hex(32)
    if not isinstance(next_auth, str) or len(next_auth) < 16:
        raise ConfigurationError("NextAuth session secret is missing or invalid.")
    candidate_pointer = str(state_dir / "active-candidate.json")
    authority_url = "http://127.0.0.1:34210"
    workload = {"candidatePointer": candidate_pointer, "candidateRoot": str(candidate_root), "releaseDir": str(release),
        "nodePath": str(node), "botConfigPath": str(directory / "bot-config.json"), "authorityUrl": authority_url,
        "authorityToken": roles["oci"], "leaseFile": LEASE, "adminBinary": str(binary), "adminConfigDir": str(admin),
        "publicUrl": PUBLIC_URL, "runtimeRoot": str(STATE / "workload"), "externalAdminCore": True,
        "publicMediaLink": str(STATE / "public-saves-current")}
    guardian = {"authorityUrl": authority_url, "node": "oci", "token": roles["oci"],
        "command": ["/usr/bin/python3", "/opt/cbte-recovery/start_workload.py", "--config", str(directory / "workload.json")],
        "leaseFile": LEASE, "workingDirectory": str(release), "systemdUnit": "cbte-recovery-workload.service", "companionUnits": []}
    routing = {"cloudflared": "/opt/cbte-recovery/cloudflared", "originCertificate": str(directory / "cloudflare-origin-cert.pem"),
        "tunnelId": "30451f0b-c6dd-46db-9ab4-ab82b8f757ba", "hostnames": ["cbte.sprink.cloud", "twidata.sprink.cloud"],
        "stateDir": str(STATE / "routing"), "authorityUrl": authority_url, "authorityToken": roles["oci"], "leaseFile": LEASE}
    backup = {"candidatePointer": candidate_pointer, "candidateRoot": str(candidate_root), "leaseFile": LEASE,
        "authorityUrl": authority_url, "authorityToken": roles["oci"], "nasUrl": "http://127.0.0.1:33443",
        "nasToken": exporter_token, "nasRecipient": NAS_RECIPIENT, "spoolRoot": str(STATE / "active-backups")}
    common = {"ADMIN_AGENT_TOKEN": management_token, "ADMIN_OWNER_ID": OWNER, "ADMIN_ALLOWED_USER_IDS": ADMINS,
        "DASHBOARD_ADMIN_USER_IDS": ADMINS, "ADMIN_AGENT_URL": "http://127.0.0.1:30988", "NODE_ENV": "production",
        "ADMIN_AGENT_WORKER": str(release / "src/adminSupport/worker.js"), "ADMIN_AGENT_WORKER_DIR": str(release),
        "ADMIN_AGENT_NODE": str(node), "ADMIN_AGENT_PUBLIC_URL": MANAGEMENT_URL, "ADMIN_AGENT_BASE_PATH": "/ops",
        "ADMIN_AGENT_BOT_UNIT": "cbte-recovery-workload.service", "BOT_BUILD_REVISION": release.name, "APP_REVISION": release.name}
    core = common | {"ADMIN_AGENT_LISTEN": "127.0.0.1:30988", "ADMIN_AGENT_STATE_DIR": str(STATE / "management"),
        "ADMIN_AGENT_PASSWORD_HASH": saved_hash, "ADMIN_AGENT_COOKIE_SECURE": "true",
        "ADMIN_AGENT_WORKER_URL": "http://127.0.0.1:30990/execute", "ADMIN_AGENT_REPORT_WORKER_URL": "http://127.0.0.1:30991/execute",
        "ADMIN_AGENT_WORKER_TIMEOUT_SECONDS": "120", "ADMIN_AGENT_REPORT_TIMEOUT_SECONDS": "900",
        "ADMIN_AGENT_LOCAL_HEALTH_URL": "http://127.0.0.1:30989/api/health", "ADMIN_AGENT_PUBLIC_HEALTH_URL": PUBLIC_URL + "/api/health",
        "ADMIN_DISCORD_CLIENT_ID": client_id, "ADMIN_DISCORD_CLIENT_SECRET": client_secret,
        "ADMIN_DISCORD_REDIRECT_URI": MANAGEMENT_URL + "auth/discord/callback", "ADMIN_AGENT_EXECUTOR_SOCKET": "",
        "RECOVERY_CONTROLLER_URL": "http://127.0.0.1:34212", "RECOVERY_CONTROLLER_TOKEN": status_token,
        "ADMIN_AGENT_DISCORD_WEBHOOK": "", "ADMIN_AGENT_PUSH_WEBHOOK": ""}
    if controller.get("ociIntentToken"):
        core.update(RECOVERY_INTENT_TOKEN=role_token(controller["ociIntentToken"]), RECOVERY_NODE="oci")
    analysis = common | {"ADMIN_ANALYSIS_LISTEN": "127.0.0.1:30990", "ADMIN_ANALYSIS_STATE_DIR": str(STATE / "workload/interactive"),
        "ADMIN_WORKER_DEADLINE_MS": "110000", "ADMIN_TELEMETRY_ENABLED": "0"}
    reports = common | {"ADMIN_ANALYSIS_LISTEN": "127.0.0.1:30991", "ADMIN_ANALYSIS_STATE_DIR": str(STATE / "workload/reports"),
        "ADMIN_ANALYSIS_ACTIONS": "reports.build", "ADMIN_WORKER_DEADLINE_MS": "780000", "DASHBOARD_REPORT_QUERY_TIMEOUT_MS": "120000",
        "DASHBOARD_DB_CONNECTION_LIMIT": "8", "ADMIN_TELEMETRY_ENABLED": "0"}
    bot = common | {"NEXTAUTH_SECRET": next_auth, "DISCORD_CLIENT_ID": client_id, "DISCORD_CLIENT_SECRET": client_secret,
        "RECOVERY_CONTROLLER_URL": "http://127.0.0.1:34212", "RECOVERY_CONTROLLER_TOKEN": status_token,
        "NEXTAUTH_URL": PUBLIC_URL, "DASHBOARD_BASE_URL": PUBLIC_URL, "DASHBOARD_PORT": "30989", "PORT": "30989",
        "DASHBOARD_INTEGRATED_MEDIA_SERVER": "true", "MEDIA_DELIVERY_PUBLIC_BASE_URL": PUBLIC_URL, "CBTE_RECOVERY_SAVEDATA_MIGRATED": "false"}
    outputs = {directory / (name + ".json"): json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
               for name, value in [("workload", workload), ("oci-guardian", guardian), ("routing", routing), ("active-backup", backup)]}
    outputs.update({admin / (name + ".env"): env_text(value) for name, value in [("common", common), ("core", core), ("analysis", analysis), ("reports", reports), ("bot", bot)]})
    if bootstrap_text is not None:
        outputs = {bootstrap: bootstrap_text} | outputs
    # Validate every destination before any replacements. A failed operation can
    # safely be rerun: password bootstrap and previously generated token persist.
    for path in outputs:
        if path.exists() or path.is_symlink():
            physical(path, private=True)
    for path, content in outputs.items():
        atomic_private(path, content)
    return len(outputs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-dir", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--admin-binary", required=True)
    parser.add_argument("--config-dir", default="/etc/cbte-recovery")
    args = parser.parse_args()
    if os.name == "posix" and os.geteuid() != 0:
        parser.exit(1, "Configuration generation requires root.\n")
    try:
        count = configure(args.release_dir, args.node, args.admin_binary, args.config_dir)
    except Exception:
        # Exceptions can contain fragments of JSON, subprocess output, or values
        # supplied through configuration. Keep CLI failures free of credentials.
        parser.exit(1, "OCI configuration generation failed; protected inputs or output paths must be checked locally.\n")
    print(f"Prepared {count} protected OCI configuration files. Recovery activation settings were not changed.")


if __name__ == "__main__":
    main()
