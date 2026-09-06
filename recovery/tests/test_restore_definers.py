import copy
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

from recovery import restore_definers as definers


def encoded(rows):
    return "\n".join(json.dumps(row).encode().hex() for row in rows)


class FakeMySQL:
    def __init__(self):
        self.triggers = list(copy.deepcopy(definers.expected_triggers()).values())
        self.objects = []
        self.exists = False
        self.locked = "Y"
        self.privileges = set()
        self.extra_privileges = []
        self.roles = []
        self.dynamic = []
        self.proxies = []
        self.mutations = []

    def __call__(self, sql):
        if sql.startswith("/*cbte-definer:triggers*/"):
            return encoded(self.triggers)
        if sql.startswith("/*cbte-definer:other-objects*/"):
            return encoded(self.objects)
        if sql.startswith("/*cbte-definer:account*/"):
            return encoded([{"user": definers.USER, "host": definers.HOST, "locked": self.locked}] if self.exists else [])
        if sql.startswith("/*cbte-definer:privileges*/"):
            return encoded([{"scope": "table", "schema": definers.SCHEMA, "table": table, "privilege": permission, "grantable": "NO"} for table, permission in self.privileges] + self.extra_privileges)
        if sql.startswith("/*cbte-definer:roles*/"):
            return encoded(self.roles)
        if sql.startswith("/*cbte-definer:dynamic-grants*/"):
            return encoded(self.dynamic)
        if sql.startswith("/*cbte-definer:proxy-grants*/"):
            return encoded(self.proxies)
        self.mutations.append(sql)
        if sql.startswith("CREATE USER "):
            if " ACCOUNT LOCK;" not in sql or self.exists:
                raise AssertionError("Unsafe account creation")
            self.exists = True
            return ""
        match = re.fullmatch(r"GRANT ([A-Z, ]+) ON `([^`]+)`\.`([^`]+)` TO '([^']+)'@'localhost';", sql)
        if not match or match[2] != definers.SCHEMA or match[4] != definers.USER or not self.exists:
            raise AssertionError("Unexpected privilege statement")
        self.privileges.update((match[3], permission.strip()) for permission in match[1].split(','))
        return ""


class DefinerTests(unittest.TestCase):
    def test_only_known_locked_account_and_exact_counter_privileges_are_created(self):
        mysql = FakeMySQL()
        result = definers.ensure_restore_definers(mysql)
        self.assertTrue(result["verified"])
        self.assertTrue(result["accountCreated"])
        self.assertTrue(result["accountLocked"])
        self.assertEqual(result["triggerCount"], 17)
        self.assertEqual(mysql.privileges, definers.required_privileges())
        self.assertEqual(len(mysql.privileges), 14)
        self.assertEqual(len([sql for sql in mysql.mutations if sql.startswith("CREATE USER")]), 1)
        self.assertFalse(any("*.*" in sql or "ALL PRIVILEGES" in sql or "GRANT OPTION" in sql or "ALTER USER" in sql for sql in mysql.mutations))
        count = len(mysql.mutations)
        again = definers.ensure_restore_definers(mysql)
        self.assertFalse(again["accountCreated"])
        self.assertEqual(len(mysql.mutations), count)

    def test_unknown_modified_missing_or_additional_objects_block_before_any_grant(self):
        for mode in ["missing", "body", "literal_case", "literal_backticks", "definer", "extra_trigger", "routine", "view", "event"]:
            with self.subTest(mode=mode):
                mysql = FakeMySQL()
                if mode == "missing": mysql.triggers.pop()
                if mode == "body": mysql.triggers[0]["statement"] = "DELETE FROM users"
                if mode == "literal_case": mysql.triggers[0]["statement"] = mysql.triggers[0]["statement"].replace("'bot_error_events'", "'BOT_ERROR_EVENTS'")
                if mode == "literal_backticks": mysql.triggers[0]["statement"] = mysql.triggers[0]["statement"].replace("'bot_error_events'", "'`bot_error_events`'")
                if mode == "definer": mysql.triggers[0]["definer"] = "unexpected@localhost"
                if mode == "extra_trigger": mysql.triggers.append(dict(mysql.triggers[0], name="unknown_trigger"))
                if mode in {"routine", "view", "event"}: mysql.objects.append({"kind": mode, "name": "unknown", "definer": definers.USER + "@" + definers.HOST})
                with self.assertRaises(definers.DefinerRepairError): definers.ensure_restore_definers(mysql)
                self.assertEqual(mysql.mutations, [])

    def test_existing_unlocked_broad_or_role_granted_account_is_not_modified(self):
        for mode in ["unlocked", "global", "dynamic_global", "proxy", "schema", "unknown_table", "grant_option", "role"]:
            with self.subTest(mode=mode):
                mysql = FakeMySQL(); mysql.exists = True
                if mode == "unlocked": mysql.locked = "N"
                if mode == "global": mysql.extra_privileges = [{"scope": "global", "privilege": "SUPER", "grantable": "NO"}]
                if mode == "schema": mysql.extra_privileges = [{"scope": "schema", "schema": definers.SCHEMA, "privilege": "SELECT", "grantable": "NO"}]
                if mode == "unknown_table": mysql.privileges.add(("users", "DELETE"))
                if mode == "grant_option": mysql.extra_privileges = [{"scope": "table", "schema": definers.SCHEMA, "table": "bot_table_count_deltas", "privilege": "INSERT", "grantable": "YES"}]
                if mode == "role": mysql.roles = [{"role": "broad-role", "host": "%"}]
                if mode == "dynamic_global": mysql.dynamic = [{"privilege": "BACKUP_ADMIN"}]
                if mode == "proxy": mysql.proxies = [{"proxiedUser": "root", "proxiedHost": "localhost"}]
                with self.assertRaises(definers.DefinerRepairError): definers.ensure_restore_definers(mysql)
                self.assertEqual(mysql.mutations, [])

    def test_partial_locked_account_can_finish_only_missing_allowed_grants(self):
        mysql = FakeMySQL(); mysql.exists = True
        mysql.privileges = {("bot_table_count_deltas", "SELECT")}
        result = definers.ensure_restore_definers(mysql)
        self.assertFalse(result["accountCreated"])
        self.assertEqual(mysql.privileges, definers.required_privileges())
        self.assertTrue(all(sql.startswith("GRANT ") for sql in mysql.mutations))

    def test_password_is_not_exposed_when_create_user_fails(self):
        mysql = FakeMySQL()
        def fail(sql):
            if sql.startswith("CREATE USER"):
                raise RuntimeError("secret SQL: " + sql)
            return mysql(sql)
        with self.assertRaises(definers.DefinerRepairError) as caught:
            definers.ensure_restore_definers(fail)
        self.assertNotIn("IDENTIFIED", str(caught.exception))
        self.assertNotIn("secret SQL", str(caught.exception))

    def test_no_stored_objects_creates_no_unneeded_account(self):
        mysql = FakeMySQL(); mysql.triggers = []
        self.assertEqual(definers.ensure_restore_definers(mysql)["state"], "no_stored_objects")
        self.assertEqual(mysql.mutations, [])

    @unittest.skipUnless(shutil.which("node"), "Node is required for source definition equivalence")
    def test_python_allowlist_matches_the_repository_counter_trigger_definitions(self):
        repository = Path(__file__).resolve().parents[2]
        script = "const c=require('./src/tableCounts');console.log(JSON.stringify(c.TABLES.flatMap(t=>c.triggerDefinitions(t.table))))"
        actual = json.loads(subprocess.check_output([shutil.which("node"), "-e", script], cwd=repository, text=True, timeout=10))
        expected = definers.expected_triggers()
        self.assertEqual({row["name"] for row in actual}, set(expected))
        for row in actual:
            with self.subTest(name=row["name"]):
                value = expected[row["name"]]
                self.assertEqual([row[key] for key in ["table", "event", "timing"]], [value[key] for key in ["table", "event", "timing"]])
                self.assertEqual(definers.canonical(row["body"]), definers.canonical(value["statement"]))


if __name__ == "__main__":
    unittest.main()
