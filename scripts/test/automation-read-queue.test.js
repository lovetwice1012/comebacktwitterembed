'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');

test('parallel page reads and explicit edits fit the actual server admission ceiling', async () => {
    const { automationFetch } = load('components/automation/automation-feedback.ts');
    const { reserveAdmission } = load('lib/automation-admission.ts');
    const before = global.fetch; let active = 0, peak = 0, rejected = 0;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push([url, init?.method || 'GET']);
        let release;
        try { release = reserveAdmission('read-queue-fixture', 0); }
        catch { rejected++; return Response.json({ code: 'AUTOMATION_USER_BUSY' }, { status: 429 }); }
        peak = Math.max(peak, ++active);
        try { await new Promise(resolve => setTimeout(resolve, 15)); return Response.json({ ok: true }); }
        finally { active--; release(); }
    };
    try {
        await Promise.all([...Array.from({ length: 12 }, (_, i) => automationFetch(`/api/automation/catalog?${i}`)),
            automationFetch('/api/automation/monitors/auto', { method: 'POST' }), automationFetch('/api/automation/monitors/auto/1', { method: 'PATCH' })]);
        assert.equal(rejected, 0); assert(peak <= 4); assert.equal(calls.length, 14);
        assert.deepEqual(calls.slice(0, 4).map(call => call[1]), ['GET', 'GET', 'POST', 'PATCH']);
        assert.equal(calls.filter(call => call[1] !== 'GET').length, 2, 'Mutations are sent once and are never retried');
    } finally { global.fetch = before; }
});

test('failed and malformed reads release capacity for the remaining queue', async () => {
    const { automationFetch } = load('components/automation/automation-feedback.ts');
    const before = global.fetch; const calls = [];
    global.fetch = async url => {
        calls.push(url);
        if (url.endsWith('/network')) throw Error('PRIVATE_NETWORK');
        if (url.endsWith('/invalid')) return new Response('PRIVATE_BODY');
        if (url.endsWith('/auth')) return new Response('', { status: 401 });
        return Response.json({ ok: true });
    };
    try {
        const result = await Promise.allSettled(['network', 'invalid', 'auth', 'ready', 'ready2'].map(name => automationFetch('/api/automation/'+name)));
        assert.deepEqual(result.map(value => value.status), ['rejected', 'rejected', 'rejected', 'fulfilled', 'fulfilled']);
        for (const entry of result.slice(0, 3)) assert(!entry.reason.message.includes('PRIVATE'));
        assert.equal(calls.length, 5);
        assert.deepEqual(await automationFetch('/api/automation/ready3'), { ok: true });
    } finally { global.fetch = before; }
});
