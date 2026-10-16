'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const pause = f => f.act(async () => new Promise(resolve => setTimeout(resolve, 5)));
const entry = (id, extra = {}) => ({ nodeId: `private-node-${id}`, memberId: `private-member-${id}`, outcome: 'yes', detail: [{ term: `match-${id}`, start: 2, end: 9, category: `category-${id}` }], ...extra });
const page = (items, nextCursor = null, sourceRevision = 'revision-A', totalEntries = null) => ({ items, sourceRevision, nextCursor, totalEntries, complete: nextCursor == null, sources: items.map((_, i) => ({ kind: 'step', id: `source-${i}` })) });
const indexed = (runId = 'run-A', extra = {}) => ({ runId, indexed: true, firstPage: false, totalEntries: null, ...extra });
async function open(f, label = '処理の詳細', index = 0) {
    const summary = [...f.container.querySelectorAll('summary')].filter(node => node.textContent.trim() === label)[index]; assert(summary, label);
    await f.act(async () => { const details = summary.parentElement; details.open = true; details.dispatchEvent(new f.dom.window.Event('toggle', { bubbles: true })); }); await pause(f);
}
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
async function fixture(api, props = {}) {
    const f = await reactFixture('export { ProcessingTrace } from "./components/automation/processing-trace";');
    f.calls = []; f.props = { trace: [], traceHistory: indexed(), api: async (route, method, body) => { f.calls.push({ route, method, body }); return api(route, method, body); }, ...props };
    f.paint = () => f.render(f.React.createElement(f.exports.ProcessingTrace, f.props)); await f.paint(); return f;
}

test('small and legacy trace arrays keep their exact matches, reasons and full diagnostic fields without making requests', async () => {
    const raw = entry('legacy', { reason: '利用者が指定した除外理由', custom: { original: 'preserved', all: [1, 2, 3] }, source: { existing: 'original-source' } });
    const f = await fixture(() => assert.fail('legacy must remain local'), { trace: [raw], traceHistory: undefined });
    try {
        await open(f); assert.deepEqual(f.calls, []);
        assert.match(f.container.textContent, /一致した語 1件/); assert.match(f.container.textContent, /match-legacy/); assert.match(f.container.textContent, /位置 2–9/); assert.match(f.container.textContent, /利用者が指定した除外理由/);
        await open(f, '記録のデータ'); assert.deepEqual(JSON.parse(f.container.querySelector('pre').textContent), raw);
        assert(![...f.container.querySelector('ol').firstElementChild.children].filter(node => node.tagName !== 'DETAILS').some(node => node.textContent.includes('private-node')));
    } finally { await f.close(); }
});

test('an ordinary small graph trace can explicitly open complete durable records without changing its raw entries', async () => {
    const raw = entry('projection'), exact = entry('exact', { source: { existing: 'kept' } });
    const f = await fixture(() => page([exact]), { trace: [raw], traceHistory: { ...indexed(), indexed: false } });
    try {
        await open(f); assert.equal(f.calls.length, 0); assert.match(f.container.textContent, /match-projection/);
        await f.click('すべての処理記録を確認'); assert.equal(f.calls[0].route, 'runs/run-A/trace'); assert.match(f.container.textContent, /match-exact/); assert(!f.container.textContent.includes('match-projection'));
        await open(f, '記録のデータ'); assert.deepEqual(JSON.parse(f.container.querySelector('pre').textContent), exact);
    } finally { await f.close(); }
});

test('an indexed trace reads every page only after expansion and reports processing records separately from notifications', async () => {
    const all = Array.from({ length: 123 }, (_, i) => entry(i));
    const f = await fixture(route => route === 'runs/run-A/trace' ? page(all.slice(0, 50), 'cursor+/=50') : route.endsWith('cursor=cursor%2B%2F%3D50') ? page(all.slice(50, 100), 'cursor-100') : page(all.slice(100)));
    try {
        assert.deepEqual(f.calls, []); await open(f); assert.equal(f.calls.length, 1); assert.match(f.container.textContent, /処理記録 50件/);
        await f.click('処理記録の続きを読み込む'); await f.click('処理記録の続きを読み込む'); assert.equal(f.calls.length, 3);
        assert.equal(f.container.querySelectorAll('ol[aria-label="処理記録"] > li').length, 123); assert.equal(f.container.querySelectorAll('section[aria-label="一致した語"] li').length, 123);
        assert.match(f.container.textContent, /処理記録 123件/); assert.match(f.container.textContent, /match-122/); assert.match(f.container.textContent, /すべての処理記録を表示しました/);
        assert(![...f.container.querySelectorAll('button')].some(node => node.textContent.includes('続きを'))); assert(!f.container.textContent.includes('123件を通知'));
        assert(f.calls.every(call => call.method === undefined && call.body === undefined));
    } finally { await f.close(); }
});

test('a job detail first page is reused and only its next cursor is fetched after user action', async () => {
    const f = await fixture(route => { assert.equal(route, 'runs/retained-run/trace?cursor=second'); return page([entry('second')]); }, { trace: [entry('first')], traceHistory: indexed('retained-run', { firstPage: true, sourceRevision: 'revision-A', nextCursor: 'second', totalEntries: 2 }) });
    try {
        await open(f); assert.equal(f.calls.length, 0); assert.match(f.container.textContent, /処理記録 1件（全2件）/);
        await f.click('処理記録の続きを読み込む'); assert.equal(f.calls.length, 1); assert.match(f.container.textContent, /処理記録 2件/); assert.match(f.container.textContent, /match-first/); assert.match(f.container.textContent, /match-second/);
    } finally { await f.close(); }
});

test('a page read failure keeps displayed records and retries the same cursor without duplicate data or writes', async () => {
    let failures = 1;
    const f = await fixture(route => { if (!route.includes('?')) return page([entry('saved')], 'next'); if (failures--) throw Object.assign(Error('raw sql credential must stay hidden'), { status: 503, code: 'HISTORY_TRACE_UNAVAILABLE' }); return page([entry('after-retry')]); });
    try {
        await open(f); await f.click('処理記録の続きを読み込む'); assert.match(f.container.textContent, /match-saved/); assert(!f.container.textContent.includes('raw sql'));
        await f.click('処理記録を再読み込み'); assert.deepEqual(f.calls.map(call => call.route), ['runs/run-A/trace', 'runs/run-A/trace?cursor=next', 'runs/run-A/trace?cursor=next']);
        assert.equal(f.container.querySelectorAll('ol > li').length, 2); assert.match(f.container.textContent, /match-after-retry/); assert.equal(f.container.querySelector('[role="alert"]'), null);
    } finally { await f.close(); }
});

for (const changed of ['conflict', 'changed-success', 'invalid-cursor']) test(`a ${changed} trace cannot mix live editions and requires an explicit restart`, async () => {
    let starts = 0;
    const f = await fixture(route => {
        if (!route.includes('?')) return starts++ ? page([entry('fresh')], null, 'revision-B') : page([entry('obsolete')], 'old-next');
        if (changed === 'changed-success') return page([entry('wrong')], null, 'revision-B');
        throw Object.assign(Error('raw conflict'), { status: changed === 'conflict' ? 409 : 400, code: changed === 'conflict' ? 'HISTORY_TRACE_CHANGED' : 'INVALID_CURSOR' });
    });
    try {
        await open(f); await f.click('処理記録の続きを読み込む'); assert.equal(f.calls.length, 2); assert(!f.container.textContent.includes('match-obsolete')); assert(!f.container.textContent.includes('match-wrong'));
        assert.match(f.container.textContent, /先頭から読み直してください/); await f.click('処理記録を先頭から読み直す'); assert.equal(f.calls.length, 3); assert.match(f.container.textContent, /match-fresh/); assert.equal(f.container.querySelectorAll('ol > li').length, 1);
    } finally { await f.close(); }
});

for (const status of [403, 404]) test(`a ${status} trace read removes obsolete private records and makes no notification mutation`, async () => {
    const f = await fixture(() => { throw Object.assign(Error('private SQL error'), { status }); }, { trace: [entry('private')], traceHistory: indexed('run-A', { firstPage: true, sourceRevision: 'revision-A', nextCursor: 'next', totalEntries: null }) });
    try {
        await open(f); await f.click('処理記録の続きを読み込む'); assert(!f.container.textContent.includes('match-private')); assert(!f.container.textContent.includes('private SQL')); assert.match(f.container.textContent, /権限と登録状態/); assert(f.calls.every(row => !row.method));
    } finally { await f.close(); }
});

test('an API scope switch hides old private data immediately and suppresses late failures from the prior scope', async () => {
    const old = deferred(), f = await fixture(() => old.promise, { trace: [entry('private-old')], traceHistory: indexed('run-A', { firstPage: true, sourceRevision: 'revision-A', nextCursor: 'next', totalEntries: null }) });
    try {
        await open(f); await f.click('処理記録の続きを読み込む');
        f.props = { ...f.props, api: async () => page([entry('new-scope')]), trace: [], traceHistory: indexed('new-run') }; await f.paint();
        assert(!f.container.textContent.includes('private-old')); await open(f); await f.act(async () => old.reject(Error('obsolete private failure'))); await f.settle();
        assert.match(f.container.textContent, /match-new-scope/); assert(!f.container.textContent.includes('obsolete')); assert.equal(f.container.querySelector('[role="alert"]'), null);
    } finally { await f.close(); }
});

test('run selection, active state and unmount fence old responses while preserving an explicit way to resume reads', async () => {
    const old = deferred(), paused = deferred(), afterUnmount = deferred(); let phase = 0, closed = false;
    const f = await fixture(route => route.includes('old-run') ? old.promise : route.includes('unmount-run') ? afterUnmount.promise : phase++ === 0 ? paused.promise : page([entry('resumed')]), { traceHistory: indexed('old-run') });
    try {
        await open(f); f.props = { ...f.props, traceHistory: indexed('new-run') }; await f.paint(); await open(f);
        await f.act(async () => old.resolve(page([entry('obsolete-run')]))); assert(!f.container.textContent.includes('obsolete-run'));
        f.props = { ...f.props, active: false }; await f.paint(); await f.act(async () => paused.resolve(page([entry('obsolete-active')])));
        f.props = { ...f.props, active: true }; await f.paint(); assert(!f.container.textContent.includes('obsolete-active'));
        await f.click('処理記録を読み込む'); assert.match(f.container.textContent, /match-resumed/);
        f.props = { ...f.props, traceHistory: indexed('unmount-run') }; await f.paint(); await open(f); await f.close(); closed = true;
        afterUnmount.reject(Error('obsolete unmounted request')); await new Promise(resolve => setImmediate(resolve));
    } finally { if (!closed) await f.close(); }
});

const job = (id, extra = {}) => ({ id, runId: `run-${id}`, version: 'version-1', state: 'pending', title: `Notification ${id}`, preview: `Private preview ${id}`, dueAtMs: 1, createdAtMs: 1, providerId: 'github', sentSteps: 0, scope: 'private', trace: [], event: {}, ...extra });
async function delivery(api) {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";'); f.calls = []; f.set('confirm', () => true);
    f.props = { api: async (route, method, body) => { f.calls.push({ route, method, body }); return api(route, method, body); }, canEdit: true };
    f.paint = () => f.render(f.React.createElement(f.exports.DeliveryHistory, f.props)); await f.paint(); await f.settle(); return f;
}
async function selectJob(f, id) { await f.act(async () => f.container.querySelector(`[data-job-id="${id}"]`).click()); await f.settle(); }

test('fifty excluded rows keep trace requests lazy and preserve independent run-list paging', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `run-${i}`, state: 'waiting', event: { title: `Excluded ${i}` }, trace: [{ nodeId: 'history', outcome: 'wait' }], traceHistory: indexed(`run-${i}`) }));
    const f = await delivery(route => route.startsWith('jobs?') ? { items: [], nextCursor: null } : route === 'excluded' ? { items: rows, nextCursor: 'run-after' } : route === 'excluded?afterId=run-after' ? { items: [{ ...rows[0], id: 'last-run', event: { title: 'Last excluded event' }, traceHistory: indexed('last-run') }], nextCursor: null } : page([entry('selected-only')]));
    try {
        await f.click('除外理由を確認'); assert.equal(f.container.querySelectorAll('summary').length, 51); assert.equal(f.calls.filter(call => call.route.startsWith('runs/')).length, 0);
        await open(f, '処理記録を確認', 7); assert.equal(f.calls.filter(call => call.route.startsWith('runs/')).length, 1); assert.equal(f.calls.at(-1).route, 'runs/run-7/trace');
        await f.click('ルールの処理履歴をさらに表示'); assert.match(f.container.textContent, /Excluded 0/); assert.match(f.container.textContent, /Last excluded event/); assert.match(f.container.textContent, /match-selected-only/);
    } finally { await f.close(); }
});

test('trace read failures cannot re-enable a committed job mutation or replay its saved PATCH', async () => {
    let committed = false; const writes = [], row = job('saved', { trace: [entry('before-save')], traceHistory: indexed('retained', { firstPage: true, nextCursor: 'later', sourceRevision: 'revision-A', totalEntries: null }) });
    const f = await delivery((route, method, body) => {
        if (method === 'PATCH') { writes.push(body); committed = true; return { state: 'pending', dueAtMs: 1 }; }
        if (route.startsWith('jobs?')) return { items: [row], nextCursor: null };
        if (route === 'jobs/saved') { if (committed) throw Error('read after saved mutation'); return row; }
        if (route.startsWith('runs/')) throw Object.assign(Error('trace database failure'), { status: 503 });
        assert.fail(route);
    });
    try {
        await selectJob(f, 'saved'); await f.click('配信を取り消す'); assert.equal(writes.length, 1); assert.match(f.container.textContent, /変更は保存済み/);
        await open(f); await f.click('処理記録の続きを読み込む'); assert.match(f.container.textContent, /match-before-save/);
        const cancel = [...f.container.querySelectorAll('button')].find(node => node.textContent === '配信を取り消す'); assert(cancel.matches(':disabled'));
        await f.act(async () => cancel.click()); await f.click('処理記録を再読み込み'); assert.equal(writes.length, 1); assert.equal(writes[0].expectedVersion, 'version-1'); assert.equal(f.calls.filter(call => call.method).length, 1);
    } finally { await f.close(); }
});

test('switching delivery workspace or selected job removes the old private event before old trace errors arrive', async () => {
    const late = deferred(), rows = [job('A'), job('B')], f = await delivery(route => route.startsWith('jobs?') ? { items: rows, nextCursor: null } : route.startsWith('runs/') ? late.promise : { ...rows.find(row => route === `jobs/${row.id}`), traceHistory: indexed(`run-${route.at(-1)}`) });
    try {
        await selectJob(f, 'A'); await open(f); await f.click('配信一覧に戻る'); await selectJob(f, 'B'); assert(!f.container.textContent.includes('Private preview A')); assert.match(f.container.textContent, /Private preview B/);
        f.props = { ...f.props, api: async route => route.startsWith('jobs?') ? { items: [job('new-scope')], nextCursor: null } : assert.fail(route) }; await f.paint();
        assert(!f.container.textContent.includes('Private preview B')); assert(!f.container.textContent.includes('Notification A'));
        await f.act(async () => late.reject(Error('old private diagnostic'))); assert.equal(f.container.querySelector('[role="alert"]'), null); assert.match(f.container.textContent, /Notification new-scope/);
    } finally { await f.close(); }
});

test('monitor activity exposes complete records for both pre-job runs and grouped job detail with read-only requests', async () => {
    const f = await reactFixture('export { MonitorDeliveryActivity } from "./components/automation/monitor-delivery-activity";'); const calls = [];
    const api = async (route, method) => {
        calls.push({ route, method });
        if (route.startsWith('jobs?')) return { items: [job('grouped')], activity: null, nextCursor: null, ruleRuns: [{ id: 'excluded', state: 'expired', created_at_ms: 1, event: { title: 'Expired member' }, trace: [], traceHistory: indexed('expired-source') }], ruleRunsNextCursor: null };
        if (route === 'jobs/grouped') return job('grouped', { aggregateItems: 1, trace: [entry('retained-initial')], traceHistory: indexed('retained-source', { firstPage: true, nextCursor: 'next', sourceRevision: 'revision-A', totalEntries: null }) });
        if (route === 'runs/expired-source/trace') return page([entry('expired-data', { outcome: 'expired', reason: 'DEADLINE_EXCEEDED' })]);
        if (route === 'runs/retained-source/trace?cursor=next') return page([entry('retained-next')]);
        assert.fail(route);
    };
    try {
        await f.render(f.React.createElement(f.exports.MonitorDeliveryActivity, { api, kind: 'x', targetId: '1' })); await open(f, '配信予定・履歴'); assert.equal(calls.filter(call => call.route.startsWith('runs/')).length, 0);
        await open(f, '処理記録を確認'); assert.match(f.container.textContent, /match-expired-data/); assert.match(f.container.textContent, /配信期限を過ぎました/);
        await f.act(async () => [...f.container.querySelectorAll('button')].find(node => node.textContent.includes('Notification grouped')).click()); await open(f);
        assert.equal(calls.filter(call => call.route.startsWith('runs/')).length, 1); await f.click('処理記録の続きを読み込む'); assert.match(f.container.textContent, /match-retained-next/); assert(calls.every(row => !row.method));
    } finally { await f.close(); }
});

test('monitor context replacement clears private run data immediately and fences pending trace errors', async () => {
    const f = await reactFixture('export { MonitorDeliveryActivity } from "./components/automation/monitor-delivery-activity";'), late = deferred(), fresh = deferred();
    const api = async route => route.startsWith('runs/') ? late.promise : route.includes('targetId=2') ? fresh.promise : { items: [], nextCursor: null, ruleRuns: [{ id: 'private-run', state: 'waiting', created_at_ms: 1, event: { title: 'Private old event' }, trace: [], traceHistory: indexed('private-source') }] };
    const props = { api, kind: 'x', targetId: '1' };
    try {
        await f.render(f.React.createElement(f.exports.MonitorDeliveryActivity, props)); await open(f, '配信予定・履歴'); await open(f, '処理記録を確認');
        await f.render(f.React.createElement(f.exports.MonitorDeliveryActivity, { ...props, targetId: '2' })); assert(!f.container.textContent.includes('Private old event'));
        await f.act(async () => late.reject(Error('obsolete private error'))); assert.equal(f.container.querySelector('[role="alert"]'), null);
        await f.act(async () => fresh.resolve({ items: [job('new-monitor')], nextCursor: null })); assert.match(f.container.textContent, /Notification new-monitor/);
    } finally { await f.close(); }
});

test('long match terms and one large legacy diagnostic entry remain complete in the explicit record view', async () => {
    const matches = Array.from({ length: 8 }, (_, i) => ({ term: `${'語'.repeat(250)}終端${i}`, start: i, end: i + 255, category: `分類${i}` }));
    const raw = entry('large', { detail: matches, diagnostic: `${'x'.repeat(300000)}COMPLETE_LAST_BYTE` });
    const f = await fixture(() => page([raw]));
    try {
        await open(f); assert.equal(f.container.querySelectorAll('section[aria-label="一致した語"] li').length, 8); assert.match(f.container.textContent, /終端7/);
        await open(f, '記録のデータ'); const exact = JSON.parse(f.container.querySelector('pre').textContent); assert.deepEqual(exact, raw); assert(exact.diagnostic.endsWith('COMPLETE_LAST_BYTE'));
    } finally { await f.close(); }
});

test('an interrupted excluded-list read becomes usable on reactivation without accepting its obsolete private result', async () => {
    const old = deferred(); let reads = 0;
    const f = await delivery(route => route.startsWith('jobs?') ? { items: [], nextCursor: null } : reads++ === 0 ? old.promise : { items: [{ id: 'fresh', state: 'waiting', event: { title: 'Current context event' }, trace: [] }], nextCursor: null });
    try {
        await f.click('除外理由を確認'); f.props = { ...f.props, active: false }; await f.paint();
        await f.act(async () => old.resolve({ items: [{ id: 'old', event: { title: 'Obsolete excluded private event' }, trace: [] }], nextCursor: null }));
        f.props = { ...f.props, active: true }; await f.paint(); const control = [...f.container.querySelectorAll('button')].find(node => node.textContent === '除外理由を確認'); assert(!control.matches(':disabled'));
        await f.click('除外理由を確認'); assert.match(f.container.textContent, /Current context event/); assert(!f.container.textContent.includes('Obsolete excluded'));
    } finally { await f.close(); }
});
