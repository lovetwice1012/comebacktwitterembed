'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTestDatabase } = require('../lib/automation-test-db');
const { savePlanPolicy } = require('../../src/automation/entitlements');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
if (port !== 33621) throw new Error('This test requires disposable AUTOMATION_TEST_DB_PORT=33621');

test('operator preview rolls back, application snapshots the exact cohort, and rerun cannot change it', { timeout: 90000 }, async () => {
    const db = await createTestDatabase(port), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbte-plan-cli-'));
    const cohortPath = path.join(temp, 'cohort.json'), preloadPath = path.join(temp, 'mysql-port.cjs');
    try {
        const ids = Array.from({ length: 33 }, (_, i) => String(1000 + i));
        for (const id of ids) await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,1)', [id]);
        await db.withDatabaseTransaction(query => savePlanPolicy(query, { userId: '900', isAdmin: true }, { planId: 'supporter', label: '支援者', slotLimit: 5, minuteLimit: 7, dayLimit: 36, priority: 1, intervalMinutes: 30 }));
        fs.writeFileSync(cohortPath, JSON.stringify(ids));
        fs.writeFileSync(preloadPath, `const mysql=require(${JSON.stringify(require.resolve('mysql'))});const create=mysql.createPool;mysql.createPool=options=>create({...options,port:33621,password:process.env.AUTOMATION_TEST_DB_PASSWORD||''});`);
        const script = path.join(__dirname, '../plan-redesign-rollout.cjs');
        const run = mode => spawnSync(process.execPath, ['-r', preloadPath, script, mode, cohortPath, '900'], { encoding: 'utf8', env: { ...process.env, DB_HOST: '127.0.0.1', DB_USER: 'root', DB_PASSWORD: process.env.AUTOMATION_TEST_DB_PASSWORD || '', DB_DATABASE: db.schema, NODE_ENV: 'test' } });
        const preview = run('preview'); assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).rolledBack, true);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_legacy_donor_benefits'))[0].n), 0);
        const apply = run('apply'); assert.equal(apply.status, 0, apply.stderr); assert.equal(JSON.parse(apply.stdout).donorCount, 33);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_legacy_donor_benefits'))[0].n), 33);
        const repeat = run('apply'); assert.equal(repeat.status, 1); assert.equal(JSON.parse(repeat.stderr).code, 'LEGACY_DONOR_CUTOVER_COMPLETE');
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) n FROM automation_legacy_donor_benefits'))[0].n), 33);
    } finally { fs.unlinkSync(cohortPath); fs.unlinkSync(preloadPath); fs.rmdirSync(temp); await db.close(); }
});
