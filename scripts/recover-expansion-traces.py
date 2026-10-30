#!/usr/bin/env python3
"""Rebuild missing investigation roots from retained MySQL traces.

Dry-run by default. Never modifies MySQL or SQLite directly. In apply mode the
local authenticated agent ingests idempotent, explicitly marked recovery
events. Missing detailed telemetry is never invented.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request

ROOT = pathlib.Path(os.environ.get('CBTE_RECOVERY_APP_ROOT') or pathlib.Path(__file__).resolve().parent.parent).resolve()
MYSQL_PAGE = r"""
const mysql=require('mysql'),readline=require('readline'),config=require('./src/db').getDbCredentials();
if(process.env.RECOVERY_DB_PORT){const n=Number(process.env.RECOVERY_DB_PORT);if(!Number.isInteger(n)||n<1||n>65535)throw new Error('INVALID_DB_PORT');config.port=n}
const c=mysql.createConnection(config);
const sql=`SELECT trace_id,boot_id,state,outcome,reason_code,created_at_ms,completed_at_ms,updated_at_ms,
provider_id,raw_url,guild_id,channel_id,author_user_id,message_id,output_json,delivery_json,error_json
FROM bot_provider_expansion_traces
WHERE created_at_ms>=? AND created_at_ms<? AND (created_at_ms>? OR (created_at_ms=? AND trace_id>?))
ORDER BY created_at_ms,trace_id LIMIT ?`;
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{let a;try{a=JSON.parse(line)}catch{process.stdout.write('{"error":"INVALID_PAGE"}\n');return}
 c.query({sql,values:[a.start,a.end,a.last,a.last,a.id,a.limit],timeout:20000},(e,rows)=>{
  if(e)process.stdout.write('{"error":"MYSQL_READ_FAILED"}\n');
  else process.stdout.write(JSON.stringify({rows})+'\n');
 });
});
input.on('close',()=>c.end());
"""
VALID_OUTCOMES = set('FDPEUSCIX')


def event_id(trace_id, suffix):
    return 'recovered-mysql-' + hashlib.sha256((trace_id + ':' + suffix).encode()).hexdigest()


def iso_millis(value):
    return datetime.datetime.fromtimestamp(int(value) / 1000, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def parsed_json(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return {'unavailable': True, 'reason': 'invalid_stored_json'}


def recovered_events(row, original_completion=None):
    trace_id = str(row['trace_id'])
    marker = {'source': 'mysql_expansion_trace', 'detailCompleteness': 'partial', 'originalTraceId': trace_id}
    started = {'event_id': event_id(trace_id, 'start'), 'runId': trace_id, 'requestId': trace_id,
               'kind': 'request.started', 'stage': 'recovery', 'occurredAt': iso_millis(row['created_at_ms']),
               'guildId': row.get('guild_id') or '', 'channelId': row.get('channel_id') or '',
               'userId': row.get('author_user_id') or '', 'messageId': row.get('message_id') or '',
               'provider': row.get('provider_id') or '', 'url': row.get('raw_url') or '',
               'triggerType': 'recovered_mysql_trace', 'details': {'recovery': marker}}
    events = [started]
    if row.get('state') not in ('completed', 'failed', 'skipped', 'interrupted'):
        return events
    if original_completion:
        completed = dict(original_completion)
        original_id = completed.get('id') or completed.get('eventId') or completed.get('event_id')
        completed['event_id'] = event_id(trace_id, 'existing-completion')
        completed['eventId'] = completed['event_id']
        completed['id'] = completed['event_id']
        completed['runId'] = trace_id
        completed['requestId'] = trace_id
        completed['recovery'] = {**marker, 'completion': 'original_agent_event'}
        original_details = completed.get('details')
        if isinstance(original_details, dict):
            completed['details'] = {**original_details, 'recovery': completed['recovery']}
            completed['details'].setdefault('reason', 'Botの保存記録から復元（詳細の一部は未記録）')
        else:
            completed['details'] = {'recovery': completed['recovery'], 'reason': 'Botの保存記録から復元（詳細の一部は未記録）'}
        encoded = json.dumps(completed, ensure_ascii=True, separators=(',', ':')).encode()
        if len(encoded) > 1024 * 1024:
            # The already-ingested original is retained in the agent store.
            # Keep its recorded result while avoiding a second giant payload.
            outcome = completed.get('outcome')
            if not isinstance(outcome, str) or outcome not in VALID_OUTCOMES:
                outcome = original_details.get('outcome') if isinstance(original_details, dict) else None
            completed = {'id': event_id(trace_id, 'existing-completion'), 'runId': trace_id, 'requestId': trace_id,
                         'kind': 'request.completed', 'stage': 'recovery',
                         'occurredAt': completed.get('occurredAt') or completed.get('occurred_at') or iso_millis(row['created_at_ms']),
                         'outcome': outcome if isinstance(outcome, str) and outcome in VALID_OUTCOMES else 'X',
                         'details': {'reason': 'Botの保存記録から復元（詳細の一部は未記録）',
                                     'recovery': {**marker, 'completion': 'original_agent_event',
                                                  'originalAgentEventId': original_id,
                                                  'copyOmittedBytes': len(encoded),
                                                  'copySha256': hashlib.sha256(encoded).hexdigest()}}}
    else:
        raw_outcome = str(row.get('outcome') or '')
        state = row['state']
        outcome = raw_outcome if raw_outcome in VALID_OUTCOMES else {'failed': 'E', 'skipped': 'S', 'interrupted': 'X'}.get(state, 'X')
        completed = {'event_id': event_id(trace_id, 'mysql-completion'), 'runId': trace_id, 'requestId': trace_id,
                     'kind': 'request.completed', 'stage': 'recovery',
                     'occurredAt': iso_millis(row.get('completed_at_ms') or row.get('updated_at_ms') or row['created_at_ms']),
                     'guildId': row.get('guild_id') or '', 'provider': row.get('provider_id') or '',
                     'triggerType': 'recovered_mysql_trace', 'outcome': outcome,
                     'details': {'recovery': marker, 'originalState': state, 'originalOutcome': raw_outcome,
                                 'reason': 'Botの保存記録から復元（詳細の一部は未記録）',
                                 'reasonCode': row.get('reason_code'), 'output': parsed_json(row.get('output_json')),
                                 'delivery': parsed_json(row.get('delivery_json')), 'error': parsed_json(row.get('error_json'))}}
    events.append(completed)
    return events


def page(process, start, end, last, trace_id, limit):
    args = json.dumps({'start': start, 'end': end, 'last': last, 'id': trace_id, 'limit': limit})
    process.stdin.write(args + '\n')
    process.stdin.flush()
    output = process.stdout.readline()
    if not output:
        raise RuntimeError('MYSQL_READ_FAILED')
    result = json.loads(output)
    if 'error' in result:
        raise RuntimeError('MYSQL_READ_FAILED')
    return result['rows']


def find_missing(db, rows):
    if not rows:
        return []
    ids = [str(row['trace_id']) for row in rows]
    sql = 'SELECT run_id FROM request_roots WHERE run_id IN (' + ','.join('?' for _ in ids) + ')'
    existing = {row[0] for row in db.execute(sql, ids)}
    return [row for row in rows if str(row['trace_id']) not in existing]


def original_completion(db, trace_id):
    row = db.execute("SELECT payload FROM events WHERE run_id=? AND kind='request.completed' ORDER BY seq DESC LIMIT 1", (trace_id,)).fetchone()
    if not row:
        return None
    try:
        value = json.loads(row[0])
        return value if isinstance(value, dict) else None
    except ValueError:
        return None


def submit(events, token, base):
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password:
        raise ValueError('Management ingestion must use the local HTTP agent')
    # Historical JSON may contain lone UTF-16 surrogates. Escaping them keeps
    # the request valid without making UTF-8 encoding fail. The retained MySQL
    # source remains unchanged even if the receiving JSON parser normalizes it.
    body = json.dumps({'events': events}, ensure_ascii=True, separators=(',', ':')).encode('ascii')
    if len(body) > 6 * 1024 * 1024:
        raise ValueError('Recovery batch exceeds safe size')
    req = urllib.request.Request(base.rstrip('/') + '/v1/events', data=body, method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Admin-Agent-Token': token})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                if response.status != 200:
                    raise RuntimeError('AGENT_INGESTION_FAILED')
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (429, 502, 503, 504) or attempt == 2:
                raise RuntimeError('AGENT_HTTP_' + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise RuntimeError('AGENT_CONNECTION_FAILED') from None
        # Stable event IDs make a retry safe even if the response was lost
        # after the agent committed the previous batch.
        time.sleep(0.5 * (attempt + 1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-ms', type=int, required=True)
    parser.add_argument('--until-ms', type=int, required=True)
    parser.add_argument('--max-traces', type=int, default=100000)
    parser.add_argument('--sqlite', default='/var/lib/cbte-admin/state.db')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.from_ms < 0 or args.until_ms <= args.from_ms or args.until_ms > int(time.time() * 1000) - 180000:
        parser.error('Use a fixed historical interval ending at least three minutes ago')
    if args.max_traces < 1 or args.max_traces > 2000000:
        parser.error('Invalid trace bound')
    token = os.environ.get('ADMIN_AGENT_TOKEN', '')
    if args.apply and not token:
        raise RuntimeError('ADMIN_AGENT_TOKEN_REQUIRED')
    spool = pathlib.Path(os.environ.get('ADMIN_TELEMETRY_DIR', ''))
    if args.apply and (not spool.is_absolute() or not spool.is_dir() or any(spool.glob('*.pending'))):
        raise RuntimeError('TELEMETRY_QUEUE_MUST_BE_DRAINED_FIRST')
    db = sqlite3.connect(pathlib.Path(args.sqlite).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    if db.execute('SELECT ready FROM request_roots_meta WHERE id=1').fetchone() != (1,):
        raise RuntimeError('ROOT_INDEX_NOT_READY')
    stats = {'examined': 0, 'missing': 0, 'originalCompletionsReused': 0, 'eventsAcknowledged': 0, 'apply': args.apply}
    last, trace_id = args.from_ms - 1, ''
    worker = subprocess.Popen(['node', '-e', MYSQL_PAGE], cwd=ROOT, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
    try:
        while stats['examined'] < args.max_traces:
            rows = page(worker, args.from_ms, args.until_ms, last, trace_id, min(600, args.max_traces - stats['examined']))
            if not rows:
                break
            missing = find_missing(db, rows)
            stats['examined'] += len(rows)
            stats['missing'] += len(missing)
            batch, batch_bytes = [], 0
            for row in missing:
                original = original_completion(db, str(row['trace_id']))
                stats['originalCompletionsReused'] += int(original is not None)
                events = recovered_events(row, original)
                estimated = sum(len(json.dumps(event, ensure_ascii=True).encode()) * 2 for event in events)
                if estimated > 4 * 1024 * 1024:
                    raise RuntimeError('RECOVERY_EVENT_EXCEEDS_SAFE_BATCH')
                if args.apply and batch and (len(batch) + len(events) > 400 or batch_bytes + estimated > 4 * 1024 * 1024):
                    submit(batch, token, os.environ.get('ADMIN_AGENT_URL', 'http://127.0.0.1:30988'))
                    stats['eventsAcknowledged'] += len(batch)
                    batch, batch_bytes = [], 0
                    time.sleep(0.1)
                batch.extend(events)
                batch_bytes += estimated
            if args.apply and batch:
                submit(batch, token, os.environ.get('ADMIN_AGENT_URL', 'http://127.0.0.1:30988'))
                stats['eventsAcknowledged'] += len(batch)
                time.sleep(0.1)
            last, trace_id = int(rows[-1]['created_at_ms']), str(rows[-1]['trace_id'])
            if args.apply and stats['examined'] % 6000 == 0:
                print(json.dumps({'progress': stats['examined'], 'missing': stats['missing'], 'lastProcessedMs': last}), file=sys.stderr, flush=True)
    finally:
        worker.stdin.close()
        try:
            worker.wait(timeout=25)
        except subprocess.TimeoutExpired:
            worker.terminate()
            worker.wait(timeout=5)
        db.close()
    stats['hitLimit'] = stats['examined'] >= args.max_traces
    stats['lastProcessedMs'] = last
    print(json.dumps(stats, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print credentials, URLs, database records, or HTTP bodies.
        print(json.dumps({'error': type(error).__name__, 'message': str(error) if isinstance(error, (ValueError, RuntimeError)) else 'RECOVERY_FAILED'}), file=sys.stderr)
        sys.exit(1)
