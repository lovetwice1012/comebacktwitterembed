'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('emergency approval requires reviewed candidate and all explicit loss acknowledgements', async () => {
    const nodes = []; const actions = [];
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.value = ''; this.checked = false; this.content = ''; nodes.push(this); }
        set innerHTML(_) { throw new Error('Unsafe approval HTML'); }
        set textContent(value) { this.content = String(value); }
        get textContent() { return this.content + this.children.map(node => node.textContent).join(''); }
        append(...nodes) { this.children.push(...nodes); }
        prepend(...nodes) { this.children.unshift(...nodes); }
        replaceChildren(...nodes) { this.children = nodes; this.content = ''; }
        setAttribute(key, value) { this[key] = value; }
        addEventListener(key, value) { (this.handlers[key] ||= []).push(value); }
    }
    const panel = new Element('section'); panel.id = 'recovery';
    const snapshot = { available: true, manualApprovalAvailable: true, activeNode: 'primary', epoch: 2,
        candidate: { id: 'a'.repeat(24), phase: 'VALIDATED' }, backup: { backupId: '20260905T173004Z', sourceSha256: 'b'.repeat(64), sourceTimestamp: '2026-09-05T17:30:04Z' }, primaryIntent: { desiredState: 'maintenance', revision: 3 }, ociIntent: { desiredState: 'maintenance', revision: 24 } };
    const context = vm.createContext({ document: { getElementById: id => nodes.find(node => node.id === id), createElement: tag => new Element(tag) },
        text(tag, value) { const node = new Element(tag); node.textContent = value; return node; }, raw() {}, time: value => String(value),
        async api(route) { assert.equal(route, 'v1/recovery'); return snapshot; },
        async runAction(type, input) { actions.push({ type, input }); return { status: 'succeeded', result: { approval: { state: 'approved' } } }; },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../admin-agent/web/emergency-approval.js'), 'utf8'), context);
    const form = nodes.find(node => node.tag === 'form');
    const submit = nodes.find(node => node.tag === 'button' && node.textContent === '確認した候補の緊急起動を一度承認');
    await form.handlers.submit[0]({ preventDefault() {} }); assert.equal(actions.length, 0);
    await nodes.find(node => node.tag === 'button' && node.textContent === '緊急起動の対象候補を確認').handlers.click[0]();
    assert.equal(submit.disabled, true);
    const reason = nodes.find(node => node.tag === 'textarea'); reason.value = 'Main host has not returned after reboot'; reason.handlers.input[0]();
    const checks = nodes.filter(node => node.tag === 'input');
    for (const node of checks.slice(0, 2)) { node.checked = true; node.handlers.change[0](); }
    await form.handlers.submit[0]({ preventDefault() {} }); assert.equal(actions.length, 0);
    checks[2].checked = true; checks[2].handlers.change[0]();
    await form.handlers.submit[0]({ preventDefault() {} });
    assert.equal(actions.length, 1); assert.equal(actions[0].type, 'recovery.emergency.approve');
    assert.equal(actions[0].input.candidateId, snapshot.candidate.id);
    assert.equal(actions[0].input.backupSha256, snapshot.backup.sourceSha256);
    assert.equal(actions[0].input.expectedPrimaryIntentRevision, 3);
    assert.equal(actions[0].input.expectedOciPolicyRevision, 24);
    assert.equal(actions[0].input.acceptPrimaryIntentOverride, true);
    assert.equal('actorId' in actions[0].input, false);
    assert.equal(submit.disabled, true);
    assert.match(panel.textContent, /起動を保証する応答ではありません/);
});
