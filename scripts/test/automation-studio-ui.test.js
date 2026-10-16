'use strict';

// Real React/DOM regression checks. Browser geometry is verified separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { newWorkflow, validateWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const { parseWorkflow, stringifyDraft } = require('../../src/automation/format');
const { catalog, template } = require('../../src/automation/catalog');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { copySelection } = require('../../src/automation/editor-clipboard');
const { adoptUserNodes, nodeHasDimensions, getEdgePosition, ConnectionMode, Position } = require('../../dashboard/node_modules/@xyflow/system');

const bindings = { destinations: {}, dictionaries: {} };
const catalogs = catalog();
const button = (f, label) => [...f.container.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label);
const press = async (f, label) => {
    const target = button(f, label); assert(target, `button ${label}`);
    await f.act(async () => target.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
};
const settle = async (f, ms = 420) => f.act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const field = (f, label) => f.container.querySelector(`[aria-label="${label}"]`);
const clickElement = async (f, element) => { assert(element, 'interactive element'); await f.act(async () => element.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }))); };
const keyboard = async (f, target, key, modifiers = {}) => {
    const event = new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
    await f.act(async () => target.dispatchEvent(event)); return event;
};
function flowEnvironment(f) {
    f.set('SVGElement', f.dom.window.SVGElement);
    f.set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    f.set('sessionStorage', f.dom.window.sessionStorage);
    f.set('confirm', () => true);
    f.dom.window.HTMLElement.prototype.scrollIntoView = function () {};
}
function controlledFlow(React, state) {
    // This fixture exercises the editor's controlled selection callbacks; real
    // pointer geometry and React Flow's own selection implementation are browser QA.
    const instance = { fitView: async () => {}, screenToFlowPosition: point => point };
    // No DOM geometry is fabricated for obstacle routing in this fixture;
    // actual routing-store coordinates are covered by their dedicated tests
    // and browser QA. Measurement visibility below uses real XYFlow gates.
    const emptyGeometry = { nodeLookup: new Map(), edges: [], connectionMode: 'strict' };
    function ReactFlow(props) {
        state.props = props;
        React.useEffect(() => { props.onInit?.(instance); }, []);
        return React.createElement('div', { className: 'react-flow', onContextMenu: props.onPaneContextMenu }, props.nodes.map(node => React.createElement('div', {
            key: node.id, className: 'react-flow__node', 'data-id': node.id,
            onClick: event => props.onNodeClick?.(event, node),
            onDoubleClick: event => props.onNodeDoubleClick?.(event, node),
            onContextMenu: event => { event.stopPropagation(); props.onNodeContextMenu?.(event, node); },
        }, React.createElement(props.nodeTypes[node.type], { id: node.id, data: node.data, selected: node.selected }))), props.children);
    }
    return { ReactFlow, ReactFlowProvider: props => props.children,
        Handle: ({ type, position: _position, id, isConnectable: _connectable, ...props }) => React.createElement('span', { ...props, 'data-handleid': id, 'data-handletype': type }),
        Position: { Left: 'left', Right: 'right' }, MarkerType: { ArrowClosed: 'arrowclosed' }, SelectionMode: { Partial: 'partial' },
        Background: () => null, Controls: () => null, MiniMap: () => null, useUpdateNodeInternals: () => () => {},
        useStore: selector => React.useMemo(() => selector(emptyGeometry), [selector]),
    };
}
async function editorFixture(original, extra = {}) {
    const flowControl = extra.controlledFlow ? {} : null, options = { ...extra }; delete options.controlledFlow; delete options.bindings;
    const f = await reactFixture('export { RuleEditor } from "./components/automation/rule-editor";', { moduleOverrides: flowControl ? { '@xyflow/react': React => controlledFlow(React, flowControl) } : {} });
    flowEnvironment(f);
    let latest = structuredClone(original), latestBindings = structuredClone(extra.bindings ?? bindings), valid = false, replace, overrideOptions;
    const requests = [], changes = [];
    const api = async (route, method, body) => {
        requests.push({ route, method, body: structuredClone(body) });
        if (route === 'simulate') return { outputs: [], trace: [] };
        assert.equal(route, 'validate');
        const definition = body.text === undefined ? body.definition : parseWorkflow(body.text, body.format);
        const result = validateWorkflow(definition);
        return { ...result, text: stringifyDraft(definition, body.format), ...(result.valid ? { definition } : {}) };
    };
    const onValidityChange = next => { valid = next; };
    function Fixture() {
        const [value, setValue] = f.React.useState(latest), [currentBindings, setBindings] = f.React.useState(latestBindings), [version, setVersion] = f.React.useState(0), [optionOverrides, setOptionOverrides] = f.React.useState({});
        const change = f.React.useCallback(next => { changes.push(next); latest = next; setValue(next); }, []);
        const changeBindings = f.React.useCallback(next => { latestBindings = next; setBindings(next); }, []);
        replace = next => { latest = structuredClone(next); setValue(latest); setVersion(old => old + 1); };
        overrideOptions = next => setOptionOverrides(previous => ({ ...previous, ...next }));
        return f.React.createElement(f.exports.RuleEditor, { key: version, value, bindings: currentBindings, catalog: catalogs, api, onChange: change, onBindingsChange: changeBindings, onValidityChange, ...options, ...optionOverrides });
    }
    await f.render(f.React.createElement(Fixture)); await settle(f);
    return Object.assign(f, { latest: () => latest, latestBindings: () => latestBindings, valid: () => valid, requests, changes, flowControl, replace: next => f.act(async () => replace(next)), overrideOptions: next => f.act(async () => overrideOptions(next)) });
}
function arbitraryRule() {
    const data = newWorkflow('任意IDの通知');
    const names = { start: 'ingest_a29', send: 'deliver_z81' };
    data.nodes = data.nodes.map(node => ({ ...node, id: names[node.id] }));
    data.edges = data.edges.map(edge => ({ ...edge, source: names[edge.source], target: names[edge.target] }));
    return data;
}
function branchedRule() {
    const data = arbitraryRule();
    data.nodes.push({ id: 'gate_c91', type: 'condition', config: { predicate: { op: 'all', conditions: [
        { op: 'any', conditions: [{ field: 'title', op: 'contains', value: 'sale' }, { field: 'discountPercent', op: 'gte', value: 30 }] },
        { op: 'not', conditions: [{ field: 'sensitive', op: 'eq', value: true }] },
    ] } }, position: { x: 350, y: 100 }, group: 'filtering' });
    data.nodes.push({ id: 'excluded_14', type: 'stop', config: structuredClone(NODE_TYPES.stop.defaults), position: { x: 690, y: 420 } });
    data.nodes.find(node => node.type === 'send').group = 'filtering';
    data.edges = [
        { id: 'a', source: 'ingest_a29', target: 'gate_c91', port: 'out' },
        { id: 'b', source: 'gate_c91', target: 'deliver_z81', port: 'yes' },
        { id: 'c', source: 'gate_c91', target: 'excluded_14', port: 'no' },
    ];
    data.layout = { groups: [{ id: 'filtering', label: '選別して送る', collapsed: false }], viewport: { x: 0, y: 0, zoom: 1 } };
    return data;
}
function canvasGeometry(f) {
    const canvas = f.container.querySelector('.studio-canvas-surface'); assert(canvas);
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, x: 0, y: 0, width: 1000, height: 800 });
    return canvas;
}
const editorRoot = f => f.container.querySelector('.automation-rule-editor');
async function selectBlocks(f, ids) {
    await f.act(async () => f.flowControl.props.onNodesChange(f.latest().nodes.map(node => ({ type: 'select', id: node.id, selected: ids.includes(node.id) }))));
}
async function clipboardEvent(f, kind, initial = '', target = editorRoot(f)) {
    const contents = new Map(initial ? [['text/plain', initial]] : []);
    const event = new f.dom.window.Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: type => contents.get(type) || '', setData: (type, text) => contents.set(type, text) } });
    await f.act(async () => target.dispatchEvent(event));
    return { event, contents, payload: () => JSON.parse(contents.get('application/x-cbte-automation-selection') || contents.get('text/plain')) };
}
const menuItem = (f, label) => [...f.container.querySelectorAll('[role="menuitem"]')].find(item => item.querySelector('span')?.textContent === label);

const reportDimensions = async (f, dimensions) => f.act(async () => f.flowControl.props.onNodesChange(Object.entries(dimensions).map(([id, size]) => ({ type: 'dimensions', id, dimensions: size }))));
function visibleFlowGate(f) {
    // Exercise the installed library's real visibility/edge initialization
    // gates. The controlled fixture supplies ResizeObserver measurements;
    // pointer coordinates and actual handle DOM geometry remain browser QA.
    const nodeLookup = new Map(), parentLookup = new Map(), handleBounds = new Map();
    const check = () => {
        const result = adoptUserNodes(f.flowControl.props.nodes, nodeLookup, parentLookup, { checkEquality: true });
        assert.equal(result.nodesInitialized, true, 'every existing block stays measured after a controlled graph update');
        for (const node of nodeLookup.values()) {
            assert.equal(nodeHasDimensions(node), true, `${node.id} must not enter React Flow visibility:hidden`);
            if (!handleBounds.has(node.id)) {
                const bounds = {
                    source: node.data.ports.map(id => ({ id, position: Position.Right, x: node.measured.width, y: 40, width: 12, height: 12 })),
                    target: [{ id: null, position: Position.Left, x: 0, y: 40, width: 12, height: 12 }],
                };
                handleBounds.set(node.id, bounds); node.internals.handleBounds = bounds;
            } else assert.equal(node.internals.handleBounds, handleBounds.get(node.id), 'adoption must preserve the previously observed connection handles');
        }
        for (const edge of f.flowControl.props.edges) assert(getEdgePosition({
            id: edge.id, sourceNode: nodeLookup.get(edge.source), targetNode: nodeLookup.get(edge.target),
            sourceHandle: edge.sourceHandle || null, targetHandle: edge.targetHandle || null, connectionMode: ConnectionMode.Strict,
        }), `${edge.id} must keep initialized endpoints rather than disappear`);
    };
    return check;
}

test('measured blocks and initialized wires survive selection, dragging, config editing and undo without persisting display metadata', async () => {
    const original = branchedRule(), f = await editorFixture(original, { controlledFlow: true });
    try {
        const sizes = Object.fromEntries(f.flowControl.props.nodes.map((node, i) => [node.id, { width: 260 + i, height: 150 + i * 20 }]));
        await reportDimensions(f, sizes);
        assert.deepEqual(f.latest(), original); assert.equal(f.changes.length, 0);
        assert.equal(button(f, '元に戻す').disabled, true, 'measurement must not create a workflow/history edit');
        const visible = visibleFlowGate(f); visible();
        await selectBlocks(f, ['gate_c91']); visible();
        await f.act(async () => f.flowControl.props.onNodeDragStart());
        await f.act(async () => f.flowControl.props.onNodesChange([{ type: 'position', id: 'gate_c91', position: { x: 580, y: 340 }, dragging: true }])); visible();
        await f.act(async () => f.flowControl.props.onNodesChange([{ type: 'position', id: 'gate_c91', position: { x: 725, y: 510 }, dragging: false }])); visible();
        assert.deepEqual(f.latest().nodes.find(node => node.id === 'gate_c91').position, { x: 500, y: 300 });
        const gate = f.flowControl.props.nodes.find(node => node.id === 'gate_c91');
        await f.act(async () => gate.data.onConfig({ predicate: { field: 'title', op: 'contains', value: 'changed' } })); visible();
        await press(f, '元に戻す'); visible();
        assert.deepEqual(f.latest().nodes.find(node => node.id === 'gate_c91').config, original.nodes.find(node => node.id === 'gate_c91').config);
        await press(f, '元に戻す'); visible(); assert.deepEqual(f.latest(), original);
        await settle(f);
        for (const value of [...f.changes, ...f.requests.filter(request => request.body?.definition).map(request => request.body.definition)]) {
            assert(value.nodes.every(node => !Object.hasOwn(node, 'measured') && !Object.hasOwn(node, 'width') && !Object.hasOwn(node, 'height')), 'only canonical workflow nodes reach persistence/validation');
        }
        assert.deepEqual(Object.fromEntries(f.flowControl.props.nodes.map(node => [node.id, node.measured])), sizes);
    } finally { await f.close(); }
});

test('read-only and unfinished source drafts keep accepting valid measurements and ignore invalid or duplicate dimensions', async () => {
    const original = arbitraryRule(), f = await editorFixture(original, { controlledFlow: true, readOnly: true });
    try {
        const sizes = { ingest_a29: { width: 280, height: 160 }, deliver_z81: { width: 280, height: 210 } };
        await reportDimensions(f, sizes);
        const visible = visibleFlowGate(f); visible();
        const unchangedNodes = f.flowControl.props.nodes;
        await reportDimensions(f, sizes);
        assert.equal(f.flowControl.props.nodes, unchangedNodes, 'identical ResizeObserver dimensions must not trigger another graph adoption');
        await reportDimensions(f, { ingest_a29: { width: 0, height: 160 }, deliver_z81: { width: Number.NaN, height: 210 } });
        await reportDimensions(f, { ingest_a29: { width: 280, height: Infinity }, deliver_z81: { width: -1, height: 210 } });
        assert.equal(f.flowControl.props.nodes, unchangedNodes, 'invalid observations cannot replace usable dimensions'); visible();
        await f.overrideOptions({ readOnly: false }); visible();
        await press(f, 'テキスト'); await f.fill(field(f, 'ルールJSONまたはYAML'), 'nodes: [incomplete');
        await press(f, 'ブロック');
        assert.equal(f.flowControl.props.nodesDraggable, false);
        await reportDimensions(f, { deliver_z81: { width: 310, height: 230 } }); visible();
        assert.deepEqual(f.flowControl.props.nodes.find(node => node.id === 'deliver_z81').measured, { width: 310, height: 230 });
        assert.deepEqual(f.latest(), original); assert.equal(f.changes.length, 0, 'display measurements remain separate even while graph mutation is locked');
    } finally { await f.close(); }
});

test('collapsed group measurements survive expansion and selection while deleted block measurements are discarded', async () => {
    const original = branchedRule(); original.layout.groups[0].collapsed = true;
    const f = await editorFixture(original, { controlledFlow: true });
    try {
        const sizes = { ingest_a29: { width: 280, height: 160 }, excluded_14: { width: 260, height: 110 }, '__group:filtering': { width: 270, height: 130 } };
        await reportDimensions(f, sizes);
        const visible = visibleFlowGate(f); visible();
        await selectBlocks(f, ['gate_c91', 'deliver_z81']); visible();
        await f.act(async () => f.flowControl.props.nodes.find(node => node.id === '__group:filtering').data.onExpand());
        await reportDimensions(f, { gate_c91: { width: 290, height: 250 }, deliver_z81: { width: 280, height: 210 } });
        assert.deepEqual(f.flowControl.props.nodes.find(node => node.id === 'ingest_a29').measured, sizes.ingest_a29);
        await press(f, '元に戻す'); visible();
        assert.deepEqual(f.flowControl.props.nodes.find(node => node.id === '__group:filtering').measured, sizes['__group:filtering'], 'a group that still exists keeps its observed size when collapsed again');
        await selectBlocks(f, ['excluded_14']);
        await clipboardEvent(f, 'cut');
        assert(!f.latest().nodes.some(node => node.id === 'excluded_14'));
        await press(f, '元に戻す');
        assert.equal(f.flowControl.props.nodes.find(node => node.id === 'excluded_14').measured, undefined, 'a restored removed block waits for its own fresh observation instead of inheriting stale cache');
        assert.deepEqual(f.flowControl.props.nodes.find(node => node.id === 'ingest_a29').measured, sizes.ingest_a29);
        assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('canvas navigation retains a zoomed-out view and wire focus never changes the saved graph', async () => {
    const original = branchedRule();
    original.layout.viewport = { x: 25, y: 40, zoom: 0.48 };
    original.edges.push({ id: 'unknown-route', source: 'gate_c91', target: 'excluded_14', port: 'unknown' });
    original.edges.push({ id: 'other-route', source: 'ingest_a29', target: 'excluded_14', port: 'out' });
    const f = await editorFixture(original, { controlledFlow: true });
    try {
        assert.equal(f.flowControl.props.fitView, false, 'opening an intentionally zoomed-out view must not replace its viewport');
        await f.act(async () => f.flowControl.props.onMoveEnd(new f.dom.window.MouseEvent('mouseup'), { x: 145, y: 170, zoom: 0.48 }));
        assert.deepEqual(f.latest().layout.viewport, { x: 100, y: 100, zoom: 0.48 });
        assert.equal(f.flowControl.props.fitView, false, 'finishing a pan must keep its zoom instead of scheduling another fit');
        assert.deepEqual(f.latest().nodes, original.nodes);
        assert.deepEqual(f.latest().edges, original.edges);
        assert.equal(button(f, '元に戻す').disabled, true, 'navigation does not create a graph edit');
        const navigated = structuredClone(f.latest());
        await selectBlocks(f, ['gate_c91']);
        const edges = f.flowControl.props.edges;
        assert(edges.filter(edge => edge.source === 'gate_c91' || edge.target === 'gate_c91').every(edge => edge.data.focused && !edge.data.dimmed));
        assert.equal(edges.find(edge => edge.id === 'other-route').data.dimmed, true);
        assert.notEqual(edges.find(edge => edge.id === 'c').data.lanes.targetIndex, edges.find(edge => edge.id === 'unknown-route').data.lanes.targetIndex);
        await selectBlocks(f, []);
        assert(f.flowControl.props.edges.every(edge => !edge.data.focused && !edge.data.dimmed));
        await f.act(async () => f.flowControl.props.onEdgesChange([{ type: 'select', id: 'unknown-route', selected: true }]));
        assert(f.flowControl.props.edges.every(edge => edge.data.focused === (edge.id === 'unknown-route')));
        assert.deepEqual(f.latest(), navigated, 'route lanes, focus and display styles remain outside the workflow definition');
    } finally { await f.close(); }
});

async function contextAt(f, kind, id) {
    canvasGeometry(f);
    const event = { preventDefault() {}, clientX: 420, clientY: 340 };
    await f.act(async () => {
        if (kind === 'edge') f.flowControl.props.onEdgeContextMenu(event, { id });
        else if (kind === 'node') f.flowControl.props.onNodeContextMenu(event, { id });
        else f.flowControl.props.onSelectionContextMenu(event);
    });
    assert(f.container.querySelector('[role="menu"]'));
}

test('the simulator starts with a relevant price event and can rebuild its sample for a changed rule', async () => {
    const f = await reactFixture('export { EventSimulator } from "./components/automation/event-simulator";');
    try {
        const original = newWorkflow('Steamの価格通知');
        original.nodes.find(node => node.type === 'start').config.providers = ['steam'];
        const calls = [];
        const api = async (route, method, body) => {
            calls.push({ route, method, body: structuredClone(body) });
            return { outputs: [], trace: [] };
        };
        const props = { value: original, bindings, catalog: catalogs, api, disabled: false, open: true };
        await f.render(f.React.createElement(f.exports.EventSimulator, props));
        await press(f, 'JSON入力');
        const raw = () => f.container.querySelector('textarea[aria-label="テストイベントJSON"]');
        const sample = JSON.parse(raw().value);
        assert.equal(sample.providerId, 'steam'); assert.equal(sample.kind, 'price');
        assert.equal(sample.priceAmount, 980); assert.equal(sample.previousPriceAmount, 1500);
        assert.equal(sample.priceDelta, -520); assert.equal(sample.currency, 'JPY');
        await press(f, '判定する');
        assert.equal(calls[0].route, 'simulate'); assert.equal(calls[0].method, 'POST');
        assert.deepEqual(calls[0].body.event, sample);
        const changed = newWorkflow('GitHubの新着');
        changed.nodes.push({ id: 'filter', type: 'condition', config: { predicate: { op: 'all', conditions: [
            { field: 'providerId', op: 'in', value: ['github'] },
            { field: 'title', op: 'contains', value: 'release' },
        ] } } });
        await f.render(f.React.createElement(f.exports.EventSimulator, { ...props, value: changed }));
        assert.equal(JSON.parse(raw().value).providerId, 'steam', 'changing the rule preserves a manually editable event');
        await press(f, 'ルールのサンプル');
        assert.equal(JSON.parse(raw().value).providerId, 'github');
        assert.equal(JSON.parse(raw().value).kind, 'ReleaseEvent');
        assert.equal(JSON.parse(raw().value).priceAmount, undefined);
        await press(f, '判定する');
        assert.equal(calls[1].body.event.providerId, 'github');
        changed.nodes.find(node => node.type === 'start').config.kinds = ['IssuesEvent'];
        await f.render(f.React.createElement(f.exports.EventSimulator, { ...props, value: structuredClone(changed) }));
        await press(f, 'ルールのサンプル');
        assert.equal(JSON.parse(raw().value).kind, 'IssuesEvent', 'the sample respects an explicit start event kind');
    } finally { await f.close(); }
});

test('the price-drop template gets a price sample that actually reaches one notification in the real engine', async () => {
    const f = await reactFixture('export { EventSimulator } from "./components/automation/event-simulator";');
    try {
        const value = template('down', 'now', 'text');
        let evaluated;
        const api = async (route, method, body) => {
            assert.equal(route, 'simulate'); assert.equal(method, 'POST');
            evaluated = evaluateWorkflow(body.definition, body.event, { now: 1 });
            return evaluated;
        };
        await f.render(f.React.createElement(f.exports.EventSimulator, { value, bindings, catalog: catalogs, api, disabled: false, open: true }));
        await press(f, 'JSON入力');
        const event = JSON.parse(field(f, 'テストイベントJSON').value);
        assert.equal(event.providerId, 'amazon'); assert.equal(event.kind, 'price');
        assert(event.priceDelta < 0); assert(event.priceAmount < event.previousPriceAmount);
        await press(f, '判定する');
        assert.equal(evaluated.trace.find(row => row.nodeId === 'filter').outcome, 'yes');
        assert.equal(evaluated.outputs.length, 1);
        assert(f.container.querySelector('.studio-test-result').textContent.includes('通知予定 1件'));
    } finally { await f.close(); }
});

test('display rules choose normal Bot expansion or direct delivery without applying media controls to normal expansion', async () => {
    const f = await reactFixture('export { NodeSettings } from "./components/automation/rule-editor";');
    let current;
    function Settings() {
        const [config, setConfig] = f.React.useState({ ...structuredClone(NODE_TYPES.transform.defaults), format: 'normal', media: 'links' });
        current = config;
        return f.React.createElement(f.exports.NodeSettings, { node: { id: 'display', type: 'transform', config }, catalog: catalogs, bindings, update: setConfig });
    }
    try {
        await f.render(f.React.createElement(Settings));
        assert.equal(button(f, '通常のBot展開').getAttribute('aria-pressed'), 'true');
        assert(f.container.textContent.includes('通常のBot機能とサーバーの設定で展開します'));
        assert(f.container.textContent.includes('DMは通知文とURLのみです'));
        assert.equal(field(f, 'メディア表示'), null, 'normal Bot expansion uses the Bot settings instead of notification media controls');
        assert.equal(field(f, '通知文').value, '{title}\n{url}');
        await press(f, '通知側で直接展開');
        assert.equal(current.format, 'expanded');
        assert.equal(field(f, 'メディア表示').value, 'links', 'direct delivery restores its saved media choice');
        await f.fill(field(f, 'メディア表示'), 'hide');
        await press(f, '通常のBot展開');
        assert.equal(current.format, 'normal');
        assert.equal(current.media, 'hide', 'switching expansion modes preserves the direct-delivery choice for later use');
        assert.equal(field(f, 'メディア表示'), null);
        assert.equal(field(f, '通知文').value, '{title}\n{url}');
    } finally { await f.close(); }
});

test('block canvas uses the actual start ID; inline branch additions preserve other routes and undo restores topology', { timeout: 15000 }, async () => {
    const original = arbitraryRule(), f = await editorFixture(original);
    try {
        assert(f.container.querySelector('.studio-mode-graph .react-flow'));
        assert.equal(button(f, 'ブロック').getAttribute('aria-pressed'), 'true');
        assert.equal(field(f, '編集するブロック').value, 'ingest_a29');
        assert.equal(f.valid(), true);
        const label = type => catalogs.nodes[type].label;
        await press(f, `${label('start')}の次へにブロックを追加`);
        assert(f.container.querySelector('.studio-canvas-library'));
        await press(f, label('condition')); await settle(f);
        const condition = f.latest().nodes.find(node => node.type === 'condition'); assert(condition);
        assert.equal(field(f, '編集するブロック').value, condition.id);
        assert(f.latest().edges.some(edge => edge.source === 'ingest_a29' && edge.target === condition.id && edge.port === 'out'));
        assert(f.latest().edges.some(edge => edge.source === condition.id && edge.target === 'deliver_z81' && edge.port === 'yes'));
        assert.equal(f.container.querySelector('.studio-canvas-library'), null);
        await press(f, `${label('condition')}の不一致にブロックを追加`);
        await press(f, label('stop')); await settle(f);
        const stop = f.latest().nodes.find(node => node.type === 'stop'); assert(stop);
        const branchEdge = structuredClone(f.latest().edges.find(edge => edge.source === condition.id && edge.port === 'no'));
        assert.equal(branchEdge.target, stop.id);
        await press(f, `${label('condition')}の一致にブロックを追加`);
        await press(f, label('delay')); await settle(f);
        const delay = f.latest().nodes.find(node => node.type === 'delay'); assert(delay);
        assert(f.latest().edges.some(edge => edge.source === condition.id && edge.target === delay.id && edge.port === 'yes'));
        assert(f.latest().edges.some(edge => edge.source === delay.id && edge.target === 'deliver_z81' && edge.port === 'out'));
        assert.deepEqual(f.latest().edges.find(edge => edge.id === branchEdge.id), branchEdge, 'adding to yes preserves the no route');
        await f.fill(field(f, '編集するブロック'), condition.id);
        await clickElement(f, field(f, `${label('condition')}の情報不足から接続`));
        await clickElement(f, field(f, `${label('stop')}に接続`)); await settle(f);
        assert(f.latest().edges.some(edge => edge.source === condition.id && edge.target === stop.id && edge.port === 'unknown'));
        for (let i = 0; i < 4; i++) { await press(f, '元に戻す'); await settle(f); }
        assert.deepEqual(f.latest(), original, 'undo restores IDs, configuration, edges and saved positions');
        assert.equal(field(f, '編集するブロック').value, 'ingest_a29');
    } finally { await f.close(); }
});

test('mode and test switches preserve nested branches, layout and incomplete source; invalid source locks canvas edits', { timeout: 10000 }, async () => {
    const original = arbitraryRule();
    original.nodes.push({ id: 'gate_c91', type: 'condition', config: { predicate: { op: 'all', conditions: [
        { op: 'any', conditions: [{ field: 'title', op: 'contains', value: 'sale' }, { field: 'discountPercent', op: 'gte', value: 30 }] },
        { op: 'not', conditions: [{ field: 'sensitive', op: 'eq', value: true }] },
    ] } }, position: { x: 350, y: 100 }, group: 'filtering' });
    original.nodes.push({ id: 'excluded_14', type: 'stop', config: structuredClone(NODE_TYPES.stop.defaults), position: { x: 690, y: 420 } });
    original.edges = [
        { id: 'a', source: 'ingest_a29', target: 'gate_c91', port: 'out' },
        { id: 'b', source: 'gate_c91', target: 'deliver_z81', port: 'yes' },
        { id: 'c', source: 'gate_c91', target: 'excluded_14', port: 'no' },
        { id: 'd', source: 'gate_c91', target: 'excluded_14', port: 'unknown' },
    ];
    original.layout = { groups: [{ id: 'filtering', label: '選別', collapsed: false }], viewport: { x: 25, y: 80, zoom: 0.7 } };
    const f = await editorFixture(original);
    try {
        for (const name of ['手順', 'テキスト', 'ブロック']) { await press(f, name); await settle(f); assert.deepEqual(f.latest(), original); }
        await press(f, 'テスト');
        assert.equal(f.container.querySelector('.studio-test-panel').open, true);
        assert(f.container.querySelector('.studio-canvas-surface').closest('[hidden]'));
        await press(f, 'JSON入力'); await f.fill(field(f, 'テストイベントJSON'), '{"title":"入力したイベント"}');
        await press(f, '判定する');
        assert(f.container.querySelector('.studio-test-result'));
        await press(f, 'テスト'); assert.equal(f.container.querySelector('.studio-test-panel').open, false);
        await press(f, 'テスト');
        assert.equal(field(f, 'テストイベントJSON').value, '{"title":"入力したイベント"}', 'closing the test panel preserves the event');
        assert(f.container.querySelector('.studio-test-result'), 'closing the test panel preserves a current result');
        await press(f, 'テキスト');
        const source = field(f, 'ルールJSONまたはYAML');
        await f.fill(source, 'nodes: [incomplete'); await settle(f, 510);
        assert.equal(f.valid(), false);
        await press(f, 'ブロック');
        for (const target of f.container.querySelectorAll('.studio-flow-add')) assert.equal(target.disabled, true);
        assert.equal(field(f, 'ルールをインポート').disabled, true);
        assert.equal(button(f, '元に戻す').disabled, true);
        assert.equal(f.container.querySelector('.studio-block-choice:not(:disabled)'), null);
        assert.deepEqual(f.latest(), original);
        await press(f, 'テキスト'); assert.equal(field(f, 'ルールJSONまたはYAML').value, 'nodes: [incomplete');
        await f.fill(field(f, 'ルールJSONまたはYAML'), stringifyDraft(original, 'yaml')); await settle(f, 520); await settle(f);
        assert.equal(f.valid(), true); assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('flow blocks keep distinct yes/no/unknown add targets and disable mutation while allowing settings navigation', async () => {
    const f = await reactFixture('export { FlowBlock } from "./components/automation/rule-editor"; export { ReactFlowProvider } from "@xyflow/react";');
    flowEnvironment(f);
    try {
        const selected = [], additions = [], connections = [], targets = [], label = catalogs.nodes.condition.label;
        const data = { kind: 'condition', label, ports: ['yes', 'no', 'unknown'], summary: '通知条件', onAdd: port => additions.push(port), onEdit: () => selected.push('settings'), onPort: port => connections.push(port), onTarget: () => targets.push('target'), locked: false };
        const render = next => f.React.createElement(f.exports.ReactFlowProvider, null, f.React.createElement(f.exports.FlowBlock, { data: next, selected: true }));
        await f.render(render(data));
        for (const [port, title] of [['yes', '一致'], ['no', '不一致'], ['unknown', '情報不足']]) {
            assert(f.container.querySelector(`[data-port="${port}"]`));
            await press(f, `${label}の${title}にブロックを追加`);
            await clickElement(f, field(f, `${label}の${title}から接続`));
        }
        assert.deepEqual(additions, ['yes', 'no', 'unknown']);
        assert.deepEqual(connections, ['yes', 'no', 'unknown'], 'real XYFlow Handles deliver direct click callbacks instead of overriding them');
        await clickElement(f, field(f, `${label}に接続`));
        assert.deepEqual(targets, ['target']);
        await keyboard(f, field(f, `${label}の一致から接続`), 'Enter');
        await keyboard(f, field(f, `${label}に接続`), ' ');
        assert.deepEqual(connections, ['yes', 'no', 'unknown', 'yes']);
        assert.deepEqual(targets, ['target', 'target']);
        await f.render(render({ ...data, locked: true }));
        for (const target of f.container.querySelectorAll('.studio-flow-add')) assert.equal(target.disabled, true);
        await clickElement(f, field(f, `${label}の一致から接続`));
        await clickElement(f, field(f, `${label}に接続`));
        await keyboard(f, field(f, `${label}の一致から接続`), 'Enter');
        await keyboard(f, field(f, `${label}に接続`), ' ');
        assert.deepEqual(connections, ['yes', 'no', 'unknown', 'yes']);
        assert.deepEqual(targets, ['target', 'target'], 'locked Handles block both pointer and keyboard connection callbacks');
        await press(f, `${label}の設定を開く`); assert.deepEqual(selected, ['settings']);
    } finally { await f.close(); }
});

test('picker pointer placement and legacy drag data keep existing paths and respect canvas bounds and editing locks', { timeout: 15000 }, async () => {
    const transferred = new Map(), dataTransfer = {
        effectAllowed: '', dropEffect: '',
        setData: (type, value) => transferred.set(type, value),
        getData: type => transferred.get(type) || '',
    };
    const drag = async (f, target, type, point = {}) => {
        const event = new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...point });
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
        await f.act(async () => target.dispatchEvent(event));
        return event;
    };
    const legacy = await reactFixture('export { StudioBlockPicker } from "./components/automation/studio-block-picker";');
    try {
        await legacy.render(legacy.React.createElement(legacy.exports.StudioBlockPicker, { catalog: catalogs, contextText: '追加する位置', onPick() {} }));
        const card = legacy.container.querySelector(`.studio-block-choice[aria-label="${catalogs.nodes.delay.label}"]`); assert(card);
        assert.equal(card.draggable, true);
        await drag(legacy, card, 'dragstart');
        assert.equal(transferred.get('application/cbte-automation-block'), 'delay');
        assert.equal(dataTransfer.effectAllowed, 'copy');
        assert.equal(card.isConnected, true);
    } finally { await legacy.close(); }
    const original = arbitraryRule();
    original.layout = { viewport: { x: 0, y: 0, zoom: 1 } };
    const f = await editorFixture(original);
    try {
        await press(f, `${catalogs.nodes.start.label}の次へにブロックを追加`);
        const card = f.container.querySelector(`.studio-block-choice[aria-label="${catalogs.nodes.delay.label}"]`); assert(card);
        assert.equal(card.draggable, false, 'the canvas picker uses a pointer gesture');
        const pointer = async (target, type, x, y, pointerId = 7) => {
            const point = { clientX: x, clientY: y, button: 0 };
            const event = new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...point });
            Object.defineProperties(event, { pointerType: { value: 'mouse' }, pointerId: { value: pointerId } });
            await f.act(async () => target.dispatchEvent(event));
            return event;
        };
        const canvas = f.container.querySelector('.studio-canvas-surface'); assert(canvas);
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, x: 0, y: 0, width: 1000, height: 800 });
        await pointer(card, 'pointerdown', 100, 100);
        await pointer(f.dom.window, 'pointermove', 102, 102);
        assert.equal(f.container.querySelector('.studio-picker-dragging'), null, 'a short click movement does not start placement');
        await pointer(f.dom.window, 'pointermove', 110, 110);
        assert.equal(card.isConnected, true, 'the pointer source remains mounted while dragging');
        assert(f.container.querySelector('.studio-canvas-library.studio-picker-dragging'));
        await pointer(f.dom.window, 'pointerup', 145, 340, 8);
        assert.deepEqual(f.latest(), original, 'a different pointer cannot complete the placement');
        await pointer(f.dom.window, 'pointerup', -40, -40);
        assert.deepEqual(f.latest(), original, 'release outside the canvas does not add a block');
        assert.equal(f.container.querySelector('.studio-picker-dragging'), null);
        await f.act(async () => card.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true })));
        assert.deepEqual(f.latest(), original, 'the follow-up click after dragging cannot insert an unintended connected block');
        await pointer(card, 'pointerdown', 100, 100); await pointer(f.dom.window, 'pointermove', 110, 110);
        await pointer(f.dom.window, 'pointerup', 145, 340); await settle(f);
        const added = f.latest().nodes.find(node => node.type === 'delay'); assert(added);
        assert.deepEqual(added.position, { x: 100, y: 200 }, 'the screen position is converted back into stored graph coordinates');
        assert.deepEqual(f.latest().nodes.filter(node => node.id !== added.id), original.nodes);
        assert.deepEqual(f.latest().edges, original.edges, 'pointer placement creates an explicitly unconnected block');
        assert.deepEqual(f.latest().layout, original.layout);
        assert.equal(field(f, '編集するブロック').value, added.id);
        assert.equal(f.container.querySelector('.studio-canvas-library'), null);
        await press(f, '元に戻す'); await settle(f); assert.deepEqual(f.latest(), original);
        assert.equal((await drag(f, canvas, 'dragover')).defaultPrevented, true);
        assert.equal(dataTransfer.dropEffect, 'copy');
        await drag(f, canvas, 'drop', { clientX: 290, clientY: 510 }); await settle(f);
        assert.deepEqual(f.latest().nodes.at(-1).position, { x: 200, y: 300 });
        assert.deepEqual(f.latest().edges, original.edges);
        await press(f, '元に戻す'); await settle(f); assert.deepEqual(f.latest(), original);
        await press(f, 'テキスト'); await f.fill(field(f, 'ルールJSONまたはYAML'), 'nodes: [incomplete'); await settle(f, 510);
        await press(f, 'ブロック');
        const lockedCanvas = f.container.querySelector('.studio-canvas-surface');
        lockedCanvas.getBoundingClientRect = canvas.getBoundingClientRect;
        await drag(f, lockedCanvas, 'drop', { clientX: 290, clientY: 510 });
        assert.deepEqual(f.latest(), original, 'an unfinished source draft cannot be overwritten by a drop event');
    } finally { await f.close(); }
});

async function workspaceFixture({ existing = null, canEdit = true, activationFails = false, postAttachReadFailure = null, saveRateLimited = false } = {}) {
    const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
    flowEnvironment(f);
    const requests = [], monitors = [
        { id: 'private-monitor', kind: 'auto', name: '自分の通知', scope: 'private', providerId: 'github', source: 'https://example.test/private', enabled: true, destinationId: 'dm', destinationType: 'dm', revision: 1 },
        { id: 'shared-monitor', kind: 'auto', name: '共有の通知', scope: 'guild', providerId: 'github', source: 'https://example.test/shared', enabled: true, destinationId: 'dm', revision: 1 },
    ];
    let stored = existing ? structuredClone(existing) : null, attached = false;
    f.set('fetch', async (address, options) => {
        const url = new URL(address, 'http://127.0.0.1'), route = url.pathname.slice('/api/automation/'.length);
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ route, method: options.method, body });
        if (attached && options.method === 'GET' && (postAttachReadFailure === 'workflow' && route === `workflows/${stored?.id}` || postAttachReadFailure === 'list' && route === 'workflows')) {
            postAttachReadFailure = null;
            return new Response(JSON.stringify({ error: 'fixture post-attach read failed' }), { status: 503 });
        }
        let result;
        if (route === 'catalog') result = catalogs;
        else if (route === 'providers') result = { auto: [{ id: 'github' }], price: [{ id: 'steam' }], autoRegistration: { eligible: true } };
        else if (route === 'entitlements') result = { plan: { name: '無料プラン', priority: 0, slotLimit: 5, dayLimit: 24, minuteLimit: 5 }, slots: { used: 2, max: 5, available: 3 }, usage: { entries: [] } };
        else if (route === 'destinations') result = { items: [{ id: 'dm', name: '自分のDM', kind: 'dm', scope: 'private', enabled: true }] };
        else if (route === 'dictionaries' || route === 'x-monitors') result = { items: [] };
        else if (route === 'template') result = template(url.searchParams.get('goal'), url.searchParams.get('time'), url.searchParams.get('format'));
        else if (route.startsWith('monitors/')) result = { items: monitors.filter(row => row.kind === route.slice(9)), nextCursor: null };
        else if (route === 'validate') {
            const definition = body.text === undefined ? body.definition : parseWorkflow(body.text, body.format), validation = validateWorkflow(definition);
            result = { ...validation, text: stringifyDraft(definition, body.format), ...(validation.valid ? { definition } : {}) };
        } else if (route === 'workflows' && options.method === 'GET') result = { items: stored ? [stored] : [] };
        else if (route === 'workflows' && options.method === 'POST') {
            if (saveRateLimited) { saveRateLimited = false; return new Response(JSON.stringify({ code: 'AUTOMATION_RATE_LIMITED', error: 'internal quota implementation' }), { status: 429, headers: { 'Retry-After': '2' } }); }
            stored = { id: 'saved-rule', name: body.definition.name, draft: structuredClone(body.definition), bindings: structuredClone(body.bindings), scope: body.scope, revision: 1, enabled: false, activeRevision: null };
            result = structuredClone(stored);
        } else if (route === `workflows/${stored?.id}` && options.method === 'GET') result = structuredClone(stored);
        else if (route === `workflows/${stored?.id}` && options.method === 'PATCH') {
            assert.equal(body.expectedRevision, stored.revision);
            stored = { ...stored, revision: stored.revision + 1, name: body.definition.name, draft: structuredClone(body.definition), bindings: structuredClone(body.bindings) }; result = structuredClone(stored);
        } else if (route === `workflows/${stored?.id}/activation-preview`) { result = { expectedRevision: stored.revision, expectedTargetsToken: "fixture-target-token", affectedTargets: monitors.filter(row => row.workflowId === stored.id) };
        } else if (route === `workflows/${stored?.id}/activate`) {
            assert.equal(body.expectedRevision, stored.revision); assert.equal(body.expectedTargetsToken, "fixture-target-token");
            if (activationFails) { activationFails = false; return new Response(JSON.stringify({ error: 'fixture revision conflict' }), { status: 409 }); }
            stored = { ...stored, activeRevision: stored.revision, enabled: true }; result = structuredClone(stored);
        } else if (route === `workflows/${stored?.id}/attach`) {
            assert.equal(stored.activeRevision, stored.revision, 'attach happens only after the saved version is active');
            assert.equal(stored.enabled, true);
            const monitor = monitors.find(row => row.kind === body.targetKind && row.id === body.targetId); assert(monitor);
            assert.equal(monitor.scope, stored.scope); monitor.workflowId = stored.id; attached = true; result = { ok: true };
        } else throw new Error(`Unexpected fixture request: ${options.method} ${route}`);
        return new Response(JSON.stringify(result), { status: 200 });
    });
    await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222', guildId: '111111111111111111', canEdit })); await f.settle();
    await press(f, '通知ルール'); await f.settle();
    return Object.assign(f, { requests, stored: () => stored });
}

test('new rule starters and template choices default to normal Bot expansion and allow direct delivery', { timeout: 10000 }, async () => {
    const f = await workspaceFixture();
    try {
        const display = field(f, '表示形式');
        assert.equal(display.value, 'normal');
        assert.deepEqual([...display.options].slice(0, 2).map(option => [option.value, option.textContent]), [['normal', '通常のBot展開'], ['expanded', '通知側で直接展開']]);
        await press(f, '新しいルール'); await settle(f);
        await f.fill(field(f, '編集するブロック'), 'display'); await f.settle();
        assert.equal(button(f, '通常のBot展開').getAttribute('aria-pressed'), 'true');
        await press(f, '通知側で直接展開'); await settle(f);
        await press(f, '下書きを保存'); await settle(f);
        assert.equal(f.stored().draft.nodes.find(node => node.type === 'transform').config.format, 'expanded');
        assert.equal(f.stored().draft.nodes.find(node => node.type === 'transform').config.template, '{title}\n{url}');
    } finally { await f.close(); }
});

test('a new rule is saved and activated before assignment; failed activation cannot attach and a retry uses the saved draft', { timeout: 10000 }, async () => {
    const f = await workspaceFixture({ activationFails: true });
    try {
        await press(f, '新しいルール'); await settle(f);
        await f.fill(field(f, 'ルール名'), '編集した通知ルール'); await settle(f);
        await press(f, '通知を選ぶ'); await f.settle();
        const target = field(f, 'ルールを使う通知'); assert(target);
        assert.deepEqual([...target.querySelectorAll('option')].map(node => node.value), ['', 'auto:private-monitor'], 'a private rule can select only notifications in the same scope');
        await f.fill(target, 'auto:private-monitor');
        assert.equal(button(f, '保存して通知に適用').disabled, false);
        await press(f, '保存して通知に適用'); await settle(f);
        assert(f.container.textContent.includes('fixture revision conflict'));
        const writes = () => f.requests.filter(item => item.method !== 'GET' && item.route !== 'validate');
        assert.deepEqual(writes().map(item => `${item.method} ${item.route}`), ['POST workflows', 'POST workflows/saved-rule/activate']);
        assert.equal(writes()[0].body.definition.name, '編集した通知ルール');
        assert.equal(f.stored().enabled, false);
        await press(f, '保存して通知に適用'); await settle(f);
        assert.deepEqual(writes().map(item => `${item.method} ${item.route}`), ['POST workflows', 'POST workflows/saved-rule/activate', 'POST workflows/saved-rule/activate', 'POST workflows/saved-rule/attach']);
        assert.deepEqual(writes().at(-1).body, { targetKind: 'auto', targetId: 'private-monitor', expectedRevision: 1, expectedWorkflowId: null });
        assert.equal(f.stored().activeRevision, 1);
        assert(f.container.textContent.includes('「自分の通知」に適用しました。'));
        assert.equal(f.container.querySelector('dialog'), null, 'successful assignment closes the dialog');
        await press(f, '通知を選ぶ'); await f.settle();
        assert(f.container.querySelector('.studio-attached-notifications').textContent.includes('自分の通知'));
    } finally { await f.close(); }
});

test('successful assignment stays successful when either workflow or list reload fails, and read retry does not repeat mutations', { timeout: 10000 }, async () => {
    for (const postAttachReadFailure of ['workflow', 'list']) {
        const f = await workspaceFixture({ postAttachReadFailure });
        try {
            await press(f, '新しいルール'); await settle(f);
            await press(f, '通知を選ぶ'); await f.settle();
            await f.fill(field(f, 'ルールを使う通知'), 'auto:private-monitor');
            await press(f, '保存して通知に適用'); await settle(f);
            assert(f.container.textContent.includes('「自分の通知」に適用しました。'), `${postAttachReadFailure}: committed assignment is shown as successful`);
            assert(f.container.textContent.includes('通知に適用済みです。画面を再読み込みしてください。'));
            assert(!f.container.textContent.includes('fixture post-attach read failed'), 'a post-commit read failure is shown as a recoverable display warning');
            const writes = () => f.requests.filter(item => item.method !== 'GET' && item.route !== 'validate');
            const committed = structuredClone(writes());
            assert.deepEqual(committed.map(item => `${item.method} ${item.route}`), ['POST workflows', 'POST workflows/saved-rule/activate', 'POST workflows/saved-rule/attach']);
            assert.equal(f.stored().enabled, true); assert.equal(f.stored().activeRevision, 1);
            await press(f, '再読み込み'); await f.settle();
            assert.deepEqual(writes(), committed, 'reloading the display cannot save, activate or attach a second time');
            assert(!f.container.textContent.includes('画面を再読み込みしてください。'));
        } finally { await f.close(); }
    }
});

test('shared rules without edit permission remain viewable but cannot be saved, activated or assigned', async () => {
    const draft = arbitraryRule();
    const existing = { id: 'shared-rule', name: draft.name, draft, bindings, scope: 'guild', revision: 4, activeRevision: 3, enabled: true };
    const f = await workspaceFixture({ existing, canEdit: false });
    try {
        const card = f.container.querySelector('.studio-rule-card'); assert(card);
        await f.act(async () => card.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true }))); await settle(f);
        assert.equal(field(f, 'ルール名').readOnly, true);
        assert.equal(button(f, '下書きを保存').disabled, true);
        assert.equal(button(f, '通知に適用').disabled, true);
        await press(f, '通知を選ぶ'); await f.settle();
        const target = field(f, 'ルールを使う通知'); assert(target);
        assert.equal(target.disabled, true);
        assert.deepEqual([...target.querySelectorAll('option')].map(node => node.value), ['', 'auto:shared-monitor']);
        assert.equal(button(f, '保存して通知に適用').disabled, true);
        assert.deepEqual(f.requests.filter(item => item.method !== 'GET' && item.route !== 'validate'), []);
    } finally { await f.close(); }
});

test('nested conditions edit inside the block and text editing shortcuts cannot remove or duplicate blocks', async () => {
    const original = branchedRule(), f = await editorFixture(original, { controlledFlow: true });
    try {
        assert.equal(f.container.querySelector('.studio-flow-inline'), null);
        await press(f, `${catalogs.nodes.condition.label}の内容を編集`);
        const inline = f.container.querySelector('.studio-flow-inline'); assert(inline);
        assert.equal(inline.closest('.studio-flow-block').dataset.kind, 'condition');
        await press(f, '条件 1 の子条件');
        await press(f, '条件 1.1 を編集');
        const input = field(f, '比較する値'); assert(inline.contains(input));
        await f.fill(input, '限定セール');
        assert.equal(f.latest().nodes.find(node => node.id === 'gate_c91').config.predicate.conditions[0].conditions[0].value, '限定セール');
        assert.deepEqual(f.latest().nodes.find(node => node.id === 'gate_c91').config.predicate.conditions[1], original.nodes.find(node => node.id === 'gate_c91').config.predicate.conditions[1]);
        const edited = structuredClone(f.latest());
        for (const [key, modifiers] of [['Delete', {}], ['Backspace', {}], ['d', { ctrlKey: true }], ['a', { ctrlKey: true }], ['z', { ctrlKey: true }]]) {
            const event = await keyboard(f, input, key, modifiers);
            assert.equal(event.defaultPrevented, false, `${key}: ordinary input editing is not intercepted`);
            assert.deepEqual(f.latest(), edited);
        }
        const copiedText = await clipboardEvent(f, 'copy', '', input);
        assert.equal(copiedText.event.defaultPrevented, false);
        assert.equal(copiedText.contents.size, 0);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.deepEqual(f.latest(), original, 'canvas undo restores the edited nested leaf');
    } finally { await f.close(); }
});

test('controlled range selection supports partial copy, cut, paste and duplicate with internal branches and groups intact', async () => {
    const original = branchedRule(), f = await editorFixture(original, { controlledFlow: true });
    try {
        canvasGeometry(f);
        assert.equal(f.flowControl.props.selectionOnDrag, true);
        assert.equal(f.flowControl.props.selectionKeyCode, null);
        assert.equal(f.flowControl.props.selectionMode, 'partial');
        await selectBlocks(f, ['gate_c91', 'deliver_z81']);
        assert.deepEqual(f.flowControl.props.nodes.filter(node => node.selected).map(node => node.id).sort(), ['deliver_z81', 'gate_c91']);
        assert(f.container.querySelector('.studio-selection-bar').textContent.includes('2個を選択'));
        const copied = await clipboardEvent(f, 'copy');
        assert.equal(copied.event.defaultPrevented, true);
        const part = copied.payload();
        assert.deepEqual(part.nodes.map(node => node.id).sort(), ['deliver_z81', 'gate_c91']);
        assert.deepEqual(part.edges, [original.edges.find(edge => edge.id === 'b')]);
        assert.deepEqual(part.groups, original.layout.groups);
        const copiedGate = part.nodes.find(node => node.id === 'gate_c91');
        assert.deepEqual(copiedGate.config, original.nodes.find(node => node.id === 'gate_c91').config);
        await keyboard(f, editorRoot(f), 'd', { ctrlKey: true });
        assert.equal(f.latest().nodes.length, 6); assert.equal(f.latest().edges.length, 4);
        const duplicated = f.latest().nodes.slice(4), newGroup = f.latest().layout.groups.at(-1);
        assert(duplicated.every(node => node.group === newGroup.id && !original.nodes.some(old => old.id === node.id)));
        assert.notEqual(newGroup.id, 'filtering');
        assert.deepEqual(duplicated.map(node => node.config), part.nodes.map(node => node.config));
        assert.deepEqual(f.latest().nodes.slice(0, 4), original.nodes);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true }); assert.deepEqual(f.latest(), original);
        await selectBlocks(f, ['gate_c91', 'deliver_z81']);
        const cut = await clipboardEvent(f, 'cut');
        assert.deepEqual(f.latest().nodes.map(node => node.id), ['ingest_a29', 'excluded_14']);
        assert.deepEqual(f.latest().edges, []);
        assert.deepEqual(f.latest().layout.groups, []);
        const pasted = await clipboardEvent(f, 'paste', JSON.stringify(cut.payload()));
        assert.equal(pasted.event.defaultPrevented, true);
        assert.equal(f.latest().nodes.length, 4); assert.equal(f.latest().edges.length, 1);
        const added = f.latest().nodes.slice(2), edge = f.latest().edges[0];
        assert.equal(edge.source, added.find(node => node.type === 'condition').id);
        assert.equal(edge.target, added.find(node => node.type === 'send').id); assert.equal(edge.port, 'yes');
        assert.deepEqual(added.map(node => node.config), part.nodes.map(node => node.config));
        assert.notEqual(f.latest().layout.groups[0].id, 'filtering');
        assert.deepEqual(f.latest().layout.viewport, original.layout.viewport);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.deepEqual(f.latest(), original, 'undo restores the original external connections, IDs, groups and positions');
    } finally { await f.close(); }
});

test('inline resource choices and pasted binding collisions are one undoable graph-and-binding change', async () => {
    const first = '00000000-0000-0000-0000-000000000001', second = '00000000-0000-0000-0000-000000000002';
    const original = arbitraryRule(); original.nodes.find(node => node.type === 'send').config.destination = 'alerts';
    const initialBindings = { destinations: { alerts: first }, dictionaries: {} }, resources = { destinations: [{ id: first, name: '自分のDM' }, { id: second, name: 'チャンネル通知' }], dictionaries: [] };
    const f = await editorFixture(original, { controlledFlow: true, bindings: initialBindings, resources });
    try {
        canvasGeometry(f);
        await press(f, `${catalogs.nodes.send.label}の内容を編集`);
        await f.fill(field(f, '通知の宛先'), second);
        const alias = f.latest().nodes.find(node => node.type === 'send').config.destination;
        assert.notEqual(alias, 'alerts'); assert.equal(f.latestBindings().destinations[alias], second);
        assert.equal(f.latestBindings().destinations.alerts, undefined, 'the replaced and unused destination alias is removed');
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.deepEqual(f.latest(), original); assert.deepEqual(f.latestBindings(), initialBindings);
        const incoming = copySelection(original, ['deliver_z81'], { destinations: { alerts: second }, dictionaries: {} });
        await clipboardEvent(f, 'paste', JSON.stringify(incoming));
        assert.equal(f.latest().nodes.at(-1).config.destination, 'alerts_copy');
        assert.equal(f.latest().nodes[1].config.destination, 'alerts');
        assert.equal(f.latestBindings().destinations.alerts, first);
        assert.equal(f.latestBindings().destinations.alerts_copy, second);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.deepEqual(f.latest(), original); assert.deepEqual(f.latestBindings(), initialBindings);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true, shiftKey: true });
        assert.equal(f.latest().nodes.at(-1).config.destination, 'alerts_copy');
        assert.equal(f.latestBindings().destinations.alerts_copy, second);
    } finally { await f.close(); }
});

test('context menus operate on the clicked selection and edge, support keyboard navigation, and direct ports connect distinct branches', async () => {
    const original = branchedRule(), f = await editorFixture(original, { controlledFlow: true });
    try {
        await contextAt(f, 'node', 'gate_c91');
        assert(menuItem(f, 'ブロックを編集'));
        assert.equal(menuItem(f, 'コピー').disabled, false);
        assert.equal(menuItem(f, '複製').disabled, false);
        const menu = f.container.querySelector('[role="menu"]');
        await keyboard(f, menu, 'End');
        assert.equal(f.dom.window.document.activeElement, menuItem(f, '全体を表示'));
        await keyboard(f, menu, 'Home');
        assert.equal(f.dom.window.document.activeElement, menuItem(f, 'ブロックを編集'));
        await clickElement(f, menuItem(f, '複製'));
        assert.equal(f.container.querySelector('[role="menu"]'), null);
        assert.equal(f.latest().nodes.length, 5);
        assert.deepEqual(f.latest().nodes.at(-1).config, original.nodes.find(node => node.id === 'gate_c91').config);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true }); assert.deepEqual(f.latest(), original);
        await contextAt(f, 'edge', 'b');
        assert(menuItem(f, '接続の途中に追加'));
        await clickElement(f, menuItem(f, '接続を削除'));
        assert.deepEqual(f.latest().nodes, original.nodes);
        assert.deepEqual(f.latest().edges.map(edge => edge.id), ['a', 'c']);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true }); assert.deepEqual(f.latest(), original);
        await clickElement(f, field(f, `${catalogs.nodes.condition.label}の情報不足から接続`));
        await clickElement(f, field(f, `${catalogs.nodes.stop.label}に接続`));
        assert(f.latest().edges.some(edge => edge.source === 'gate_c91' && edge.target === 'excluded_14' && edge.port === 'unknown'));
        assert.deepEqual(f.latest().edges.slice(0, 3), original.edges);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        await keyboard(f, editorRoot(f), 'a', { ctrlKey: true });
        assert.equal(f.flowControl.props.nodes.filter(node => node.selected).length, original.nodes.length);
        await keyboard(f, editorRoot(f), 'Delete');
        assert.deepEqual(f.latest().nodes.map(node => node.id), ['ingest_a29'], 'bulk delete protects the start block');
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true }); assert.deepEqual(f.latest(), original);
        await press(f, 'キャンバスを移動'); assert.equal(f.flowControl.props.selectionOnDrag, false);
        await press(f, '範囲選択'); assert.equal(f.flowControl.props.selectionOnDrag, true);
    } finally { await f.close(); }
});

test('read-only graphs permit copying and selection but block cut, paste, delete, duplicate and context mutations', async () => {
    const original = branchedRule(), f = await editorFixture(original, { controlledFlow: true, readOnly: true });
    try {
        await keyboard(f, editorRoot(f), 'a', { ctrlKey: true });
        const copy = await clipboardEvent(f, 'copy');
        assert.equal(copy.event.defaultPrevented, true); assert.equal(copy.payload().nodes.length, 3);
        const cut = await clipboardEvent(f, 'cut'), paste = await clipboardEvent(f, 'paste', JSON.stringify(copy.payload()));
        assert.equal(cut.event.defaultPrevented, false); assert.equal(paste.event.defaultPrevented, false);
        await keyboard(f, editorRoot(f), 'Delete'); await keyboard(f, editorRoot(f), 'd', { ctrlKey: true });
        assert.deepEqual(f.latest(), original);
        await contextAt(f, 'node', 'gate_c91');
        assert.equal(menuItem(f, 'コピー').disabled, false);
        for (const label of ['カット', '貼り付け', '複製', '選択を削除', '選択をグループ化', '接続順に整列']) assert.equal(menuItem(f, label).disabled, true, label);
        await clickElement(f, menuItem(f, 'ブロックを編集'));
        assert(f.container.querySelector('.studio-flow-inline'));
        await press(f, '条件 1 の子条件'); await press(f, '条件 1.1 を編集');
        assert.equal(field(f, '比較する値').closest('fieldset').disabled, true);
        assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('inserting from an edge context menu splits that edge without moving blocks or rerouting a parallel branch', async () => {
    const original = branchedRule();
    const parallel = { id: 'parallel_yes', source: 'gate_c91', target: 'excluded_14', port: 'yes' };
    original.edges.push(parallel);
    const f = await editorFixture(original, { controlledFlow: true });
    try {
        await contextAt(f, 'edge', 'b');
        await clickElement(f, menuItem(f, '接続の途中に追加'));
        await press(f, catalogs.nodes.delay.label);
        const inserted = f.latest().nodes.at(-1); assert.equal(inserted.type, 'delay');
        assert.deepEqual(f.latest().nodes.slice(0, original.nodes.length), original.nodes, 'the surrounding blocks keep their exact saved positions and configuration');
        assert.deepEqual(f.latest().edges.find(edge => edge.id === parallel.id), parallel);
        assert(f.latest().edges.some(edge => edge.source === 'gate_c91' && edge.target === inserted.id && edge.port === 'yes'));
        assert(f.latest().edges.some(edge => edge.source === inserted.id && edge.target === 'deliver_z81' && edge.port === 'out'));
        assert(!f.latest().edges.some(edge => edge.source === inserted.id && edge.target === 'excluded_14'));
        assert.equal(f.latest().edges.length, original.edges.length + 1);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('delayed browser clipboard reads cannot paste into a different mounted rule or overwrite an unfinished text draft', async () => {
    const original = arbitraryRule(), replacement = newWorkflow('次に開いたルール'), f = await editorFixture(original, { controlledFlow: true });
    try {
        let resolveRead;
        const read = () => new Promise(resolve => { resolveRead = resolve; });
        Object.defineProperty(f.dom.window.navigator, 'clipboard', { configurable: true, value: { readText: read } });
        await keyboard(f, editorRoot(f), 'a', { ctrlKey: true });
        await press(f, '貼り付け'); assert(resolveRead);
        await f.replace(replacement);
        await f.act(async () => resolveRead(JSON.stringify(copySelection(original, ['deliver_z81']))));
        assert.deepEqual(f.latest(), replacement, 'the old editor cannot write through its callback after unmount');
        canvasGeometry(f);
        await keyboard(f, editorRoot(f), 'a', { ctrlKey: true });
        await press(f, '貼り付け');
        await press(f, 'テキスト');
        await f.fill(field(f, 'ルールJSONまたはYAML'), 'nodes: [do not replace');
        await f.act(async () => resolveRead(JSON.stringify(copySelection(original, ['deliver_z81']))));
        assert.deepEqual(f.latest(), replacement);
        assert.equal(field(f, 'ルールJSONまたはYAML').value, 'nodes: [do not replace');
    } finally { await f.close(); }
});

test('a successfully read foreign clipboard never pastes stale local blocks or leaks its contents, while denied access keeps local copy usable', async () => {
    const original = arbitraryRule(), f = await editorFixture(original, { controlledFlow: true });
    try {
        let raw = '', denyRead = false;
        Object.defineProperty(f.dom.window.navigator, 'clipboard', { configurable: true, value: { readText: async () => { if (denyRead) throw new Error('clipboard denied'); return raw; } } });
        canvasGeometry(f);
        await keyboard(f, editorRoot(f), 'a', { ctrlKey: true });
        const copied = await clipboardEvent(f, 'copy'); assert.equal(copied.payload().nodes.length, 1);
        for (const text of ['not-valid-JSON PRIVATE_CLIPBOARD_SECRET', '']) {
            raw = text;
            await contextAt(f, 'node', 'deliver_z81');
            await clickElement(f, menuItem(f, '貼り付け'));
            assert.deepEqual(f.latest(), original, 'successfully reading another clipboard must not fall back to the old block copy');
            assert(f.container.querySelector('[role="alert"]').textContent.includes('コピーしたブロックのみ貼り付けできます'));
            assert(!f.container.textContent.includes('PRIVATE_CLIPBOARD_SECRET'));
        }
        await clipboardEvent(f, 'paste', 'not-valid-JSON PRIVATE_NATIVE_CLIPBOARD_SECRET');
        assert.deepEqual(f.latest(), original);
        assert(f.container.querySelector('[role="alert"]').textContent.includes('コピーしたブロックのみ貼り付けできます'));
        assert(!f.container.textContent.includes('PRIVATE_NATIVE_CLIPBOARD_SECRET'));
        await clipboardEvent(f, 'paste');
        assert.deepEqual(f.latest(), original, 'an empty native clipboard also cannot paste the old block copy');
        denyRead = true;
        await contextAt(f, 'node', 'deliver_z81'); await clickElement(f, menuItem(f, '貼り付け'));
        assert.equal(f.latest().nodes.length, 3);
        assert.deepEqual(f.latest().nodes.at(-1).config, original.nodes.find(node => node.type === 'send').config);
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true }); assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('an indefinitely pending browser clipboard read falls back promptly to the local block selection and ignores a late result', async () => {
    const original = branchedRule(), f = await editorFixture(original, { controlledFlow: true });
    try {
        let resolveRead;
        Object.defineProperty(f.dom.window.navigator, 'clipboard', { configurable: true, value: { readText: () => new Promise(resolve => { resolveRead = resolve; }) } });
        await selectBlocks(f, ['gate_c91', 'deliver_z81']);
        const copied = await clipboardEvent(f, 'copy');
        await contextAt(f, 'selection'); await clickElement(f, menuItem(f, '貼り付け'));
        assert(resolveRead); assert.deepEqual(f.latest(), original, 'the read is still waiting');
        await settle(f, 260);
        assert.equal(f.latest().nodes.length, original.nodes.length + 2);
        assert.equal(f.latest().edges.length, original.edges.length + 1);
        assert.deepEqual(f.latest().nodes.slice(original.nodes.length).map(node => node.config), copied.payload().nodes.map(node => node.config));
        const pasted = structuredClone(f.latest());
        await f.act(async () => resolveRead(JSON.stringify(copySelection(original, ['deliver_z81']))));
        assert.deepEqual(f.latest(), pasted, 'the result arriving after the deadline cannot create a second paste');
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true }); assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('a native paste cancels an already pending context paste so neither its timeout nor its late clipboard result duplicates blocks', async () => {
    const original = arbitraryRule(), f = await editorFixture(original, { controlledFlow: true });
    try {
        let resolveRead;
        Object.defineProperty(f.dom.window.navigator, 'clipboard', { configurable: true, value: { readText: () => new Promise(resolve => { resolveRead = resolve; }) } });
        await keyboard(f, editorRoot(f), 'a', { ctrlKey: true });
        const copied = await clipboardEvent(f, 'copy');
        await contextAt(f, 'node', 'deliver_z81'); await clickElement(f, menuItem(f, '貼り付け')); assert(resolveRead);
        await clipboardEvent(f, 'paste', JSON.stringify(copied.payload()));
        assert.equal(f.latest().nodes.length, original.nodes.length + 1);
        const pasted = structuredClone(f.latest());
        await settle(f, 260);
        assert.deepEqual(f.latest(), pasted, 'the pending context paste is invalidated before its fallback deadline');
        await f.act(async () => resolveRead(JSON.stringify(copied.payload())));
        assert.deepEqual(f.latest(), pasted, 'a later browser read does not duplicate the native paste');
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true }); assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('numeric block inputs retain empty drafts and negative values, while empty numeric candidates block saving until completed', async () => {
    const original = arbitraryRule();
    original.nodes.push({ id: 'price_gate', type: 'condition', config: { predicate: { field: 'priceDelta', op: 'lte', value: -100 } }, position: { x: 250, y: 80 } },
        { id: 'wait_a17', type: 'delay', config: structuredClone(NODE_TYPES.delay.defaults), position: { x: 510, y: 80 } });
    original.edges = [{ id: 'enter', source: 'ingest_a29', target: 'price_gate', port: 'out' },
        { id: 'discount', source: 'price_gate', target: 'wait_a17', port: 'yes' },
        { id: 'waited', source: 'wait_a17', target: 'deliver_z81', port: 'out' }];
    const f = await editorFixture(original, { controlledFlow: true });
    const predicate = () => f.latest().nodes.find(node => node.id === 'price_gate').config.predicate;
    try {
        await press(f, `${catalogs.nodes.condition.label}の内容を編集`);
        const comparison = field(f, '比較する値'); assert.equal(comparison.type, 'number');
        await f.fill(comparison, '');
        assert.equal(comparison.value, ''); assert.equal(predicate().value, '', 'clearing a number cannot restore zero');
        await settle(f); assert.equal(f.valid(), false);
        await f.fill(comparison, '-');
        assert.equal(comparison.value, '', 'the native number input represents an incomplete sign as empty');
        assert.equal(predicate().value, '');
        await f.fill(comparison, '-500');
        assert.equal(predicate().value, -500); assert.equal(typeof predicate().value, 'number');
        await settle(f); assert.equal(f.valid(), true);
        await f.fill(field(f, '比較方法'), 'in');
        assert.deepEqual(predicate().value, [-500]);
        const candidate = field(f, '候補 1');
        await f.fill(candidate, '');
        assert.equal(candidate.value, ''); assert.deepEqual(predicate().value, [null]);
        assert.equal(validateWorkflow(f.latest()).valid, false, 'an unfinished candidate is not an accepted mixed-type empty string');
        await settle(f); assert.equal(f.valid(), false);
        await f.fill(candidate, '-500');
        assert.deepEqual(predicate().value, [-500]);
        await settle(f); assert.equal(f.valid(), true);
        await press(f, `${catalogs.nodes.delay.label}の内容を編集`);
        const minutes = field(f, '待ち時間（分）');
        await f.fill(minutes, '');
        assert.equal(minutes.value, ''); assert.equal(f.latest().nodes.find(node => node.id === 'wait_a17').config.minutes, '');
        await settle(f); assert.equal(f.valid(), false);
        await f.fill(minutes, '15');
        assert.equal(f.latest().nodes.find(node => node.id === 'wait_a17').config.minutes, 15);
        await settle(f); assert.equal(f.valid(), true);
        assert.deepEqual(predicate().value, [-500], 'editing another block preserves the completed numeric candidate');
    } finally { await f.close(); }
});

test('editing a generated-looking shared dictionary alias changes only the chosen block and restores both blocks and references in one undo', async () => {
    const first = '00000000-0000-0000-0000-000000000001', second = '00000000-0000-0000-0000-000000000002';
    const original = arbitraryRule();
    original.nodes.push({ id: 'first', type: 'dictionary', config: { dictionary: 'dict_first', fields: ['title'] }, position: { x: 250, y: 80 } },
        { id: 'second', type: 'dictionary', config: { dictionary: 'dict_first', fields: ['body'] }, position: { x: 510, y: 80 } });
    original.edges = [{ id: 'enter', source: 'ingest_a29', target: 'first', port: 'out' },
        { id: 'next', source: 'first', target: 'second', port: 'yes' }, { id: 'notify', source: 'second', target: 'deliver_z81', port: 'yes' }];
    const initialBindings = { destinations: {}, dictionaries: { dict_first: { id: first, revision: 1 } } }, resources = {
        destinations: [], dictionaries: [{ id: first, name: '元の辞書', revision: 1 }, { id: second, name: '別の辞書', revision: 7 }],
    };
    const f = await editorFixture(original, { controlledFlow: true, bindings: initialBindings, resources });
    try {
        await press(f, `${catalogs.nodes.dictionary.label}の内容を編集`);
        assert.equal(field(f, '照合する辞書').value, `${first}:1`);
        await f.fill(field(f, '照合する辞書'), `${second}:7`);
        const chosen = f.latest().nodes.find(node => node.id === 'first'), unchanged = f.latest().nodes.find(node => node.id === 'second');
        assert.notEqual(chosen.config.dictionary, 'dict_first');
        assert.deepEqual(unchanged, original.nodes.find(node => node.id === 'second'));
        assert.deepEqual(f.latestBindings().dictionaries.dict_first, { id: first, revision: 1 });
        assert.deepEqual(f.latestBindings().dictionaries[chosen.config.dictionary], { id: second, revision: 7 });
        assert.deepEqual(chosen.config.fields, ['title']);
        assert.deepEqual(f.latest().edges, original.edges);
        const changed = structuredClone(f.latest()), changedBindings = structuredClone(f.latestBindings());
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.deepEqual(f.latest(), original); assert.deepEqual(f.latestBindings(), initialBindings);
        assert.equal(button(f, '元に戻す').disabled, true, 'the graph and binding update is exactly one history entry');
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true, shiftKey: true });
        assert.deepEqual(f.latest(), changed); assert.deepEqual(f.latestBindings(), changedBindings);
    } finally { await f.close(); }
});

test('dictionary choices distinguish an older pinned revision from the latest revision of the same dictionary and allow an explicit undoable upgrade', async () => {
    const id = '00000000-0000-0000-0000-000000000001', original = arbitraryRule();
    original.nodes.push({ id: 'first', type: 'dictionary', config: { dictionary: 'dict_first', fields: ['title', 'body'] }, position: { x: 250, y: 80 } });
    original.edges = [{ id: 'enter', source: 'ingest_a29', target: 'first', port: 'out' }, { id: 'notify', source: 'first', target: 'deliver_z81', port: 'yes' }];
    const initialBindings = { destinations: {}, dictionaries: { dict_first: { id, revision: 1 } } }, resources = { destinations: [], dictionaries: [{ id, name: '通知キーワード', revision: 2 }] };
    const f = await editorFixture(original, { controlledFlow: true, bindings: initialBindings, resources });
    try {
        await press(f, `${catalogs.nodes.dictionary.label}の内容を編集`);
        const select = field(f, '照合する辞書'), options = [...select.options];
        assert.equal(select.value, `${id}:1`);
        assert(select.selectedOptions[0].textContent.includes('v1'), 'the selected choice displays the actual pinned revision');
        assert(options.some(option => option.value === `${id}:1` && option.textContent.includes('v1')));
        assert(options.some(option => option.value === `${id}:2` && option.textContent.includes('v2')));
        assert.deepEqual(f.latestBindings(), initialBindings, 'showing a newer catalog revision cannot upgrade the rule');
        await f.fill(select, `${id}:2`);
        const alias = f.latest().nodes.find(node => node.id === 'first').config.dictionary;
        assert.deepEqual(f.latestBindings().dictionaries[alias], { id, revision: 2 });
        assert.equal(field(f, '照合する辞書').value, `${id}:2`);
        const changed = structuredClone(f.latest()), changedBindings = structuredClone(f.latestBindings());
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.deepEqual(f.latest(), original); assert.deepEqual(f.latestBindings(), initialBindings);
        await press(f, `${catalogs.nodes.dictionary.label}の内容を編集`);
        assert.equal(field(f, '照合する辞書').value, `${id}:1`);
        assert(field(f, '照合する辞書').selectedOptions[0].textContent.includes('v1'));
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true, shiftKey: true });
        assert.deepEqual(f.latest(), changed); assert.deepEqual(f.latestBindings(), changedBindings);
    } finally { await f.close(); }
});

function validationReply(body) {
    const definition = body.text === undefined ? body.definition : parseWorkflow(body.text, body.format), result = validateWorkflow(definition);
    return { ...result, text: stringifyDraft(definition, body.format), ...(result.valid ? { definition } : {}) };
}

test('rate-limit responses retain issues and parse bounded body delays or Retry-After headers with safe Japanese feedback', async () => {
    const f = await reactFixture('export { automationResponseError, automationRetryDelay } from "./components/automation/automation-feedback";');
    try {
        const { automationResponseError: responseError, automationRetryDelay: delay } = f.exports;
        const issue = { nodeId: 'send', message: '分岐を減らしてください。' };
        const fromHeader = responseError({ code: 'AUTOMATION_RATE_LIMITED', error: 'PRIVATE_INTERNAL_ERROR', issues: [issue] }, new Response('', { status: 429, headers: { 'Retry-After': '3' } }));
        assert.equal(fromHeader.retryAfterMs, 3000); assert.deepEqual(fromHeader.issues, [issue]);
        assert.match(fromHeader.message, /約3秒/); assert(!fromHeader.message.includes('PRIVATE_INTERNAL_ERROR'));
        assert.equal(responseError({ code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: 1400 }, new Response('', { status: 429, headers: { 'Retry-After': '9' } })).retryAfterMs, 1400);
        assert.equal(responseError({ code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: -1 }, new Response('', { status: 429, headers: { 'Retry-After': '2' } })).retryAfterMs, 2000);
        assert.equal(responseError({ code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: Number.MAX_VALUE }, new Response('', { status: 429 })).retryAfterMs, 86400000);
        assert.equal(responseError({}, new Response('', { status: 429, headers: { 'Retry-After': 'invalid' } })).retryAfterMs, 1000);
        assert.equal(delay({ code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: 0 }), 1000);
        assert.equal(delay({ code: 'AUTOMATION_FANOUT_LIMIT', retryAfterMs: 2000 }), null);
        const unavailable = responseError({ code: 'AUTOMATION_RATE_LIMIT_UNAVAILABLE', retryAfterMs: 60000, error: 'PRIVATE_DB_ERROR' }, new Response('', { status: 503 }));
        assert.equal(unavailable.retryAfterMs, 60000); assert.match(unavailable.message, /利用制限を確認できません/); assert(!unavailable.message.includes('PRIVATE_DB_ERROR'));
        const slots = responseError({ code: 'AUTOMATION_SLOT_LIMIT', maxSlots: 5, availableSlots: 0, planName: '無料プラン', error: 'PRIVATE_SLOT_IMPLEMENTATION', issues: [issue] }, new Response('', { status: 400 }));
        assert.match(slots.message, /無料プラン.*残り0枠／最大5枠/); assert(!slots.message.includes('PRIVATE_SLOT_IMPLEMENTATION')); assert.deepEqual(slots.issues, [issue]);
        const slotRate = responseError({ code: 'AUTOMATION_RATE_LIMITED', scope: 'slot', retryAfterMs: 86400000 }, new Response('', { status: 429 }));
        assert.match(slotRate.message, /この通知枠.*実際に送信したメッセージ1件/); assert.equal(slotRate.retryAfterMs, 86400000);
    } finally { await f.close(); }
});

test('unchanged blocks automatically validate after a service cooldown without remounting the canvas or losing the draft', async () => {
    const original = branchedRule(), calls = [];
    const api = async (_route, _method, body) => {
        calls.push(structuredClone(body));
        if (calls.length === 1) throw Object.assign(new Error('INTERNAL_QUOTA_STATE'), { code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: 350 });
        return validationReply(body);
    };
    const f = await editorFixture(original, { controlledFlow: true, api });
    try {
        const canvas = f.container.querySelector('.studio-canvas-surface');
        assert.equal(f.valid(), false); assert.equal(calls.length, 1);
        assert.match(f.container.textContent, /約1秒後に自動で再確認/);
        assert.match(f.container.textContent, /編集内容は保持/);
        assert(!f.container.textContent.includes('INTERNAL_QUOTA_STATE'));
        assert.deepEqual(f.latest(), original);
        await settle(f, 420);
        assert.equal(calls.length, 2); assert.equal(f.valid(), true);
        assert.equal(f.container.querySelector('.studio-canvas-surface'), canvas);
        assert.deepEqual(calls[1].definition, original); assert.deepEqual(f.latest(), original);
        assert(!f.container.textContent.includes('自動で再確認'));
    } finally { await f.close(); }
});

test('throttled source validation preserves text while read-only and resumes the exact draft once editing is unlocked', async () => {
    const original = arbitraryRule(); let textRequests = 0;
    const api = async (_route, _method, body) => {
        if (body.text !== undefined && ++textRequests === 1) throw Object.assign(new Error('limited'), { code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: 250 });
        return validationReply(body);
    };
    const f = await editorFixture(original, { controlledFlow: true, api });
    try {
        const edited = { ...original, name: '保持するテキスト編集' }, source = JSON.stringify(edited, null, 2);
        await press(f, 'テキスト'); await f.fill(field(f, 'ルールJSONまたはYAML'), source);
        await settle(f, 500); assert.equal(textRequests, 1); assert.equal(f.valid(), false);
        await f.overrideOptions({ readOnly: true }); await settle(f, 530);
        assert.equal(field(f, 'ルールJSONまたはYAML').value, source);
        assert.equal(field(f, 'ルールJSONまたはYAML').readOnly, true);
        assert.deepEqual(f.latest(), original); assert.equal(f.valid(), false);
        await f.overrideOptions({ readOnly: false }); await settle(f, 500); await settle(f);
        assert.deepEqual(f.latest(), edited); assert.equal(f.valid(), true);
    } finally { await f.close(); }
});

test('a stale 429 cannot suppress validation of another rule and an unmounted editor cancels its retry', async () => {
    const original = arbitraryRule(), replacement = newWorkflow('切替後'); let rejectFirst, calls = 0;
    const api = async (_route, _method, body) => {
        if (++calls === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
        return validationReply(body);
    };
    const f = await editorFixture(original, { controlledFlow: true, api });
    try {
        await f.replace(replacement);
        await f.act(async () => rejectFirst(Object.assign(new Error('STALE_PRIVATE_ERROR'), { code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: 60000 })));
        await settle(f); assert.equal(calls, 2); assert.equal(f.valid(), true);
        assert.deepEqual(f.latest(), replacement); assert(!f.container.textContent.includes('STALE_PRIVATE_ERROR')); assert(!f.container.textContent.includes('自動で再確認'));
    } finally { await f.close(); }
    let retryCalls = 0;
    const pending = await editorFixture(original, { controlledFlow: true, api: async () => { retryCalls++; throw Object.assign(new Error('limited'), { code: 'AUTOMATION_RATE_LIMITED', retryAfterMs: 300 }); } });
    assert.equal(retryCalls, 1); await pending.close(); await new Promise(resolve => setTimeout(resolve, 360));
    assert.equal(retryCalls, 1);
});

test('service fanout issues open the exact block without hiding its canvas or leaking backend diagnostics', async () => {
    const original = branchedRule(), message = 'この分岐からの通知が上限を超えています。';
    const api = async () => { throw Object.assign(new Error('PRIVATE_PLAN_DEBUG'), { code: 'AUTOMATION_NOTIFICATION_BATCH_LIMIT', issues: [{ nodeId: 'gate_c91', message }] }); };
    const f = await editorFixture(original, { controlledFlow: true, api });
    try {
        assert.equal(f.valid(), false); assert(!f.container.textContent.includes('PRIVATE_PLAN_DEBUG'));
        assert.match(f.container.textContent, /分岐・通知ブロックを減らして/);
        const canvas = f.container.querySelector('.studio-canvas-surface');
        await press(f, message);
        assert.equal(f.container.querySelector('.studio-canvas-surface'), canvas);
        assert.equal(f.flowControl.props.nodes.find(node => node.id === 'gate_c91').data.editing, true);
        assert.deepEqual(f.latest(), original);
    } finally { await f.close(); }
});

test('a throttled save shows Retry-After feedback, retains an editable draft and succeeds on a manual retry', async () => {
    const f = await workspaceFixture({ saveRateLimited: true });
    try {
        await press(f, '新しいルール'); await settle(f);
        await f.fill(field(f, 'ルール名'), '消してはいけないルール'); await settle(f);
        const canvas = f.container.querySelector('.studio-canvas-surface');
        await press(f, '下書きを保存'); await f.settle();
        assert.match(f.container.textContent, /約2秒待って/); assert(!f.container.textContent.includes('internal quota implementation'));
        assert.equal(field(f, 'ルール名').value, '消してはいけないルール'); assert.equal(field(f, 'ルール名').readOnly, false);
        assert.equal(f.container.querySelector('.studio-canvas-surface'), canvas); assert.equal(f.stored(), null);
        assert.equal(button(f, '下書きを保存').disabled, false);
        await press(f, '下書きを保存'); await settle(f);
        assert.equal(f.stored().name, '消してはいけないルール'); assert.match(f.container.textContent, /下書きを保存しました/);
    } finally { await f.close(); }
});

test('service notification limits appear in delivery history as waiting or content corrections rather than raw error codes', async () => {
    const f = await reactFixture('export { DeliveryHistory } from "./components/automation/delivery-history";');
    const api = async () => ({ items: [
        { id: 'waiting', state: 'pending', providerId: 'youtube', title: '待機している通知', dueAtMs: 2000, errorCode: 'AUTOMATION_RATE_LIMITED' },
        { id: 'too-long', state: 'failed', providerId: 'youtube', title: '長すぎる通知', dueAtMs: 1000, errorCode: 'AUTOMATION_NOTIFICATION_BATCH_LIMIT' },
    ], nextCursor: null });
    try {
        await f.render(f.React.createElement(f.exports.DeliveryHistory, { api, canEdit: true })); await f.settle();
        assert.match(f.container.textContent, /次に送信できる時刻まで待機/); assert.match(f.container.textContent, /通知内容を短くするか、まとめる件数を減らして/);
        assert(!f.container.textContent.includes('AUTOMATION_'));
    } finally { await f.close(); }
});


test('T10 returning a send block to its monitor destination removes only the last unused binding and undo restores both', async () => {
    const original = arbitraryRule(), first = original.nodes.find(node => node.type === 'send');
    first.config.destination = 'shared'; original.nodes.push({ ...structuredClone(first), id: 'second-send' });
    const initialBindings = { destinations: { shared: 'owned-destination' }, dictionaries: {} };
    const f = await editorFixture(original, { controlledFlow: true, bindings: initialBindings, resources: { destinations: [{ id: 'owned-destination', name: 'Owned destination' }], dictionaries: [] } });
    try {
        canvasGeometry(f);
        const edit = async id => clickElement(f, f.container.querySelector(`[data-id="${id}"] button[aria-label="${catalogs.nodes.send.label}の内容を編集"]`));
        await edit(first.id); await f.fill(field(f, '通知の宛先'), 'default');
        assert.equal(f.latestBindings().destinations.shared, 'owned-destination', 'another send still uses this binding');
        await press(f, '編集を閉じる'); await edit('second-send'); await f.fill(field(f, '通知の宛先'), 'default');
        assert.deepEqual(f.latestBindings().destinations, {});
        await keyboard(f, editorRoot(f), 'z', { ctrlKey: true });
        assert.equal(f.latest().nodes.find(node => node.id === 'second-send').config.destination, 'shared'); assert.equal(f.latestBindings().destinations.shared, 'owned-destination');
    } finally { await f.close(); }
});
