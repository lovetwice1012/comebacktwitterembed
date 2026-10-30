import importlib.util
import json
import pathlib
import sqlite3
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

FILE = pathlib.Path(__file__).resolve().parents[1] / 'recover-expansion-traces.py'
spec = importlib.util.spec_from_file_location('trace_recovery', FILE)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def trace(**overrides):
    return {'trace_id': 'abc-123', 'created_at_ms': 1700000000000, 'completed_at_ms': 1700000001000,
            'state': 'completed', 'outcome': 'F', 'provider_id': 'niconico',
            'raw_url': 'https://www.nicovideo.jp/watch/sm9', 'guild_id': '1', 'channel_id': '2',
            'author_user_id': '3', 'message_id': '4', **overrides}


class RecoveryTests(unittest.TestCase):
    def test_mysql_summary_is_explicit_and_keeps_identity(self):
        first, last = recovery.recovered_events(trace())
        self.assertEqual(first['requestId'], 'abc-123')
        self.assertEqual(first['details']['recovery']['source'], 'mysql_expansion_trace')
        self.assertEqual(first['triggerType'], 'recovered_mysql_trace')
        self.assertEqual(last['outcome'], 'F')
        self.assertEqual(last['details']['recovery']['detailCompleteness'], 'partial')
        self.assertEqual(recovery.recovered_events(trace()), [first, last])

    def test_unknown_success_never_becomes_a_fabricated_success(self):
        self.assertEqual(recovery.recovered_events(trace(outcome='unknown'))[1]['outcome'], 'X')
        self.assertEqual(recovery.recovered_events(trace(state='failed', outcome='fetch_error'))[1]['outcome'], 'E')
        self.assertEqual(recovery.recovered_events(trace(state='skipped', outcome='skipped'))[1]['outcome'], 'S')
        self.assertEqual(len(recovery.recovered_events(trace(state='processing'))), 1)

    def test_original_completion_is_copied_with_new_id_without_mutating_original(self):
        original = {'id': 'native', 'eventId': 'native', 'kind': 'request.completed', 'outcome': 'P', 'details': {'reason': 'original'}}
        events = recovery.recovered_events(trace(), original)
        self.assertEqual(original['id'], 'native')
        self.assertNotEqual(events[1]['id'], 'native')
        self.assertEqual(events[1]['id'], events[1]['event_id'])
        self.assertEqual(events[1]['outcome'], 'P')
        self.assertEqual(events[1]['details']['reason'], 'original')
        self.assertEqual(events[1]['recovery']['completion'], 'original_agent_event')

    def test_large_original_stays_in_agent_store_and_recovery_copy_is_bounded(self):
        original = {'id': 'large-native', 'kind': 'request.completed', 'outcome': 'P',
                    'details': {'body': 'x' * (2 * 1024 * 1024)}}
        restored = recovery.recovered_events(trace(), original)[1]
        self.assertEqual(restored['outcome'], 'P')
        self.assertEqual(restored['details']['recovery']['originalAgentEventId'], 'large-native')
        self.assertLess(len(json.dumps(restored)), 3000)

    def test_existing_roots_are_not_recreated_and_original_completion_can_be_read(self):
        db = sqlite3.connect(':memory:')
        db.executescript('CREATE TABLE request_roots(run_id TEXT); CREATE TABLE events(run_id TEXT,kind TEXT,seq INTEGER,payload TEXT);')
        db.execute('INSERT INTO request_roots VALUES (?)', ('abc-123',))
        self.assertEqual(recovery.find_missing(db, [trace()]), [])
        self.assertEqual(recovery.find_missing(db, [trace(trace_id='missing')])[0]['trace_id'], 'missing')
        db.execute('INSERT INTO events VALUES (?,?,?,?)', ('missing', 'request.completed', 1, '{"outcome":"E"}'))
        self.assertEqual(recovery.original_completion(db, 'missing'), {'outcome': 'E'})
        db.close()

    def test_submission_uses_only_loopback_and_returns_ack(self):
        got = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                got.extend(json.loads(self.rfile.read(int(self.headers['Content-Length'])))['events'])
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"accepted":2}')
            def log_message(self, *_args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            result = recovery.submit(recovery.recovered_events(trace()), 'fixture', 'http://127.0.0.1:%d' % server.server_port)
            self.assertEqual(result['accepted'], 2)
            self.assertEqual(len(got), 2)
            with self.assertRaises(ValueError):
                recovery.submit([], 'fixture', 'https://example.com')
        finally:
            server.shutdown(); worker.join(); server.server_close()


if __name__ == '__main__':
    unittest.main()
