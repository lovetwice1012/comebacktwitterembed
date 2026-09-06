"""Validate known CBTE count triggers and prepare their locked definer.

The database and account are fixed deployment policy, never request/config
parameters. No unknown stored object or broader privilege is adopted.
"""
from __future__ import annotations
import hashlib
import json
import re
import secrets

SCHEMA = "ComebackTwitterEmbed"
USER = "debian-sys-maint"
HOST = "localhost"
TABLES = (
    ("bot_error_events", "errors"), ("bot_error_buckets", "error_buckets"),
    ("bot_metric_buckets", "metrics"), ("bot_analytics_events", "analytics"),
    ("bot_provider_content_events", "content"), ("bot_provider_content_facets", "facets"),
    ("bot_provider_hourly_aggregates", "hourly"), ("bot_provider_hourly_unique_keys", "unique_keys"),
)


class DefinerRepairError(Exception):
    pass


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def identifier(value):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", value):
        raise DefinerRepairError("Invalid fixed definer policy identifier")
    return "`" + value + "`"


def canonical(sql):
    # Keep literal contents and case intact: changing a table_name string can
    # silently redirect deltas under the counter table's ascii_bin collation.
    parts = re.split(r"('(?:''|[^'])*')", sql)
    return "".join(part if index % 2 else re.sub(r"\s+", " ", part.replace("`", "")) for index, part in enumerate(parts)).strip()


def expected_triggers():
    result = {}
    for table, alias in TABLES:
        for event, suffix, sign, delta in [("INSERT", "ai", "+", 1), ("DELETE", "ad", "-", -1)]:
            name = f"cbte_tc_{alias}_{suffix}_v1"
            result[name] = {"name": name, "table": table, "event": event, "timing": "AFTER", "definer": USER + "@" + HOST,
                "statement": f"INSERT INTO bot_table_count_deltas (table_name, shard_id, delta) VALUES ('{table}', MOD(CONNECTION_ID(), 16), {delta}) ON DUPLICATE KEY UPDATE delta = delta {sign} 1"}
    result["cbte_tc_content_bd_v1"] = {"name": "cbte_tc_content_bd_v1", "table": "bot_provider_content_events", "event": "DELETE", "timing": "BEFORE", "definer": USER + "@" + HOST,
        "statement": "DELETE FROM bot_provider_content_facets WHERE content_event_id = OLD.content_event_id"}
    return result


def required_privileges():
    result = {(table, "TRIGGER") for table, _ in TABLES}
    result |= {("bot_table_count_deltas", privilege) for privilege in ("SELECT", "INSERT", "UPDATE")}
    result |= {("bot_provider_content_events", "SELECT"), ("bot_provider_content_facets", "SELECT"), ("bot_provider_content_facets", "DELETE")}
    return result


def execute(mysql, sql, stage):
    try:
        return mysql(sql)
    except Exception:
        # A failed CREATE USER parser may echo the generated password. Never
        # propagate SQL/stdout/stderr into a restore receipt or notification.
        raise DefinerRepairError("Locked definer " + stage + " failed; isolated candidate must remain unvalidated") from None


def rows(mysql, sql, stage):
    result = execute(mysql, sql, stage)
    try:
        if len(result) > 1024 * 1024:
            raise ValueError("Metadata exceeds its bound")
        decoded = [json.loads(bytes.fromhex(line.strip()).decode("utf-8")) for line in result.splitlines() if line.strip()]
        if any(not isinstance(row, dict) for row in decoded):
            raise ValueError("Not an object")
        return decoded
    except Exception:
        raise DefinerRepairError("Locked definer metadata response is invalid") from None


def inventory(mysql):
    schema = literal(SCHEMA)
    triggers = rows(mysql, "/*cbte-definer:triggers*/ SELECT HEX(JSON_OBJECT('name',TRIGGER_NAME,'table',EVENT_OBJECT_TABLE,'event',EVENT_MANIPULATION,'timing',ACTION_TIMING,'definer',DEFINER,'statement',IF(CHAR_LENGTH(ACTION_STATEMENT)<=8192,ACTION_STATEMENT,NULL))) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=" + schema + " ORDER BY TRIGGER_NAME LIMIT 18;", "trigger inventory")
    objects = rows(mysql, "/*cbte-definer:other-objects*/ SELECT HEX(JSON_OBJECT('kind','routine','name',ROUTINE_NAME,'definer',DEFINER)) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=" + schema + " UNION ALL SELECT HEX(JSON_OBJECT('kind','event','name',EVENT_NAME,'definer',DEFINER)) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=" + schema + " UNION ALL SELECT HEX(JSON_OBJECT('kind','view','name',TABLE_NAME,'definer',DEFINER)) FROM information_schema.VIEWS WHERE TABLE_SCHEMA=" + schema + " LIMIT 1;", "stored object inventory")
    if objects:
        raise DefinerRepairError("Unexpected routine, event, or view prevents automatic definer adoption")
    if not triggers:
        return []
    expected = expected_triggers()
    if len(triggers) != len(expected) or {item.get("name") for item in triggers} != set(expected):
        raise DefinerRepairError("Restored counter trigger set is incomplete or contains an unknown trigger")
    for item in triggers:
        match = expected[item["name"]]
        if any(item.get(key) != match[key] for key in ("table", "event", "timing", "definer")) or not isinstance(item.get("statement"), str) or canonical(item["statement"]) != canonical(match["statement"]):
            raise DefinerRepairError("Restored counter trigger definition differs from the fixed allowlist: " + item["name"])
    return triggers


def account_state(mysql):
    found = rows(mysql, "/*cbte-definer:account*/ SELECT HEX(JSON_OBJECT('user',User,'host',Host,'locked',account_locked)) FROM mysql.user WHERE User=" + literal(USER) + " AND Host=" + literal(HOST) + " LIMIT 2;", "account inspection")
    if len(found) > 1 or found and (found[0].get("user") != USER or found[0].get("host") != HOST or found[0].get("locked") != "Y"):
        raise DefinerRepairError("Existing definer account is not the expected locked account; automatic changes refused")
    return bool(found)


def current_privileges(mysql):
    grantee = literal("'" + USER + "'@'" + HOST + "'")
    records = rows(mysql, "/*cbte-definer:privileges*/ SELECT HEX(JSON_OBJECT('scope','global','privilege',PRIVILEGE_TYPE,'grantable',IS_GRANTABLE)) FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=" + grantee + " UNION ALL SELECT HEX(JSON_OBJECT('scope','schema','schema',TABLE_SCHEMA,'privilege',PRIVILEGE_TYPE,'grantable',IS_GRANTABLE)) FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE=" + grantee + " UNION ALL SELECT HEX(JSON_OBJECT('scope','table','schema',TABLE_SCHEMA,'table',TABLE_NAME,'privilege',PRIVILEGE_TYPE,'grantable',IS_GRANTABLE)) FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE=" + grantee + " UNION ALL SELECT HEX(JSON_OBJECT('scope','column','schema',TABLE_SCHEMA,'table',TABLE_NAME,'privilege',PRIVILEGE_TYPE,'grantable',IS_GRANTABLE)) FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE=" + grantee + ";", "privilege inspection")
    roles = rows(mysql, "/*cbte-definer:roles*/ SELECT HEX(JSON_OBJECT('role',FROM_USER,'host',FROM_HOST)) FROM mysql.role_edges WHERE TO_USER=" + literal(USER) + " AND TO_HOST=" + literal(HOST) + ";", "role inspection")
    if roles:
        raise DefinerRepairError("Definer has assigned roles; automatic privilege changes refused")
    dynamic = rows(mysql, "/*cbte-definer:dynamic-grants*/ SELECT HEX(JSON_OBJECT('privilege',PRIV)) FROM mysql.global_grants WHERE USER=" + literal(USER) + " AND HOST=" + literal(HOST) + " LIMIT 1;", "dynamic privilege inspection")
    proxies = rows(mysql, "/*cbte-definer:proxy-grants*/ SELECT HEX(JSON_OBJECT('proxiedUser',Proxied_user,'proxiedHost',Proxied_host)) FROM mysql.proxies_priv WHERE User=" + literal(USER) + " AND Host=" + literal(HOST) + " LIMIT 1;", "proxy privilege inspection")
    if dynamic or proxies:
        raise DefinerRepairError("Definer has dynamic global or proxy privileges; automatic privilege changes refused")
    allowed = required_privileges()
    actual = set()
    for row in records:
        if row.get("scope") == "global" and row.get("privilege") == "USAGE" and row.get("grantable") == "NO":
            continue
        permission = (row.get("table"), row.get("privilege"))
        if row.get("scope") != "table" or row.get("schema") != SCHEMA or row.get("grantable") != "NO" or permission not in allowed:
            raise DefinerRepairError("Definer has privileges outside the fixed counter-trigger allowlist")
        actual.add(permission)
    return actual


def ensure_restore_definers(mysql):
    identifier(SCHEMA)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", USER) or HOST != "localhost":
        raise DefinerRepairError("Invalid fixed definer account policy")
    triggers = inventory(mysql)
    if not triggers:
        return {"verified": True, "state": "no_stored_objects", "triggerCount": 0, "accountCreated": False}
    existed = account_state(mysql)
    actual = current_privileges(mysql) if existed else set()
    account = literal(USER) + "@" + literal(HOST)
    if not existed:
        password = secrets.token_hex(32)
        execute(mysql, "CREATE USER " + account + " IDENTIFIED BY " + literal(password) + " ACCOUNT LOCK;", "account creation")
        del password
    for table in sorted({table for table, _ in required_privileges()}):
        missing = sorted(privilege for candidate, privilege in required_privileges() - actual if candidate == table)
        if missing:
            execute(mysql, "GRANT " + ", ".join(missing) + " ON " + identifier(SCHEMA) + "." + identifier(table) + " TO " + account + ";", "scoped privilege grant")
    if not account_state(mysql) or current_privileges(mysql) != required_privileges():
        raise DefinerRepairError("Locked definer repair did not reach the exact required privilege set")
    digest = hashlib.sha256(json.dumps(expected_triggers(), sort_keys=True).encode()).hexdigest()
    return {"verified": True, "state": "locked_counter_definer_ready", "account": USER + "@" + HOST, "accountLocked": True,
        "accountCreated": not existed, "triggerCount": len(triggers), "definitionSha256": digest,
        "privileges": [{"table": table, "privilege": privilege} for table, privilege in sorted(required_privileges())]}
