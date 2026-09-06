import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from recovery.user_notifications import NotificationError, send


class UserNotificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.config = self.root / "webhook.json"
        self.state = self.root / "state.json"
        self.config.write_text(json.dumps({
            "webhookUrl": "https://discord.com/api/webhooks/123/token",
            "name": "ComebackTwitterEmbed お知らせ",
            "avatarUrl": "https://cdn.discordapp.com/avatars/1/hash.png",
            "statePath": str(self.state),
        }), encoding="utf-8")
        os.chmod(self.config, 0o600)

    def tearDown(self):
        self.directory.cleanup()

    def test_all_four_stages_have_user_facing_templates(self):
        for stage in ("failover-start", "standby-active", "failback-start", "primary-active"):
            result = send(str(self.config), stage, 3, "operation-12345678", dry_run=True)
            self.assertEqual(result["status"], "dry_run")
            self.assertNotIn("管理画面", json.dumps(result, ensure_ascii=False))
            self.assertNotIn("OCI", json.dumps(result, ensure_ascii=False))
            self.assertNotIn("Captenhook", json.dumps(result, ensure_ascii=False))

    def test_accepted_notice_is_idempotent(self):
        response = mock.Mock(status=204)
        response.read.return_value = b""
        response.__enter__ = lambda value: response
        response.__exit__ = lambda *args: None
        with mock.patch("recovery.user_notifications.urllib.request.urlopen", return_value=response) as request:
            first = send(str(self.config), "standby-active", 3, "operation-12345678")
            second = send(str(self.config), "standby-active", 3, "operation-12345678")
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(request.call_count, 1)

    def test_rejected_delivery_does_not_mark_accepted(self):
        response = mock.Mock(status=500)
        response.read.return_value = b"rejected"
        response.__enter__ = lambda value: response
        response.__exit__ = lambda *args: None
        with mock.patch("recovery.user_notifications.urllib.request.urlopen", return_value=response):
            with self.assertRaises(NotificationError):
                send(str(self.config), "failover-start", 3, "operation-12345678")
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
