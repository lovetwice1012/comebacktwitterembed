'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { catalog, template } = require('../../src/automation/catalog');
const { validateWorkflow } = require('../../src/automation/schema');
const { parseWorkflow, stringifyDraft } = require('../../src/automation/format');
const { recoveryKey, encodeRecovery, decodeRecovery } = require('../../src/automation/draft-recovery');
const tick = (f, ms = 450) => f.act(async () => new Promise(resolve => setTimeout(resolve, ms)));
const U = '222222222222222222', SOURCE = '11111111-1111-4111-8111-111111111111', COPY = '33333333-3333-4333-8333-333333333333';

test('conflicted recovery retains the exact source edition across reloads and preserves the draft when its trusted origin is unavailable', async () => {
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
    try {
        f.set('SVGElement', f.dom.window.SVGElement); f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); f.set('sessionStorage', f.dom.window.sessionStorage); f.set('confirm', () => true);
        f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
        const bindings = { destinations: {}, dictionaries: {} }, draft = { ...template('all', 'now', 'normal'), name: 'Recovered draft' };
        const current = { id: SOURCE, revision: 5, scope: 'private', name: 'Newer server definition', draft: { ...draft, name: 'Newer server definition' }, bindings, enabled: false, activeRevision: null };
        const key = recoveryKey(U); f.dom.window.sessionStorage.setItem(key, encodeRecovery({ ownerId: U, workflowId: SOURCE, baseRevision: 2, scope: 'private', definition: draft, bindings, textDraft: null }));
        let missingOrigin = true; const writes = [];
        f.set('fetch', async (address, options) => {
            const route = new URL(address, 'http://fixture').pathname.slice('/api/automation/'.length), body = options.body && JSON.parse(options.body); let result;
            if (route === 'catalog') result = catalog();
            else if (route === 'providers') result = { auto: [], price: [], autoRegistration: { eligible: true } };
            else if (route === 'entitlements') result = { plan: { name: '支援者' }, slots: { used: 0, max: 20, available: 20 }, usage: { entries: [] } };
            else if (route === `workflows/${SOURCE}`) result = current;
            else if (route === 'workflows' && options.method === 'POST') {
                writes.push(structuredClone(body));
                if (missingOrigin) return Response.json({ code: 'WORKFLOW_ORIGIN_REVIEW_REQUIRED', error: 'コピー元の履歴を確認してください。入力内容は保持しています。' }, { status: 409 });
                result = { ...current, id: COPY, name: body.definition.name, revision: 1, draft: body.definition, bindings: body.bindings };
            } else if (route === 'workflows') result = { items: [current], nextCursor: null };
            else if (route === 'validate') { const definition = body.text === undefined ? body.definition : parseWorkflow(body.text, body.format); result = { ...validateWorkflow(definition), definition, text: stringifyDraft(definition, body.format) }; }
            else result = { items: [], nextCursor: null };
            return Response.json(result);
        });
        const render = key => f.render(f.React.createElement(f.exports.AutomationWorkspace, { key, viewerId: U }));
        await render('first'); await tick(f);
        assert.equal(f.container.querySelector('[aria-label="ルール名"]').value, 'Recovered draft');
        let record = decodeRecovery(f.dom.window.sessionStorage.getItem(key), U); assert.equal(record.workflowId, SOURCE); assert.equal(record.baseRevision, 2);
        await f.click('下書きを保存'); assert.equal(writes.length, 1); assert.equal(writes[0].sourceWorkflowId, SOURCE); assert.equal(writes[0].expectedSourceRevision, 2);
        assert.equal(f.container.querySelector('[aria-label="ルール名"]').value, 'Recovered draft'); assert(f.container.textContent.includes('入力内容は保持'));
        await f.fill(f.container.querySelector('[aria-label="ルール名"]'), 'Still local after origin failure'); await tick(f);
        await render('second'); await tick(f);
        assert.equal(f.container.querySelector('[aria-label="ルール名"]').value, 'Still local after origin failure');
        record = decodeRecovery(f.dom.window.sessionStorage.getItem(key), U); assert.equal(record.workflowId, SOURCE); assert.equal(record.baseRevision, 2);
        missingOrigin = false; await f.click('下書きを保存');
        assert.equal(writes[1].sourceWorkflowId, SOURCE); assert.equal(writes[1].expectedSourceRevision, 2); assert.equal(writes[1].definition.name, 'Still local after origin failure');
        assert.equal(f.dom.window.sessionStorage.getItem(key), null);
    } finally { await f.close(); }
});
