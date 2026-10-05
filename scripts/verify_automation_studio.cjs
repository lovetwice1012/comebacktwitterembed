'use strict';

// Run only against your own scripts/automation-ui-harness.js instance.
// Uses a fresh browser context and the fixture's disposable SQL schema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
process.env.NODE_ENV = 'test';
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'node_modules/.cache/ux-browser');
const { chromium, expect } = require('../design-previews/qa/node_modules/playwright/test');
const { NODE_TYPES, assertWorkflow } = require('../src/automation/schema');
const { stringifyWorkflow, parseWorkflow } = require('../src/automation/format');
const fixture = new URL(process.env.AUTOMATION_AUDIT_UI_URL || '');
if (fixture.hostname !== '127.0.0.1' || fixture.protocol !== 'http:' || !fixture.port) throw new Error('Explicit loopback fixture required');
const folder = path.join(root, 'docs/audits/completion/studio-ux');
fs.mkdirSync(folder, { recursive: true });
const clone = value => structuredClone(value);
function complexRule() {
    const node = (id, type, config = {}, x = 0, y = 0) => ({ id, type, config: { ...clone(NODE_TYPES[type].defaults), ...config }, position: { x, y } });
    const nodes = [node('start', 'start', {}, 40, 60), node('filter', 'condition', { predicate: { op: 'all', conditions: [
        { op: 'any', conditions: [{ field: 'title', op: 'contains', value: 'sale', ignoreCase: true }, { field: 'discountPercent', op: 'gte', value: 30 }] },
        { op: 'not', conditions: [{ field: 'sensitive', op: 'eq', value: true }] },
    ] } }, 300, 60), node('waitA', 'delay', { minutes: 30 }, 570, 60), node('waitB', 'delay', { minutes: 60 }, 570, 260),
    node('reject', 'stop', { reason: '条件に不一致' }, 570, 460), node('missing', 'stop', { reason: '必要なデータが不明' }, 570, 660),
    node('merge', 'merge', { mode: 'all' }, 840, 60), node('time', 'schedule', { windows: [{ start: '09:00', end: '23:00' }], quiet: [{ start: '22:00', end: '09:00' }], datesExcluded: ['2026-09-22'] }, 1110, 60),
    node('limit', 'limit', { count: 3 }, 1380, 60), node('aggregate', 'aggregate', { minutes: 15, maxItems: 5 }, 1650, 60),
    node('display', 'transform', { format: 'text', template: '{title}\n{url}' }, 1920, 60), node('send', 'send', {}, 2190, 60)];
    for (const n of nodes) if (['display', 'send'].includes(n.id)) n.group = 'delivery';
    const connections = [['start', 'filter', 'out'], ['filter', 'waitA', 'yes'], ['filter', 'waitB', 'yes'], ['filter', 'reject', 'no'], ['filter', 'missing', 'unknown'], ['waitA', 'merge', 'out'], ['waitB', 'merge', 'out'], ['merge', 'time', 'out'], ['time', 'limit', 'out'], ['limit', 'aggregate', 'out'], ['aggregate', 'display', 'out'], ['display', 'send', 'out']];
    return assertWorkflow({ schemaVersion: 1, name: '複雑なスタジオ検証', description: 'AND / OR / NOT・3経路・合流・静穏時間・部品', expiresAfterMinutes: 4320, nodes,
        edges: connections.map(([source, target, port], i) => ({ id: `e${i}`, source, target, port })), layout: { groups: [{ id: 'delivery', label: '表示と通知', collapsed: false }], viewport: { x: 30, y: 20, zoom: 0.5 } } });
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const result = { at: new Date().toISOString(), fixtureOnly: true, realMessages: 0, checks: [], uxChecks: [], measurements: {}, pageErrors: [], blockedRequests: [], simulations: [], backendFindings: [],
        boundary: 'GUI/schema roundtrip and pure simulation only. Stateful limit/aggregate execution order, grouped output format and cross-target/path grouping remain parent-owned engine/queue work.' };
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
        result.blockedRequests.push(route.request().url()); return route.abort();
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage();
    let touchContext, mobile;
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => result.pageErrors.push(error.stack));
    page.on('dialog', dialog => dialog.accept());
    const button = name => page.getByRole('button', { name, exact: true });
    const select = name => page.getByRole('combobox', { name, exact: true });
    const text = page.getByRole('textbox', { name: 'ルールJSONまたはYAML', exact: true });
    const ready = () => expect(button('下書きを保存')).toBeEnabled({ timeout: 15000 });
    const check = name => { assert.deepEqual(result.pageErrors, []); result.checks.push(name); console.log(`PASS ${name}`); };
    const uxCheck = name => { assert.deepEqual(result.pageErrors, []); result.uxChecks.push(name); console.log(`UX PASS ${name}`); };
    const graph = async () => { await button('ブロック').click(); };
    const focus = async id => { await graph(); await select('編集するブロック').selectOption(id); };
    const openDetails = async name => {
        const summary = page.locator('summary').getByText(name, { exact: true });
        const details = page.locator('details').filter({ has: summary });
        if (await details.getAttribute('open') === null) await summary.click();
    };
    const addBlock = async name => { await openDetails('ブロックを追加'); await button(name).click(); };
    const condition = async address => {
        await button('条件 全体 を編集').click();
        if (address === '全体') return;
        const parts = address.split('.');
        for (let i = 1; i <= parts.length; i++) await button(`条件 ${parts.slice(0, i).join('.')} を編集`).click();
    };
    const definition = async () => {
        await button('テキスト').click();
        await expect(text).not.toHaveValue('');
        return parseWorkflow(await text.inputValue(), await select('テキスト形式').inputValue());
    };
    const importRule = async (rule, format = 'yaml', source) => {
        await page.getByLabel('ルールをインポート', { exact: true }).setInputFiles({ name: `studio.${format}`, mimeType: 'text/plain', buffer: Buffer.from(source || stringifyWorkflow(rule, format)) });
        await ready();
        await expect(page.getByRole('textbox', { name: 'ルール名', exact: true })).toHaveValue(rule.name);
    };
    const download = async (name, artifactName) => {
        if (name === 'エクスポート') await openDetails('配置・入出力');
        const pending = page.waitForEvent('download'); await button(name).click(); const item = await pending;
        const target = path.join(folder, artifactName || item.suggestedFilename()); await item.saveAs(target); return fs.readFileSync(target, 'utf8');
    };
    const simulator = page.locator('details').filter({ has: page.locator('summary').getByText('動きをテスト（実送信なし）', { exact: true }) });
    const simulate = async (event, time = '2026-09-21T21:30') => {
        await openDetails('動きをテスト（実送信なし）');
        await button('JSON入力').click();
        await page.getByRole('textbox', { name: 'テストイベントJSON', exact: true }).fill(JSON.stringify(event, null, 2));
        await page.getByLabel('判定時刻（空欄は現在、入力時はブラウザのタイムゾーン）', { exact: true }).fill(time);
        await expect(button('判定する')).toBeEnabled();
        const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/automation/simulate');
        await button('判定する').click(); const response = await pending;
        assert.equal(response.status(), 200, await response.text());
        const data = await response.json(); result.simulations.push({ request: response.request().postDataJSON(), time, result: data });
        await expect(simulator.getByRole('status')).toContainText('ルールの判定結果');
        return data;
    };
    try {
        await page.goto(fixture.href);
        await button('スタジオ').click();
        await button('新しいルール').click(); await ready();
        const base = complexRule();
        fs.writeFileSync(path.join(folder, 'complex-rule.json'), JSON.stringify(base, null, 2) + '\n');
        await importRule(base); assert.deepEqual(await definition(), base);
        check('12-block nested workflow imported with exact topology, group, positions and viewport');

        await focus('filter');
        const modes = select('条件の組み立て');
        await modes.first().selectOption('any'); await ready();
        let changed = await definition(); assert.deepEqual(changed.nodes[1].config.predicate.conditions, base.nodes[1].config.predicate.conditions);
        await focus('filter'); await modes.first().selectOption('not'); await ready();
        changed = await definition(); assert.equal(changed.nodes[1].config.predicate.conditions[0].op, 'any');
        assert.deepEqual(changed.nodes[1].config.predicate.conditions[0].conditions, base.nodes[1].config.predicate.conditions);
        await focus('filter'); await expect(modes.first().locator('option[value="compare"]')).toHaveAttribute('disabled', '');
        await button('元に戻す').click(); await ready(); await button('元に戻す').click(); await ready();
        assert.deepEqual((await definition()).nodes[1].config, base.nodes[1].config);
        check('AND to OR to NOT preserves the entire nested tree; one-step undo restores each operation');

        await focus('filter');
        await condition('1.1');
        await select('比較方法').first().selectOption('in'); await ready();
        await expect(page.getByRole('textbox', { name: '候補 1', exact: true })).toHaveValue('sale');
        await button('候補を追加').click();
        await page.getByRole('textbox', { name: '候補 2', exact: true }).fill('release'); await ready();
        await condition('1.2'); await select('比較方法').selectOption('lte'); await ready();
        await expect(page.getByRole('spinbutton', { name: '比較する値', exact: true })).toHaveValue('30');
        changed = await definition();
        assert.deepEqual(changed.nodes[1].config.predicate.conditions[0].conditions[0].value, ['sale', 'release']);
        check('GUI candidate-list and numeric-operator edits retain existing values');

        const commented = '# Studio notes: keep formatting and comments\n' + stringifyWorkflow(changed, 'yaml');
        await text.fill(commented); await ready();
        await graph(); await button('テキスト').click(); assert.equal(await text.inputValue(), commented);
        assert.equal(await download('エクスポート', 'source-with-comments.yaml'), commented);
        const revised = commented.replace('Studio notes:', 'Revised notes:'); await text.fill(revised); await ready();
        await button('元に戻す').click(); await ready(); assert.equal(await text.inputValue(), commented);
        await button('やり直す').click(); await ready(); assert.equal(await text.inputValue(), revised);
        check('valid YAML comments and formatting survive view switches, file export, undo and redo');
        await select('テキスト形式').selectOption('json'); await ready(); assert.deepEqual(await definition(), changed);
        await graph(); await button('テキスト').click(); assert.deepEqual(await definition(), changed);
        await select('テキスト形式').selectOption('yaml'); await ready(); assert.deepEqual(await definition(), changed);
        check('GUI to JSON to GUI to YAML preserves nested predicates, layout and every edge');

        await text.fill('nodes: [unfinished');
        await expect(button('下書きを保存')).toBeDisabled();
        await expect(select('テキスト形式')).toBeDisabled();
        await expect(page.getByLabel('ルールをインポート', { exact: true })).toBeDisabled();
        await graph(); await openDetails('ブロックを追加'); await expect(button('遅延')).toBeDisabled(); await button('テキスト').click();
        assert.equal(await text.inputValue(), 'nodes: [unfinished');
        assert.equal(await download('エクスポート', 'invalid-preserved.yaml'), 'nodes: [unfinished');
        await text.fill(stringifyWorkflow(base, 'yaml')); await ready(); assert.deepEqual(await definition(), base);
        check('invalid text stays recoverable and exportable, locks conflicting edits, and can be repaired without graph loss');

        let releaseValidation, validationArrived, validationCompleted;
        const held = new Promise(resolve => { releaseValidation = resolve; });
        const arrived = new Promise(resolve => { validationArrived = resolve; });
        const completed = new Promise(resolve => { validationCompleted = resolve; });
        const delayValidation = async route => {
            if (!route.request().postDataJSON()?.text?.includes('delayed-studio-validation')) return route.fallback();
            const response = await route.fetch(); validationArrived(); await held; await route.fulfill({ response }); validationCompleted();
        };
        await page.route('**/api/automation/validate**', delayValidation);
        await text.fill(stringifyWorkflow({ ...base, name: 'delayed-studio-validation' }, 'yaml'));
        await arrived;
        await text.fill('nodes: [newer invalid edit'); releaseValidation(); await completed;
        await expect(button('下書きを保存')).toBeDisabled(); await expect(text).toHaveValue('nodes: [newer invalid edit');
        await page.unroute('**/api/automation/validate**', delayValidation);
        await text.fill(stringifyWorkflow(base, 'yaml')); await ready();
        check('injected delayed validation response cannot overwrite a newer invalid text edit');

        const samples = [
            [{ title: 'SALE', sensitive: false }, 'yes'],
            [{ title: 'news', discountPercent: 50, sensitive: false }, 'yes'],
            [{ title: 'news', discountPercent: 0, sensitive: false }, 'no'],
            [{ title: 'sale', sensitive: true }, 'no'],
            [{ title: 'news', sensitive: false }, 'unknown'],
            [{ title: 'sale' }, 'unknown'],
        ];
        for (const [sample, expected] of samples) {
            const evaluated = await simulate({ providerId: 'steam', kind: 'price', url: 'https://store.steampowered.com/app/730/', ...sample });
            assert.equal(evaluated.trace.find(row => row.nodeId === 'filter').outcome, expected);
            assert.equal(evaluated.outputs.length, expected === 'yes' ? 1 : 0);
            if (expected === 'yes') {
                assert.equal(evaluated.trace.find(row => row.outcome === 'merged').arrivals, 2);
                assert.equal(new Date(evaluated.outputs[0].dueAtMs).toISOString(), '2026-09-23T00:00:00.000Z');
                assert.equal(evaluated.outputs[0].limits[0].count, 3); assert.equal(evaluated.outputs[0].aggregate.maxItems, 5);
            }
        }
        check('six real API simulations cover nested AND/OR/NOT yes/no/unknown, explicit all-merge, delay, overnight quiet hours, exclusion date, limit and aggregation');
        await page.screenshot({ path: path.join(folder, 'three-way-simulation.png'), fullPage: true });

        await page.getByRole('textbox', { name: 'テストイベントJSON', exact: true }).fill('{broken');
        await expect(button('判定する')).toBeDisabled(); await expect(simulator.getByRole('status')).toHaveCount(0);
        await button('入力フォーム').click(); await expect(button('判定する')).toBeDisabled();
        await button('JSON入力').click(); await expect(page.getByLabel('テストイベントJSON')).toHaveValue('{broken');
        check('invalid simulator JSON cannot evaluate an old event and survives switching input modes');

        await focus('time');
        await page.getByRole('button', { name: '2026-09-22 ×', exact: true }).click(); await ready();
        await page.getByLabel('windows start', { exact: true }).fill('10:00'); await ready();
        const scheduled = await simulate({ title: 'sale', sensitive: false });
        assert.equal(new Date(scheduled.outputs[0].dueAtMs).toISOString(), '2026-09-22T01:00:00.000Z');
        check('GUI schedule edits change the simulator due time while preserving quiet hours');

        await focus('waitB'); await addBlock('条件分岐');
        await page.getByRole('textbox', { name: '比較する値', exact: true }).fill('bonus'); await ready();
        const allMissing = await simulate({ title: 'sale', sensitive: false });
        assert.equal(allMissing.outputs.length, 0);
        assert.equal(allMissing.trace.find(row => row.nodeId === 'merge').outcome, 'excluded');
        await focus('merge'); await select('合流の条件').selectOption('any'); await ready();
        const anyMatched = await simulate({ title: 'sale', sensitive: false });
        assert.equal(anyMatched.outputs.length, 1); assert.equal(anyMatched.trace.find(row => row.outcome === 'merged').arrivals, 1);
        const bothMatched = await simulate({ title: 'sale bonus', sensitive: false });
        assert.equal(bothMatched.outputs.length, 1); assert.equal(bothMatched.trace.find(row => row.outcome === 'merged').arrivals, 2);
        check('GUI insertion of an asymmetric branch distinguishes all-merge from any-merge without duplicate output');

        await focus('display'); await select('表示形式').selectOption('url'); await ready();
        const urlOnly = await simulate({ title: 'sale', sensitive: false, url: 'https://example.com/item' });
        assert.equal(urlOnly.outputs[0].text, 'https://example.com/item'); assert.equal(urlOnly.outputs[0].display.format, 'url');
        check('URL-only display uses the original URL with no second expansion');

        await focus('display');
        await openDetails('グループ・再利用部品');
        const groupRow = page.locator('[data-group-id="delivery"]');
        await groupRow.getByRole('button', { name: '折りたたむ', exact: true }).click(); await ready();
        await expect(page.locator('.react-flow__node[data-id="__group:delivery"]')).toHaveCount(1);
        assert.equal((await definition()).layout.groups[0].collapsed, true);
        await focus('display'); await openDetails('グループ・再利用部品'); await expect(page.locator('.react-flow__node[data-id="display"]')).toHaveCount(1);
        await groupRow.getByRole('button', { name: '折りたたむ', exact: true }).click(); await ready();
        await page.locator('.react-flow__node[data-id="__group:delivery"]').getByRole('button', { name: '開く', exact: true }).click(); await ready();
        assert.equal((await definition()).layout.groups[0].collapsed, false);
        check('collapsed groups can be focused by block selector and opened with persistent layout state');

        await focus('display'); await openDetails('グループ・再利用部品');
        const fragmentText = await download('部品を出力'); const fragment = JSON.parse(fragmentText);
        assert.deepEqual(fragment.nodes.map(n => n.id), ['display', 'send']); assert.equal(fragment.edges.length, 1);
        await groupRow.getByRole('button', { name: '部品として複製', exact: true }).click();
        await expect(select('編集するブロック')).not.toHaveValue('display');
        const firstCopy = await select('編集するブロック').inputValue();
        await expect(button('下書きを保存')).toBeDisabled();
        await page.getByText('キーボード・タッチ用の接続操作', { exact: true }).click();
        await select('接続元').selectOption('aggregate'); await select('接続先').selectOption(firstCopy); await button('接続する').click(); await ready();
        await page.getByLabel('部品を読み込む', { exact: true }).setInputFiles({ name: 'fragment.json', mimeType: 'application/json', buffer: Buffer.from(fragmentText) });
        await expect(select('編集するブロック')).not.toHaveValue(firstCopy);
        const secondCopy = await select('編集するブロック').inputValue();
        await select('接続先').selectOption(secondCopy); await button('接続する').click(); await ready();
        changed = await definition();
        assert.equal(changed.nodes.length, 17); assert.equal(changed.layout.groups.length, 3);
        assert.equal(new Set(changed.nodes.map(n => n.id)).size, changed.nodes.length);
        assert(changed.nodes.find(n => n.id === secondCopy).position.x > changed.nodes.find(n => n.id === firstCopy).position.x);
        const copies = await simulate({ title: 'sale', sensitive: false, url: 'https://example.com/item' });
        assert.equal(copies.outputs.length, 3);
        check('fragment export, duplicate and file import remap IDs and internal edges, use distinct positions and require explicit reconnection');

        await focus(secondCopy); await openDetails('ブロックの操作'); await page.locator('.automation-studio-inspector').getByRole('button', { name: '複製', exact: true }).click();
        const singleCopy = await select('編集するブロック').inputValue(); assert.notEqual(singleCopy, secondCopy);
        await expect(page.locator(`.react-flow__node[data-id="${singleCopy}"]`)).toHaveClass(/selected/);
        await button('元に戻す').click(); await ready(); await button('やり直す').click();
        await expect(button('下書きを保存')).toBeDisabled(); await button('元に戻す').click(); await ready();
        check('single-block duplicate is selected and focused, and undo/redo preserves detached-draft validity');

        await focus('display');
        const node = page.locator('.react-flow__node[data-id="display"]');
        await node.click(); await page.keyboard.press('Delete');
        await expect(node).toHaveCount(0); await button('元に戻す').click(); await ready();
        assert.deepEqual((await definition()).edges, changed.edges);
        check('keyboard delete and one undo restore the node and all its connections together');
        await focus('start'); await page.locator('.react-flow__node[data-id="start"]').click(); await page.keyboard.press('Delete'); await ready();
        assert.deepEqual((await definition()).edges, changed.edges);
        check('Delete cannot remove the start block or its outgoing connections');

        await focus('filter');
        const edge = page.locator('.react-flow__edge[data-id="e0"]');
        await edge.focus(); await page.keyboard.press('Enter'); await expect(edge).toHaveClass(/selected/);
        await page.keyboard.press('Delete'); await expect(edge).toHaveCount(0);
        await button('元に戻す').click(); await ready(); assert.deepEqual((await definition()).edges, changed.edges);
        check('keyboard selection and deletion of an edge is undoable without losing other topology');

        await focus('filter');
        const block = page.locator('.react-flow__node[data-id="filter"]');
        const beforeMove = (await definition()).nodes.find(n => n.id === 'filter').position;
        await focus('filter'); await block.click(); await expect(block).toHaveClass(/selected/); await block.press('ArrowRight'); await ready();
        const moved = (await definition()).nodes.find(n => n.id === 'filter').position;
        assert(moved.x > beforeMove.x); await button('元に戻す').click(); await ready();
        assert.deepEqual((await definition()).nodes.find(n => n.id === 'filter').position, beforeMove);
        check('keyboard block movement has an undo checkpoint');

        await focus('filter');
        const dragStart = await block.boundingBox();
        const dragOriginal = (await definition()).nodes.find(n => n.id === 'filter').position;
        await focus('filter');
        const dragBox = await block.boundingBox(); assert(dragStart && dragBox);
        await page.mouse.move(dragBox.x + 30, dragBox.y + 30); await page.mouse.down();
        await page.mouse.move(dragBox.x + 100, dragBox.y + 80, { steps: 8 }); await page.mouse.up(); await ready();
        const dragged = (await definition()).nodes.find(n => n.id === 'filter').position;
        assert.notDeepEqual(dragged, dragOriginal); await button('元に戻す').click(); await ready();
        assert.deepEqual((await definition()).nodes.find(n => n.id === 'filter').position, dragOriginal);
        check('pointer drag gesture is restored by one undo without intermediate position checkpoints');

        await focus('waitA');
        await page.locator('.react-flow__node[data-id="waitA"]').click();
        await page.locator('.react-flow__node[data-id="waitB"]').click({ modifiers: ['Shift'] });
        await openDetails('グループ・再利用部品'); await page.getByLabel('新しいグループ名', { exact: true }).fill('待機部品');
        await button('選択ブロックをグループ化').click(); await ready();
        let grouped = await definition();
        const createdGroup = grouped.layout.groups.find(g => g.label === '待機部品'); assert(createdGroup);
        assert.deepEqual(grouped.nodes.filter(n => n.group === createdGroup.id).map(n => n.id), ['waitA', 'waitB']);
        assert.deepEqual(grouped.edges, changed.edges);
        await focus('waitA'); await openDetails('グループ・再利用部品');
        await page.locator(`[data-group-id="${createdGroup.id}"]`).getByRole('button', { name: 'グループ解除', exact: true }).click(); await ready();
        grouped = await definition(); assert(!grouped.nodes.some(n => n.group === createdGroup.id)); assert.deepEqual(grouped.edges, changed.edges);
        check('Shift multi-selection creates a group and ungrouping preserves every node and edge');
        await focus('display'); await openDetails('グループ・再利用部品');
        const invalidFragment = { ...fragment, edges: [{ id: 'outside', source: 'display', target: 'not_in_fragment', port: 'out' }] };
        await page.getByLabel('部品を読み込む', { exact: true }).setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidFragment)) });
        await expect(page.getByRole('alert')).toContainText('部品の外部への接続');
        assert.deepEqual((await definition()).nodes, grouped.nodes);
        check('malformed fragment import reports its external edge and preserves the current graph');

        const dst = clone(base); dst.name = 'DST schedule test';
        Object.assign(dst.nodes.find(n => n.id === 'time').config, { zone: 'America/New_York', windows: [{ start: '01:30', end: '02:30' }], quiet: [], datesExcluded: [] });
        await importRule(dst);
        const fall = await simulate({ title: 'sale', sensitive: false }, '2026-11-01T13:00');
        assert.equal(new Date(fall.outputs[0].dueAtMs).toISOString(), '2026-11-01T05:30:00.000Z');
        await focus('time'); await page.getByLabel('windows end', { exact: true }).fill('03:30'); await ready();
        await page.getByLabel('windows start', { exact: true }).fill('02:30'); await ready();
        const spring = await simulate({ title: 'sale', sensitive: false }, '2026-03-08T14:30');
        assert.equal(new Date(spring.outputs[0].dueAtMs).toISOString(), '2026-03-08T07:00:00.000Z');
        check('DST repeated hour chooses the earliest instant and a partially missing window retains its real portion');
        await focus('time'); await page.getByLabel('windows start', { exact: true }).fill('00:00'); await ready();
        await page.getByLabel('windows end', { exact: true }).fill('00:00'); await ready();
        await button('時間帯を追加').nth(1).click(); await ready();
        await page.getByLabel('quiet start', { exact: true }).fill('02:30'); await ready();
        await page.getByLabel('quiet end', { exact: true }).fill('04:00'); await ready();
        const quietGap = await simulate({ title: 'sale', sensitive: false }, '2026-03-08T15:30');
        const quietDue = new Date(quietGap.outputs[0].dueAtMs).toISOString();
        assert.equal(quietDue, '2026-03-08T08:00:00.000Z');
        check('fixed DST quiet-hour boundary defers local 03:30 to 04:00 through GUI/API');

        await focus('waitA'); await select('時間の基準').selectOption('published'); await ready();
        const unknownPublished = await simulate({ title: 'sale', sensitive: false });
        assert.equal(unknownPublished.outputs.length, 0);
        assert.equal(unknownPublished.trace.find(row => row.nodeId === 'waitA').outcome, 'unknown');
        check('published-time delay with unavailable publication time remains unknown and cannot satisfy an all-merge');

        await importRule(base);
        await focus('aggregate'); await addBlock('件数制限');
        await page.getByRole('spinbutton', { name: '件数上限', exact: true }).fill('7'); await ready();
        const afterAggregateLimit = await select('編集するブロック').inputValue();
        await addBlock('まとめ通知');
        await select('まとめる単位').selectOption('providerId'); await select('通知する内容').selectOption('latest'); await ready();
        const secondAggregate = await select('編集するブロック').inputValue();
        await addBlock('件数制限'); await page.getByRole('spinbutton', { name: '件数上限', exact: true }).fill('9'); await ready();
        const finalLimit = await select('編集するブロック').inputValue();
        const statefulDraft = await definition();
        const order = ['limit', 'aggregate', afterAggregateLimit, secondAggregate, finalLimit, 'display'];
        for (let i = 1; i < order.length; i++) assert(statefulDraft.edges.some(e => e.source === order[i - 1] && e.target === order[i]));
        assert.equal(statefulDraft.nodes.filter(n => n.type === 'aggregate').length, 2);
        await select('テキスト形式').selectOption('json'); await ready(); assert.deepEqual(await definition(), statefulDraft);
        await graph(); await button('テキスト').click(); await select('テキスト形式').selectOption('yaml'); await ready(); assert.deepEqual(await definition(), statefulDraft);
        check('GUI permits multiple aggregates and limits before/after them; JSON/YAML roundtrip preserves every stage and connection order (runtime semantics owned by parent)');
        fs.writeFileSync(path.join(folder, 'multi-stage-rule.json'), JSON.stringify(statefulDraft, null, 2) + '\n');
        const commentedPackage = '# Package source\n' + stringifyWorkflow(statefulDraft, 'yaml'); await text.fill(commentedPackage); await ready();
        await button('下書きを保存').click(); await ready();
        const packageText = await download('共有用エクスポート');
        const packageData = JSON.parse(packageText); fs.writeFileSync(path.join(folder, 'package-roundtrip.json'), packageText);
        await button('ルール一覧へ').click();
        const [importedResponse] = await Promise.all([
            page.waitForResponse(r => new URL(r.url()).pathname === '/api/automation/import' && !r.request().postDataJSON().preview),
            page.locator('label').filter({ hasText: 'パッケージをインポート' }).locator('input[type=file]').setInputFiles({ name: 'package.json', mimeType: 'application/json', buffer: Buffer.from(packageText) }),
        ]);
        assert.equal(importedResponse.status(), 200, await importedResponse.text()); await ready();
        const importedDefinition = await definition(); assert.deepEqual(importedDefinition.nodes, statefulDraft.nodes); assert.deepEqual(importedDefinition.edges, statefulDraft.edges); assert.deepEqual(importedDefinition.layout, statefulDraft.layout);
        assert(packageData); check('saved complex rule exports as a package and reimports as a draft with topology, settings and layout intact');

        await focus('merge'); await page.screenshot({ path: path.join(folder, 'studio-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await focus('filter'); await page.screenshot({ path: path.join(folder, 'studio-mobile.png'), fullPage: true });
        assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        check('complex nested-condition studio remains operable without page overflow at 390px');

        await page.setViewportSize({ width: 1440, height: 1000 });
        await importRule(base); await focus('filter');
        const summary = page.locator('.automation-condition-summary');
        for (const operator of ['AND', 'OR', 'NOT']) await expect(summary).toContainText(operator);
        await expect(page.locator('.automation-condition-outcomes')).toContainText('unknown');
        await expect(page.locator('[data-predicate-editor]')).toHaveCount(1);
        await expect(page.locator('[data-condition-path]')).toHaveCount(3);
        await condition('1.2');
        await expect(select('比較方法')).toHaveCount(1);
        await expect(page.getByRole('spinbutton', { name: '比較する値', exact: true })).toHaveValue('30');
        await button('条件 1 の子条件').click();
        await expect(button('条件 1 の子条件')).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByRole('group', { name: '条件 1.2 の設定', exact: true })).toBeVisible();
        await expect(page.locator('[data-predicate-editor]')).toHaveCount(1);
        assert.deepEqual((await definition()).nodes[1].config.predicate, base.nodes[1].config.predicate);
        uxCheck('compact operator summary and collapsible outline retain unknown semantics and one selected editor without changing the predicate');

        await focus('filter');
        await button('条件 全体 を編集').press('Delete');
        await button('条件 全体 を編集').press('Backspace');
        await button('全体を表示').press('Delete');
        await button('元に戻す').focus(); await page.keyboard.press('Backspace');
        assert.deepEqual((await definition()).nodes, base.nodes);
        uxCheck('Delete/Backspace in condition navigation and tool controls cannot delete the selected graph block');

        await focus('filter'); await condition('1'); await button('条件を追加').click();
        await page.getByRole('textbox', { name: '比較する値', exact: true }).fill('new child'); await ready();
        await expect(page.getByRole('group', { name: '条件 1.3 の設定', exact: true })).toBeVisible();
        await button('条件を削除').click(); await ready();
        assert.deepEqual((await definition()).nodes[1].config.predicate, base.nodes[1].config.predicate);
        uxCheck('adding a child opens only that new condition; deleting it returns to its parent without affecting siblings');

        const deep = clone(base); deep.name = '深い条件の操作検証';
        let nested = { field: 'title', op: 'contains', value: 'deep value' };
        for (let i = 0; i < 6; i++) nested = { op: ['all', 'any', 'not'][i % 3], conditions: [nested] };
        deep.nodes[1].config.predicate.conditions[0] = nested;
        await importRule(deep); await focus('filter'); await condition('1.1.1.1.1.1.1');
        await expect(page.getByRole('textbox', { name: '比較する値', exact: true })).toHaveValue('deep value');
        await expect(page.locator('[data-predicate-editor]')).toHaveCount(1);
        assert((await page.locator('.automation-condition-tree').boundingBox()).height <= 225);
        assert.deepEqual((await definition()).nodes[1].config.predicate, deep.nodes[1].config.predicate);
        uxCheck('seven levels remain reachable in a bounded outline without rendering seven nested forms or rewriting the tree');
        await importRule(base);

        await focus('filter');
        const palette = page.locator('.automation-studio-palette'), advanced = page.locator('.automation-advanced');
        if (await palette.getAttribute('open') !== null) await palette.locator('summary').click();
        if (await advanced.getAttribute('open') !== null) await advanced.locator('summary').click();
        await expect(button('エクスポート')).toHaveCount(0);
        await palette.locator('summary').focus(); await page.keyboard.press('Enter');
        for (const purpose of ['判定・分岐', '時間・件数', '表示・通知']) await expect(page.getByRole('group', { name: purpose, exact: true })).toBeVisible();
        await palette.locator('summary').press('Enter');
        await advanced.locator('summary').focus(); await page.keyboard.press('Enter');
        await expect(button('エクスポート')).toBeVisible();
        await expect(button('インポート')).toBeEnabled();
        const chooserPromise = page.waitForEvent('filechooser'); await button('インポート').focus(); await page.keyboard.press('Enter'); const chooser = await chooserPromise;
        assert.equal(chooser.isMultiple(), false);
        await chooser.setFiles({ name: 'keyboard-import.yaml', mimeType: 'text/plain', buffer: Buffer.from(stringifyWorkflow(base, 'yaml')) }); await ready();
        await graph(); await advanced.locator('summary').click();
        uxCheck('keyboard-operated purpose groups and advanced disclosure expose layout/export and a working import button');

        await focus('filter'); await button('全体を表示').click();
        const withinCanvas = async () => page.evaluate(() => {
            const canvas = globalThis.document.querySelector('.react-flow').getBoundingClientRect();
            return [...globalThis.document.querySelectorAll('.react-flow__node')].every(node => {
                const box = node.getBoundingClientRect();
                return box.left >= canvas.left - 2 && box.right <= canvas.right + 2 && box.top >= canvas.top - 2 && box.bottom <= canvas.bottom + 2;
            });
        });
        await expect.poll(withinCanvas).toBe(true);
        await page.screenshot({ path: path.join(folder, 'desktop-overview.png'), fullPage: true });
        await button('選択を表示').click();
        const selectedIsVisible = () => page.evaluate(() => {
            const canvas = globalThis.document.querySelector('.react-flow').getBoundingClientRect(), node = globalThis.document.querySelector('.react-flow__node.selected');
            if (!node) return false;
            const b = node.getBoundingClientRect(); return b.left >= canvas.left && b.right <= canvas.right && b.top >= canvas.top && b.bottom <= canvas.bottom;
        });
        await expect.poll(selectedIsVisible).toBe(true);
        await expect(select('編集するブロック')).toHaveValue('filter');
        uxCheck('fit-all includes every node and selection focus restores the chosen block without changing selection');

        await condition('1.2');
        result.measurements.desktop = await page.evaluate(() => ({ width: globalThis.innerWidth, pageHeight: globalThis.document.documentElement.scrollHeight, inspectorHeight: globalThis.document.querySelector('.automation-studio-inspector').getBoundingClientRect().height, minimap: { width: globalThis.document.querySelector('.automation-studio-minimap').getBoundingClientRect().width, height: globalThis.document.querySelector('.automation-studio-minimap').getBoundingClientRect().height } }));
        await page.screenshot({ path: path.join(folder, 'studio-desktop.png'), fullPage: true });
        await page.locator('.automation-studio-grid').screenshot({ path: path.join(folder, 'desktop-editing-detail.png') });

        // A separate touch context checks actual taps, not just a narrow desktop viewport.
        touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block', isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        await touchContext.route('**/*', route => {
            if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
            result.blockedRequests.push(route.request().url()); return route.abort();
        });
        await touchContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
        mobile = await touchContext.newPage();
        mobile.on('pageerror', error => result.pageErrors.push(error.stack));
        mobile.on('dialog', dialog => dialog.accept());
        const tapButton = name => mobile.getByRole('button', { name, exact: true });
        await mobile.goto(fixture.href); await tapButton('スタジオ').tap(); await tapButton('新しいルール').tap();
        await expect(tapButton('下書きを保存')).toBeEnabled();
        await mobile.getByLabel('ルールをインポート', { exact: true }).setInputFiles({ name: 'touch.yaml', mimeType: 'text/plain', buffer: Buffer.from(stringifyWorkflow(base, 'yaml')) });
        await expect(tapButton('下書きを保存')).toBeEnabled(); await tapButton('ブロック').tap();
        await mobile.getByRole('combobox', { name: '編集するブロック', exact: true }).selectOption('filter');
        await expect(mobile.locator('.automation-studio-minimap')).toBeHidden();
        await tapButton('全体を表示').tap();
        await expect.poll(() => mobile.evaluate(() => {
            const c = globalThis.document.querySelector('.react-flow').getBoundingClientRect();
            return [...globalThis.document.querySelectorAll('.react-flow__node')].every(n => { const b = n.getBoundingClientRect(); return b.left >= c.left - 2 && b.right <= c.right + 2 && b.top >= c.top - 2 && b.bottom <= c.bottom + 2; });
        })).toBe(true);
        await mobile.screenshot({ path: path.join(folder, 'mobile-overview.png'), fullPage: true });
        await tapButton('選択を表示').tap();
        await expect.poll(() => mobile.evaluate(() => {
            const c = globalThis.document.querySelector('.react-flow').getBoundingClientRect(), b = globalThis.document.querySelector('.react-flow__node[data-id="filter"]').getBoundingClientRect();
            return b.left >= c.left && b.right <= c.right && b.top >= c.top && b.bottom <= c.bottom;
        })).toBe(true);
        uxCheck('390px touch canvas has no minimap overlay; actual taps fit the whole graph and return to the selected node');

        await tapButton('条件 1 を編集').tap(); await tapButton('条件 1.2 を編集').tap();
        await mobile.getByRole('spinbutton', { name: '比較する値', exact: true }).fill('35');
        await expect(tapButton('下書きを保存')).toBeEnabled();
        await expect(mobile.locator('[data-predicate-editor]')).toHaveCount(1);
        await tapButton('元に戻す').tap(); await expect(tapButton('下書きを保存')).toBeEnabled();
        await expect(mobile.getByRole('spinbutton', { name: '比較する値', exact: true })).toHaveValue('30');
        await tapButton('やり直す').tap(); await expect(tapButton('下書きを保存')).toBeEnabled();
        await expect(mobile.getByRole('spinbutton', { name: '比較する値', exact: true })).toHaveValue('35');
        await tapButton('テキスト').tap();
        const mobileDefinition = parseWorkflow(await mobile.getByLabel('ルールJSONまたはYAML', { exact: true }).inputValue(), 'yaml');
        assert.equal(mobileDefinition.nodes[1].config.predicate.conditions[0].conditions[1].value, 35);
        assert.deepEqual(mobileDefinition.nodes[1].config.predicate.conditions[1], base.nodes[1].config.predicate.conditions[1]);
        await tapButton('ブロック').tap(); await tapButton('条件 2 を編集').tap();
        await expect(mobile.getByText('NOTでも情報不足は情報不足のままです。', { exact: true })).toBeVisible();
        uxCheck('touch nested edit, undo/redo and text roundtrip preserve sibling conditions and the explicit NOT/unknown explanation');

        await tapButton('図で確認').tap();
        await expect.poll(() => mobile.evaluate(() => { const c = globalThis.document.querySelector('.react-flow').getBoundingClientRect(), n = globalThis.document.querySelector('.react-flow__node[data-id="filter"]').getBoundingClientRect(); return c.top >= -1 && c.bottom <= globalThis.innerHeight + 1 && n.width > 200; })).toBe(true);
        await mobile.screenshot({ path: path.join(folder, 'mobile-selection-focus.png') });
        uxCheck('the inspector can return directly to a readable selected block inside the mobile viewport after text/graph switching');

        await tapButton('条件 全体 を編集').tap();
        await mobile.evaluate(() => globalThis.scrollTo(0, 0));
        await mobile.screenshot({ path: path.join(folder, 'studio-mobile.png'), fullPage: true });
        await tapButton('条件 1 を編集').tap(); await tapButton('条件 1.2 を編集').tap();
        await mobile.locator('.automation-studio-inspector').screenshot({ path: path.join(folder, 'mobile-editing-detail.png') });
        const targets = mobile.locator('.automation-editor-toolbar button, .automation-editor-tools > details > summary, .automation-fit-actions button, .automation-inspector-heading button, .automation-condition-tree button, .react-flow__controls-button');
        const sizes = await targets.evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(n => ({ label: n.getAttribute('aria-label') || n.textContent, width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height })));
        assert(sizes.every(b => b.width >= 43.5 && b.height >= 43.5), JSON.stringify(sizes));
        assert(await mobile.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        result.measurements.mobile = await mobile.evaluate(() => ({ width: globalThis.innerWidth, pageHeight: globalThis.document.documentElement.scrollHeight, inspectorHeight: globalThis.document.querySelector('.automation-studio-inspector').getBoundingClientRect().height, conditionFormCount: globalThis.document.querySelectorAll('[data-predicate-editor]').length, treeHeight: globalThis.document.querySelector('.automation-condition-tree').getBoundingClientRect().height, minimapDisplay: globalThis.getComputedStyle(globalThis.document.querySelector('.automation-studio-minimap')).display }));
        result.measurements.mobile.tapTargets = sizes;
        uxCheck('primary controls, outline toggles and zoom controls keep 44px tap areas; nested editing has one form, a bounded outline and no horizontal page overflow');

        await tapButton('下書きを保存').tap(); await expect(tapButton('下書きを保存')).toBeEnabled();
        await expect(tapButton('共有用エクスポート')).toBeVisible();
        await mobile.getByRole('combobox', { name: '編集するブロック', exact: true }).selectOption('filter');
        await tapButton('条件 1 を編集').tap(); await tapButton('条件 1.2 を編集').tap();
        await expect(mobile.getByRole('spinbutton', { name: '比較する値', exact: true })).toHaveValue('35');
        await mobile.evaluate(() => globalThis.scrollTo(0, 0));
        await mobile.screenshot({ path: path.join(folder, 'mobile-saved-rule.png'), fullPage: true });
        result.measurements.mobileSaved = await mobile.evaluate(() => ({ pageHeight: globalThis.document.documentElement.scrollHeight, inspectorHeight: globalThis.document.querySelector('.automation-studio-inspector').getBoundingClientRect().height }));
        uxCheck('saved-rule mobile screenshot retains the parent save/apply/history actions and the edited condition');
        await touchContext.tracing.stop({ path: path.join(folder, 'touch-trace.zip') });
        await touchContext.close(); touchContext = null;
        assert.deepEqual(result.blockedRequests, []); result.status = 'passed';
        result.backendStatus = result.backendFindings.length ? 'requires-parent-fix' : 'stateful-runtime-not-verified';
    } catch (error) {
        result.status = 'failed'; result.error = error.stack; process.exitCode = 1;
        await page.screenshot({ path: path.join(folder, 'failure.png'), fullPage: true }).catch(() => {});
        if (mobile && !mobile.isClosed()) await mobile.screenshot({ path: path.join(folder, 'touch-failure.png'), fullPage: true }).catch(() => {});
    } finally {
        if (touchContext) await touchContext.tracing.stop({ path: path.join(folder, 'touch-trace.zip') }).catch(() => {});
        await context.tracing.stop({ path: path.join(folder, 'browser-trace.zip') });
        result.sources = Object.fromEntries(['dashboard/components/automation/rule-editor.tsx', 'dashboard/components/automation/rule-editor-canvas.tsx', 'dashboard/components/automation/event-simulator.tsx', 'dashboard/components/automation/rule-labels.ts', 'dashboard/components/automation/automation.css', 'src/automation/editor-model.js', 'src/automation/schema.js', 'src/automation/engine.js', 'scripts/verify_automation_studio.cjs'].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
        fs.writeFileSync(path.join(folder, 'browser-results.json'), JSON.stringify(result, null, 2) + '\n');
        fs.writeFileSync(path.join(folder, 'README.md'), [
            '# Studio UX and browser verification', '', `Run: ${result.at}`, `Status: ${result.status}; regression checks: ${result.checks.length}; UX checks: ${result.uxChecks.length}; page errors: ${result.pageErrors.length}; external requests: ${result.blockedRequests.length}; real messages: 0.`, '',
            'Executed through an independently started loopback harness and disposable MariaDB fixture. Browser context is new, has no user profile, and blocks requests outside the harness origin.', '',
            '## Checks', '', ...result.checks.map(name => `- ${name}`), '', '## UX checks', '', ...result.uxChecks.map(name => `- ${name}`), '', '## Measurements', '', '```json', JSON.stringify(result.measurements, null, 2), '```', '', '## Boundary / parent dependencies', '', result.boundary, '',
            'The editor retains arbitrary valid node sequences, including multiple aggregates and limits before/after aggregation. It does not rewrite or forbid them. The simulator currently consumes outputs[].destination, dueAtMs, text, limits, aggregate and trace[].nodeId/outcome; coordinate any canonical output contract change with event-simulator.tsx. Package persistence stores the canonical definition; raw YAML comments are preserved in the editor session and text exports, not represented in the package schema.', '',
            ...result.backendFindings.map(finding => `- ${finding.code}: ${finding.note} Observed ${finding.observed}; expected earliest ${finding.expectedEarliest}.`), '',
            '## Remaining UX concerns', '', '- Fit-all renders long graphs at a small scale; selection focus is needed to read individual blocks.', '- Large/deep predicates still require scrolling the bounded outline. Only one edit form is shown; the full summary and each level remain accessible.', '- Workspace-level save/apply/history actions belong to the parent and remain above the editor, so the mobile screen still has a substantial header.', '- Automated checks and screenshot review are not a claim of perfect UX or a substitute for user testing on a physical phone and assistive technologies.', '',
            'Evidence: browser-results.json (API inputs/results, measurements and source hashes), browser-trace.zip, touch-trace.zip, complex-rule.json, multi-stage-rule.json, package-roundtrip.json, source-with-comments.yaml, invalid-preserved.yaml, studio-desktop.png, studio-mobile.png, mobile-saved-rule.png, the overview images and editing-detail images.', '',
            ...(result.error ? ['## Failure', '', '```text', result.error, '```', ''] : []),
        ].join('\n'));
        console.log(JSON.stringify({ status: result.status, checks: result.checks.length, uxChecks: result.uxChecks.length, error: result.error, pageErrors: result.pageErrors, backendFindings: result.backendFindings, measurements: result.measurements }, null, 2));
        await browser.close();
    }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
