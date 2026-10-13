import importlib.util
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('square_payment_csp', Path(__file__).resolve().parents[1] / 'configure-square-payment-csp.py')
CSP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CSP)
BASE = "default-src 'self'; script-src 'self' 'unsafe-inline' https://web.squarecdn.com; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://web.squarecdn.com; frame-src 'self' https://web.squarecdn.com; connect-src 'self' https://web.squarecdn.com https://pci-connect.squareup.com https://o160250.ingest.sentry.io; font-src 'self' data: https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net; img-src 'self' data: blob: https:; media-src 'self' blob: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; upgrade-insecure-requests"


class PaymentCspTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.configs = tuple(self.root / path.name for path in CSP.CONFIGS)
        self.map = self.root / CSP.MAP.name
        self.originals = {}
        for index, path in enumerate(self.configs):
            data = (f'# add_header Content-Security-Policy "ignored" always;\r\nserver {{\r\n  # server {index}\r\n  add_header Content-Security-Policy "{BASE}" always; # retain\r\n  add_header X-Frame-Options SAMEORIGIN always;\r\n}}\r\n').encode()
            path.write_bytes(data)
            path.chmod(0o640)
            self.originals[path] = data
        self.expected = {path: CSP.digest(data) for path, data in self.originals.items()}
        self.expected[self.map] = None

    def apply(self, runner):
        return CSP.apply(self.expected, self.configs, self.map, self.root, runner)

    def assert_restored(self):
        self.assertFalse(self.map.exists())
        for path, data in self.originals.items():
            self.assertEqual(path.read_bytes(), data)

    def test_scope_and_exact_header_token_preservation(self):
        calls = []
        result = self.apply(lambda command: calls.append(command) or 0)
        self.assertEqual(calls, [['nginx', '-t'], ['systemctl', 'reload', 'nginx']])
        for path, original in self.originals.items():
            self.assertEqual(path.read_bytes(), original.replace(('"' + BASE + '"').encode(), b'"$cbte_square_payment_csp"'))
        map_text = self.map.read_text()
        self.assertIn('default "' + BASE + '";', map_text)
        self.assertEqual(map_text.count('~^/dashboard/automation/'), 2)
        keys = re.findall(r'^    ~([^ ]+) ', map_text, flags=re.MULTILINE)
        for path in CSP.PAYMENT_PATHS:
            self.assertTrue(any(re.search(key, path) for key in keys))
        for path in ('/dashboard', '/api/automation/square/webhook', '/dashboard/automation/plans/', '/dashboard/automation/plans/child', '/Dashboard/automation/plans', '/dashboard/automation/PLANS', '/dashboard/automation/supporting'):
            self.assertFalse(any(re.search(key, path) for key in keys), path)
        self.assertEqual(result['payment_paths'], ('/dashboard/automation/plans', '/dashboard/automation/support'))
        after = result['payment_policy'].split(';')
        before = BASE.split(';')
        for old, new in zip(before, after):
            name = old.strip().split()[0]
            if name == 'font-src':
                self.assertEqual(new, old + ' https://cash-f.squarecdn.com')
            elif name in ('frame-src', 'form-action'):
                self.assertEqual(new.strip(), name + " 'self' https:")
            else:
                self.assertEqual(new, old)
        backup = Path(result['backup'])
        self.assertEqual((backup / self.configs[0].name).read_bytes(), self.originals[self.configs[0]])
        if os.name == 'posix':
            self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
            self.assertEqual(self.configs[0].stat().st_mode & 0o777, 0o640)

    def test_inspection_is_read_only(self):
        originals, outputs, base, payment = CSP.prepare(self.configs, self.map)
        self.assert_restored()
        self.assertEqual(base, BASE)
        self.assertIn('form-action \'self\' https:', payment)
        self.assertEqual(set(outputs), set(originals))

    def test_hash_compare_and_swap_rejects_stale_config(self):
        foreign = self.originals[self.configs[1]] + b'# external edit\n'
        self.configs[1].write_bytes(foreign)
        calls = []
        with self.assertRaisesRegex(CSP.ConfigError, 'Expected config hash'):
            self.apply(lambda command: calls.append(command) or 0)
        self.assertEqual(calls, [])
        self.assertEqual(self.configs[1].read_bytes(), foreign)
        self.assertEqual(self.configs[0].read_bytes(), self.originals[self.configs[0]])
        self.assertFalse(self.map.exists())

    def test_existing_map_is_not_overwritten(self):
        self.map.write_bytes(b'# another operator\n')
        with self.assertRaisesRegex(CSP.ConfigError, 'map already exists'):
            self.apply(lambda command: 0)
        self.assertEqual(self.map.read_bytes(), b'# another operator\n')

    def test_failed_config_test_restores_without_reload(self):
        calls = []
        with self.assertRaisesRegex(CSP.ConfigError, 'configuration test failed.*original files restored'):
            self.apply(lambda command: calls.append(command) or 1)
        self.assertEqual(calls, [['nginx', '-t']])
        self.assert_restored()

    def test_failed_reload_restores_and_validates_before_reloading_original(self):
        calls = []
        def runner(command):
            calls.append(command)
            return 1 if len(calls) == 2 else 0
        with self.assertRaisesRegex(CSP.ConfigError, 'reload failed.*original files restored'):
            self.apply(runner)
        self.assertEqual(calls, [['nginx', '-t'], ['systemctl', 'reload', 'nginx'], ['nginx', '-t'], ['systemctl', 'reload', 'nginx']])
        self.assert_restored()

    def test_concurrent_edit_after_test_is_preserved_and_never_reloaded(self):
        calls = []
        foreign = b'# foreign edit during nginx test\n'
        def runner(command):
            calls.append(command)
            self.configs[1].write_bytes(foreign)
            return 0
        with self.assertRaisesRegex(CSP.ConfigError, 'foreign changes preserved'):
            self.apply(runner)
        self.assertEqual(calls, [['nginx', '-t']])
        self.assertEqual(self.configs[1].read_bytes(), foreign)
        self.assertEqual(self.configs[0].read_bytes(), self.originals[self.configs[0]])
        self.assertFalse(self.map.exists())

    def test_rollback_does_not_remove_foreign_map(self):
        foreign = b'# replaced by another operator\n'
        def runner(command):
            self.map.write_bytes(foreign)
            return 1
        with self.assertRaisesRegex(CSP.ConfigError, 'foreign changes preserved'):
            self.apply(runner)
        self.assertEqual(self.map.read_bytes(), foreign)
        for path, data in self.originals.items():
            self.assertEqual(path.read_bytes(), data)

    def test_concurrent_edit_immediately_after_write_is_not_claimed_as_ours(self):
        original_writer = CSP.write_atomic
        foreign = b'# operator replaced newly written config\n'
        def writer(path, *args):
            owned = original_writer(path, *args)
            if path == self.configs[0]:
                path.write_bytes(foreign)
            return owned
        with patch.object(CSP, 'write_atomic', writer):
            with self.assertRaisesRegex(CSP.ConfigError, 'foreign changes preserved'):
                self.apply(lambda command: self.fail('Must not test or reload after the concurrent edit'))
        self.assertEqual(self.configs[0].read_bytes(), foreign)
        self.assertEqual(self.configs[1].read_bytes(), self.originals[self.configs[1]])
        self.assertFalse(self.map.exists())

    def test_concurrent_map_creation_mid_transaction_is_preserved(self):
        original_writer = CSP.write_atomic
        foreign = b'# new map from another operator\n'
        def writer(path, *args):
            owned = original_writer(path, *args)
            if path == self.configs[0]:
                self.map.write_bytes(foreign)
            return owned
        with patch.object(CSP, 'write_atomic', writer):
            with self.assertRaisesRegex(CSP.ConfigError, 'Concurrent config change.*original files restored'):
                self.apply(lambda command: self.fail('Must not test or reload after the concurrent map'))
        self.assertEqual(self.map.read_bytes(), foreign)
        for path, data in self.originals.items():
            self.assertEqual(path.read_bytes(), data)

    def test_ambiguous_headers_and_interpolation_fail_closed(self):
        for suffix in (f'add_header Content-Security-Policy "{BASE}";', 'add_header Content-Security-Policy "$foreign_policy";'):
            with self.subTest(suffix=suffix):
                self.configs[0].write_bytes(self.originals[self.configs[0]] + suffix.encode())
                with self.assertRaises(CSP.ConfigError):
                    CSP.prepare(self.configs, self.map)
        self.configs[0].write_bytes(self.originals[self.configs[0]])

    def test_nonmatching_base_and_duplicate_directives_rejected(self):
        self.configs[1].write_bytes(self.originals[self.configs[1]].replace(b"object-src 'none'", b"object-src 'self'"))
        with self.assertRaisesRegex(CSP.ConfigError, 'policies differ'):
            CSP.prepare(self.configs, self.map)
        with self.assertRaisesRegex(CSP.ConfigError, 'Duplicate CSP directive'):
            CSP.payment_policy(BASE + "; font-src 'self'")


if __name__ == '__main__':
    unittest.main()
