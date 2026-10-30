'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { TABLES, SCHEMA_STATEMENTS } = require('../../src/db_schema');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT || 0);

test('retained SQL traces recover through the agent exactly once across an ingest failure', { skip: !port, timeout: 60000 }, async () => {
    const db = await createTestDatabase(port), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-trace-recovery-'));
    const sqlite = path.join(temp, 'agent.sqlite'), spool = path.join(temp, 'spool');
    fs.mkdirSync(spool);
    const user = 'fixture_' + randomUUID().replaceAll('-', '').slice(0, 12), password = 'fixture-pass';
    const py = process.env.PYTHON || 'python';
    const runPython = (code, input = '') => {
        const result = spawnSync(py, ['-c', code, sqlite], { input, encoding: 'utf8' });
        if (result.status !== 0) throw new Error('SQLite fixture failed');
        return result.stdout.trim();
    };
    let remainingBeforeFailure = -1;
    const server = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        if (remainingBeforeFailure === 0) { remainingBeforeFailure = -1; res.statusCode = 503; return res.end('{}'); }
        if (remainingBeforeFailure > 0) remainingBeforeFailure--;
        try {
            runPython(`import sqlite3,sys,json
d=sqlite3.connect(sys.argv[1]);events=json.load(sys.stdin)['events']
for e in events:
 i=e.get('id') or e.get('eventId') or e.get('event_id')
 c=d.execute('INSERT OR IGNORE INTO events(id,run_id,kind,payload) VALUES(?,?,?,?)',(i,e['runId'],e['kind'],json.dumps(e)))
 if c.rowcount and e['kind']=='request.started':d.execute('INSERT OR IGNORE INTO request_roots VALUES(?)',(e['runId'],))
d.commit();d.close()`, Buffer.concat(chunks).toString());
            res.end('{"accepted":2}');
        } catch { res.statusCode = 500; res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        runPython(`import sqlite3,sys
d=sqlite3.connect(sys.argv[1]);d.executescript("CREATE TABLE request_roots_meta(id INTEGER,ready INTEGER);INSERT INTO request_roots_meta VALUES(1,1);CREATE TABLE request_roots(run_id TEXT PRIMARY KEY);CREATE TABLE events(id TEXT UNIQUE,run_id TEXT,kind TEXT,seq INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT);");d.close()`);
        await db.queryDatabase(SCHEMA_STATEMENTS.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${TABLES.botProviderExpansionTraces} (`)));
        await db.queryDatabase(`CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}'`);
        await db.queryDatabase(`GRANT SELECT ON \`${db.schema}\`.* TO '${user}'@'127.0.0.1'`);
        const stamp = Date.now() - 600000;
        for (let i = 0; i < 201; i++) await db.queryDatabase(`INSERT INTO ${TABLES.botProviderExpansionTraces}
            (trace_id,boot_id,state,outcome,created_at_ms,updated_at_ms,completed_at_ms,provider_id,raw_url,guild_id,channel_id,author_user_id,message_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), 'fixture', 'completed', 'F', stamp+i, stamp+i+100, stamp+i+100, ['twitter','niconico','booth'][i % 3], 'https://example.test/', '1', '2', '3', String(i)]);
        const env = { ...process.env, DB_HOST: '127.0.0.1', DB_USER: user, DB_PASSWORD: password, DB_DATABASE: db.schema,
            RECOVERY_DB_PORT: String(port), ADMIN_AGENT_TOKEN: 'fixture', ADMIN_AGENT_URL: `http://127.0.0.1:${server.address().port}`, ADMIN_TELEMETRY_DIR: spool };
        const invoke = apply => new Promise(resolve => {
            const args = ['scripts/recover-expansion-traces.py', '--from-ms', String(stamp-1), '--until-ms', String(stamp+1000), '--sqlite', sqlite, ...(apply ? ['--apply'] : [])];
            const child = spawn(py, args, { cwd: path.resolve(__dirname, '../..'), env });
            let out='',err=''; child.stdout.on('data', b => { out+=b; }); child.stderr.on('data', b => { err+=b; }); child.on('close', code => resolve({ code,out,err }));
        });
        const dry = await invoke(false); assert.equal(dry.code, 0, dry.err); assert.equal(JSON.parse(dry.out).missing, 201);
        remainingBeforeFailure = 1; const failed = await invoke(true); assert.notEqual(failed.code, 0);
        const restored = await invoke(true); assert.equal(restored.code, 0, restored.err); assert.equal(JSON.parse(restored.out).missing, 1);
        const again = await invoke(true); assert.equal(again.code, 0, again.err); assert.equal(JSON.parse(again.out).missing, 0);
        assert.equal(runPython("import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute('select count(*) from request_roots').fetchone()[0]);d.close()"), '201');
        assert.equal(runPython("import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute('select count(*) from events').fetchone()[0]);d.close()"), '402');
    } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        await db.queryDatabase(`DROP USER IF EXISTS '${user}'@'127.0.0.1'`); await db.close();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
