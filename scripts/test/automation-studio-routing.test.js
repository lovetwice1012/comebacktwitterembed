'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const flow = createRequire(path.resolve(__dirname, '../../dashboard/package.json'))('@xyflow/react');

function node(id, x, y, width = 100, height = 100) {
    return { id, data: {}, position: { x, y }, measured: { width, height }, internals: { positionAbsolute: { x, y }, z: 0,
        handleBounds: { source: [{ id: 'out', x: width - 5, y: 45, width: 5, height: 10, position: 'right' }],
            target: [{ id: null, x: 0, y: 45, width: 5, height: 10, position: 'left' }] } } };
}

async function routingFixture(state) {
    let selector, equality;
    const f = await reactFixture(`
        import { StudioRoutingProvider, StudioRoutingObserver, useStudioRoute } from "./components/automation/studio-routing";
        function Wire() { const route = useStudioRoute("wire"); return <path id="wire" d={route?.path} data-points={JSON.stringify(route?.points)} data-display-path={route?.displayPath} data-crossings={route?.crossingCount} />; }
        export function App({ tick }) { return <StudioRoutingProvider><div data-tick={tick}><span id="card">card</span><svg><Wire /></svg><StudioRoutingObserver /></div></StudioRoutingProvider>; }
    `, { moduleOverrides: { '@xyflow/react': React => ({ ...flow, useStore(read, equal) {
        selector = read; equality = equal;
        const selected = React.useRef(read(state));
        const next = read(state);
        if (!equal(selected.current, next)) selected.current = next;
        return selected.current;
    } }) } });
    f.selectGeometry = () => selector(state);
    f.sameGeometry = (previous, next) => equality(previous, next);
    f.paint = tick => f.render(f.React.createElement(f.exports.App, { tick }));
    f.points = () => JSON.parse(f.container.querySelector('#wire').getAttribute('data-points'));
    return f;
}

function crosses(points, rectangle) {
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (a.x === b.x && a.x > rectangle.x && a.x < rectangle.x + rectangle.width
            && Math.max(a.y, b.y) > rectangle.y && Math.min(a.y, b.y) < rectangle.y + rectangle.height) return true;
        if (a.y === b.y && a.y > rectangle.y && a.y < rectangle.y + rectangle.height
            && Math.max(a.x, b.x) > rectangle.x && Math.min(a.x, b.x) < rectangle.x + rectangle.width) return true;
    }
    return false;
}

test('live measured card movement reroutes wires before the saved rule changes and retains mounted cards', async () => {
    const state = { nodeLookup: new Map([['a', node('a', 0, 0)], ['b', node('b', 450, 0)], ['obstacle', node('obstacle', 230, 180)]]),
        edges: [{ id: 'wire', source: 'a', sourceHandle: 'out', target: 'b' }], connectionMode: 'strict' };
    const f = await routingFixture(state);
    try {
        await f.paint(0);
        const card = f.container.querySelector('#card'), wire = f.container.querySelector('#wire'), original = wire.getAttribute('d');
        const obstacle = state.nodeLookup.get('obstacle');
        obstacle.internals.positionAbsolute = { x: 230, y: 0 };
        await f.paint(1);
        assert.notEqual(wire.getAttribute('d'), original);
        assert.equal(f.container.querySelector('#card'), card);
        assert.equal(f.container.querySelector('#wire'), wire);
        assert.equal(obstacle.position.y, 180, 'saved node position is unchanged while dragging');
        assert(!crosses(f.points(), { x: 230, y: 0, width: 100, height: 100 }));
        assert.deepEqual(f.points()[0], { x: 100, y: 50 });
        assert.deepEqual(f.points().at(-1), { x: 450, y: 50 });
        obstacle.measured.height = 280;
        obstacle.internals.positionAbsolute.y = -100;
        await f.paint(2);
        assert(!crosses(f.points(), { x: 230, y: -100, width: 100, height: 280 }), 'expanded inline card is avoided');
    } finally { await f.close(); }
});

test('viewport and selection do not invalidate routes, and temporary missing handles retain the last wire', async () => {
    const state = { nodeLookup: new Map([['a', node('a', 0, 0)], ['b', node('b', 450, 0)]]),
        edges: [{ id: 'wire', source: 'a', sourceHandle: 'out', target: 'b' }], connectionMode: 'strict' };
    const f = await routingFixture(state);
    try {
        await f.paint(0);
        const initial = f.selectGeometry(), wire = f.container.querySelector('#wire'), original = wire.getAttribute('d');
        state.transform = [100, 200, 0.6]; state.nodeLookup.get('a').selected = true;
        state.edges[0].data = { focused: true }; state.edges[0].selected = true;
        assert(f.sameGeometry(initial, f.selectGeometry()));
        await f.paint(1);
        assert.equal(wire.getAttribute('d'), original);
        const bounds = state.nodeLookup.get('a').internals.handleBounds;
        delete state.nodeLookup.get('a').internals.handleBounds;
        await f.paint(2);
        assert.equal(wire.getAttribute('d'), original, 'measurement gap must not clear the existing wire');
        state.nodeLookup.get('a').internals.handleBounds = bounds;
        state.nodeLookup.get('a').internals.positionAbsolute.y = 160;
        await f.paint(3);
        assert.deepEqual(f.points()[0], { x: 100, y: 210 }, 'new handle geometry is consumed immediately');
        state.edges = [];
        await f.paint(4);
        assert.equal(wire.getAttribute('d'), null, 'a deleted edge is removed rather than retained as a measurement gap');
    } finally { await f.close(); }
});

test('a residual crossing gap clears when its peer moves even when the underlying wire stays the same', async () => {
    const state = { nodeLookup: new Map([
        ['a', node('a', 0, 0)], ['b', node('b', 450, 0)],
        ['c', node('c', 200, -200)], ['d', node('d', 200, 200)],
        // Enclosed sockets cannot gain a clear route; the visible crossing
        // treatment must still update without removing the real connection.
        ['cover', node('cover', 50, -250, 1000, 700)],
    ]), edges: [
        { id: 'wire', source: 'a', sourceHandle: 'out', target: 'b' },
        { id: 'z-peer', source: 'c', sourceHandle: 'out', target: 'd' },
    ], connectionMode: 'strict' };
    const f = await routingFixture(state);
    try {
        await f.paint(0);
        const wire = f.container.querySelector('#wire'), original = wire.getAttribute('d');
        assert.equal(wire.getAttribute('data-crossings'), '1');
        assert.notEqual(wire.getAttribute('data-display-path'), original);
        state.nodeLookup.get('c').internals.positionAbsolute.x = 650;
        state.nodeLookup.get('d').internals.positionAbsolute.x = 650;
        await f.paint(1);
        assert.equal(f.container.querySelector('#wire'), wire, 'the wire stays mounted');
        assert.equal(wire.getAttribute('d'), original, 'its underlying path and endpoints stay unchanged');
        assert.equal(wire.getAttribute('data-crossings'), '0');
        assert.equal(wire.getAttribute('data-display-path'), original, 'the stale gap disappears after the peer leaves');
    } finally { await f.close(); }
});
