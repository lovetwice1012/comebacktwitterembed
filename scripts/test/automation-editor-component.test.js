'use strict';

// React + DOM state tests, not screenshot/browser-engine verification.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const esbuild = require('esbuild');
const { newWorkflow, validateWorkflow } = require('../../src/automation/schema');
const { parseWorkflow, stringifyDraft } = require('../../src/automation/format');
const { catalog } = require('../../src/automation/catalog');

test('real React editor preserves invalid text, debounces updates, and roundtrips valid text into GUI state', { timeout: 30000 }, async () => {
    const dom = new JSDOM('<!doctype html><div id="root" style="width:1200px;height:1000px"></div>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
    const previous = new Map();
    const setGlobal = (key, value) => { previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'Event', 'MouseEvent', 'MutationObserver']) setGlobal(key, dom.window[key]);
    setGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
    setGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
    setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const dashboard = path.resolve(__dirname, '../../dashboard');
    const localRequire = Module.createRequire(path.join(dashboard, 'package.json'));
    const React = localRequire('react'), { createRoot } = localRequire('react-dom/client');
    const { act } = React;
    let root;
    try {
        const build = await esbuild.build({ stdin: { contents: 'export { RuleEditor, NodeSettings } from "./components/automation/rule-editor"; export { predicateSummary } from "./components/automation/rule-labels"; export { EventSimulator } from "./components/automation/event-simulator";', resolveDir: dashboard, loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', loader: { '.css': 'empty' } });
        const compiled = new Module(path.join(dashboard, '__automation_editor_test__.js'), module);
        compiled.filename = path.join(dashboard, '__automation_editor_test__.js'); compiled.paths = Module._nodeModulePaths(dashboard);
        const requireCompiled = compiled.require.bind(compiled);
        compiled.require = id => id.endsWith('.css') ? {} : requireCompiled(id);
        compiled._compile(build.outputFiles[0].text, compiled.filename);
        const { RuleEditor } = compiled.exports;
        const container = dom.window.document.getElementById('root');
        let latest = newWorkflow('初期ルール'), editable = false, calls = 0;
        async function api(route, _method, body) {
            assert.equal(route, 'validate'); calls++;
            const definition = body.text !== undefined ? parseWorkflow(body.text, body.format) : body.definition;
            const result = validateWorkflow(definition);
            return { ...result, text: stringifyDraft(definition, body.format), ...(result.valid ? { definition } : {}) };
        }
        const catalogs = catalog(), bindings = { destinations: {}, dictionaries: {} };
        const onValidityChange = valid => { editable = valid; };
        function Fixture() {
            const [value, setValue] = React.useState(latest);
            const change = React.useCallback(next => { latest = next; setValue(next); }, []);
            return React.createElement(RuleEditor, { value, onChange: change, api, catalog: catalogs, bindings, onValidityChange });
        }
        const settle = async ms => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };
        const click = async label => { const button = [...container.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent) === label); assert(button, `button ${label}`); await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); };
        const fill = async (text, label = 'ルールJSONまたはYAML') => {
            const input = container.querySelector(`textarea[aria-label="${label}"]`); assert(input);
            await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(input, text); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
        };
        root = createRoot(container);
        await act(async () => root.render(React.createElement(Fixture)));
        await settle(420); assert.equal(editable, true);
        await click('テキスト'); await settle(420);
        const baselineCalls = calls;
        await fill('nodes: ['); await fill('nodes: [broken'); await fill('nodes: [broken,');
        await settle(510);
        assert.equal(calls - baselineCalls, 1, 'one debounced validation request for rapid typing');
        assert.equal(editable, false);
        assert.equal(latest.name, '初期ルール');
        await click('ブロック'); await click('テキスト');
        assert.equal(container.querySelector('textarea[aria-label="ルールJSONまたはYAML"]').value, 'nodes: [broken,');
        assert.equal(container.querySelector('select[aria-label="テキスト形式"]').disabled, true);
        const next = newWorkflow('テキストから反映');
        await fill(JSON.stringify(next)); await settle(520); await settle(420);
        assert.equal(latest.name, 'テキストから反映'); assert.equal(editable, true);
        await click('ブロック'); await settle(420);
        assert(container.textContent.includes('ブロックを追加'));
        assert.equal(latest.nodes.length, 2);
        await click('元に戻す'); await settle(420); assert.equal(latest.name, '初期ルール');
        await click('やり直す'); await settle(420); assert.equal(latest.name, 'テキストから反映');
        await click('テキスト');
        const commented = '# 保持する説明\n' + stringifyDraft(latest, 'yaml');
        await fill(commented); await settle(520); await settle(420);
        await click('ブロック'); await settle(420); await click('テキスト'); await settle(420);
        assert.equal(container.querySelector('textarea[aria-label="ルールJSONまたはYAML"]').value, commented, 'switching views preserves comments and formatting');
        const renamed = commented.replace('テキストから反映', '次の編集');
        await fill(renamed); await settle(520); await settle(420);
        await click('元に戻す'); await settle(420);
        assert.equal(container.querySelector('textarea[aria-label="ルールJSONまたはYAML"]').value, commented, 'undo restores the accepted source text');
        await click('やり直す'); await settle(420);
        assert.equal(container.querySelector('textarea[aria-label="ルールJSONまたはYAML"]').value, renamed, 'redo restores the next source text');

        const nested = { op: 'all', conditions: [
            { op: 'any', conditions: [{ field: 'title', op: 'contains', value: 'sale' }, { field: 'discountPercent', op: 'gte', value: 30 }] },
            { op: 'not', conditions: [{ field: 'sensitive', op: 'eq', value: true }] },
        ] };
        let conditionConfig = { predicate: structuredClone(nested) };
        function ConditionsFixture({ disabled = false }) {
            const [config, setConfig] = React.useState(conditionConfig);
            return React.createElement(compiled.exports.NodeSettings, { node: { id: 'condition', type: 'condition', config }, catalog: catalogs, bindings, disabled, update: next => { conditionConfig = next; setConfig(next); } });
        }
        await act(async () => root.render(React.createElement(ConditionsFixture)));
        assert.equal(container.querySelectorAll('[data-predicate-editor]').length, 1, 'only the selected condition has a form');
        assert.equal(container.querySelectorAll('[data-condition-path]').length, 3, 'child groups initially show concise collapsed rows');
        for (const op of ['AND', 'OR', 'NOT']) assert(compiled.exports.predicateSummary(nested).includes(op));
        assert(container.textContent.includes('情報不足（unknown）'));
        await click('条件 1 を編集'); await click('条件 1.2 を編集');
        const comparison = container.querySelector('select[aria-label="比較方法"]');
        await act(async () => { comparison.value = 'lte'; comparison.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
        assert.equal(conditionConfig.predicate.conditions[0].conditions[1].op, 'lte');
        assert.equal(conditionConfig.predicate.conditions[0].conditions[1].value, 30);
        assert.deepEqual(conditionConfig.predicate.conditions[1], nested.conditions[1]);
        await click('条件 1 の子条件');
        assert.equal(container.querySelectorAll('[data-predicate-editor]').length, 1);
        assert.equal(container.querySelector('select[aria-label="比較方法"]').value, 'lte', 'collapsing the outline keeps the selected edit');
        await act(async () => root.render(React.createElement(ConditionsFixture, { disabled: true })));
        await click('条件 2 を編集');
        assert(container.textContent.includes('NOTでも情報不足は情報不足のままです。'));
        assert(container.querySelector('select[aria-label="条件の組み立て"]').matches(':disabled'));
        assert.equal(conditionConfig.predicate.conditions[0].conditions[1].op, 'lte', 'read-only navigation does not mutate the predicate');

        const { EventSimulator } = compiled.exports;
        let resolveSimulation, simulationResult = null;
        const simulationApi = () => new Promise(resolve => { resolveSimulation = resolve; });
        const onResult = next => { simulationResult = next; };
        const simulatorProps = { value: latest, bindings, catalog: catalogs, api: simulationApi, disabled: false, onResult };
        await act(async () => root.render(React.createElement(EventSimulator, simulatorProps)));
        await click('JSON入力'); await fill('{"title":"first"}', 'テストイベントJSON');
        await click('判定する'); assert(resolveSimulation);
        await fill('{"title":"changed while pending"}', 'テストイベントJSON');
        const stale = { outputs: [{ destination: 'default', dueAtMs: 1, text: 'STALE RESULT', limits: [] }], trace: [] };
        await act(async () => resolveSimulation(stale));
        assert.equal(simulationResult, null); assert(!container.textContent.includes('STALE RESULT'));
        await click('判定する'); await act(async () => resolveSimulation(stale));
        assert.equal(simulationResult, stale);
        await act(async () => root.render(React.createElement(EventSimulator, { ...simulatorProps, disabled: true })));
        assert.equal(simulationResult, null, 'invalid or pending rule clears the previous simulated result');
        assert(!container.textContent.includes('STALE RESULT'));
    } finally {
        if (root) await act(async () => root.unmount());
        dom.window.close();
        for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    }
});
