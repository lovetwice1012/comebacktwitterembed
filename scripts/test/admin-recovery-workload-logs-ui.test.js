'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('workload log viewer keeps hostile log bytes as text and exposes incomplete evidence', async () => {
    const nodes = [];
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.content = ''; nodes.push(this); }
        set innerHTML(_) { throw new Error('Untrusted logs must never use innerHTML'); }
        set textContent(value) { this.content = String(value); this.children = []; }
        get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
        append(...children) { for (const child of children) { this.children.push(child); if (this.tag === 'select' && (!this.value || child.selected)) this.value = child.value; } }
        replaceChildren(...children) { this.children = []; this.content = ''; this.value = ''; this.append(...children); }
        setAttribute(key, value) { this[key] = value; }
        addEventListener(key, fn) { (this.handlers[key] ||= []).push(fn); }
    }
    const app = new Element('section'); app.id = 'app';
    const nav = new Element('nav'); nav.id = 'nav';
    const document = { hidden: false, createElement: tag => new Element(tag), getElementById: id => nodes.find(node => node.id === id) };
    const content = '<img src=x onerror="globalThis.executed=true">\nProviderError: HTTP403';
    let unavailable = false;
    let missing = false;
    const context = vm.createContext({
        document, URLSearchParams, queueMicrotask,
        MutationObserver: class { observe() {} }, setInterval() {},
        text(tag, value, className) { const node = new Element(tag); node.textContent = value; node.className = className || ''; return node; },
        raw(parent, value) { const node = new Element('details'); node.textContent = JSON.stringify(value); parent.append(node); },
        time: value => String(value), show(id) { document.getElementById(id).hidden = false; },
        async api(route) {
            if (route === 'v1/recovery') return { available: true, phase: 'ACTIVE', gates: [], candidate: {}, backup: {}, nodeObservations: { primary: { receivedAt: 1, stale: true, instanceId: '<img src=x onerror="globalThis.executed=true">', epoch: 1, primaryIoWatch: { state: 'observing', reason: 'continuous_stall_candidate', observedAtUnixMs: 1000, continuousSeconds: 175, thresholdSeconds: 180, evidence: { state: 'D', physicalWrites: '18446744073709551615' } } } } };
            if (unavailable) throw new Error('Root reader unavailable');
            return { available: !missing, state: missing ? 'log_absent' : 'available', component: 'bot', archive: 0, text: missing ? '' : content, files: [], fetchedAt: '2026-09-06T04:00:00Z',
                candidateId: 'fixture', activationEpoch: 3, pointerEpoch: 3, phase: 'ACTIVATION_FAILED', returnedBytes: 80, fileBytes: 1000,
                returnedLines: 2, omittedBytes: 920, truncated: true, firstLinePartial: true, logHealth: { droppedBytes: 20, trimmedBytes: 10, writeError: 'OSError:28' } };
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../admin-agent/web/recovery.js'), 'utf8'), context);
    const button = nav.children.find(node => node.dataset.view === 'recovery');
    button.handlers.click[0]();
    await new Promise(resolve => setImmediate(resolve));
    const tail = nodes.find(node => node.tag === 'pre' && node['aria-label'] === '保存済みログの末尾');
    assert.equal(tail.textContent, content);
    assert.equal(context.executed, undefined);
    assert.match(app.textContent, /停止条件の継続を観測中（未確定）/);
    assert.match(app.textContent, /現在の健康状態を推定しません/);
    assert.match(app.textContent, /古い・時刻差/);
    assert.match(app.textContent, /18446744073709551615/);
    assert.match(app.textContent, /完全なログではありません/);
    assert.match(app.textContent, /OSError:28/);
    assert.match(app.textContent, /途中から表示/);
    unavailable = true;
    nodes.find(node => node.tag === 'button' && node.textContent === 'ログを更新').handlers.click[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tail.textContent, content);
    assert.match(app.textContent, /過去の内容です/);
    unavailable = false; missing = true;
    nodes.find(node => node.tag === 'button' && node.textContent === 'ログを更新').handlers.click[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tail.textContent, '');
    assert.match(app.textContent, /保存エラー・欠落の記録があります/);
    assert.match(app.textContent, /OSError:28/);
});
