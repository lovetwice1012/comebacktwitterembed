'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { edgeLanes, edgeRoute, edgeRoutes } = require('../../src/automation/editor-edge-routing');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

test('converging branches use different trunks and label rows without changing graph semantics', () => {
    const edges = [
        { id: 'unknown', source: 'condition', sourceHandle: 'unknown', target: 'stop', data: { port: 'unknown' } },
        { id: 'no', source: 'condition', sourceHandle: 'no', target: 'stop', data: { port: 'no' } },
    ], original = structuredClone(edges), lanes = edgeLanes(edges);
    const no = edgeRoute({ sourceX: 200, sourceY: 140, targetX: 500, targetY: 240, lanes: lanes.get('no') });
    const unknown = edgeRoute({ sourceX: 200, sourceY: 184, targetX: 500, targetY: 240, lanes: lanes.get('unknown') });
    assert.notEqual(no.points[3].x, unknown.points[3].x);
    assert.notEqual(no.points[4].y, unknown.points[4].y);
    assert.notEqual(no.labelY, unknown.labelY);
    assert.deepEqual(no.points.at(-1), unknown.points.at(-1));
    assert.deepEqual(edges, original);
    assert.deepEqual([...edgeLanes([...edges].reverse())].sort(), [...lanes].sort(), 'routing independent of saved edge order');
});

test('shared sockets fan out into separate visible paths including collapsed groups', () => {
    const edges = [
        { id: 'yes', source: '__group:a', sourceHandle: 'out', target: 'notify', data: { port: 'yes' } },
        { id: 'no', source: '__group:a', sourceHandle: 'out', target: 'notify', data: { port: 'no' } },
        { id: 'unknown', source: '__group:a', sourceHandle: 'out', target: 'notify', data: { port: 'unknown' } },
    ], lanes = edgeLanes(edges);
    const routes = edges.map(edge => edgeRoute({ sourceX: 100, sourceY: 100, targetX: 400, targetY: 100, lanes: lanes.get(edge.id) }));
    assert.equal(new Set(routes.map(route => route.path)).size, 3);
    assert.equal(new Set(routes.map(route => route.labelY)).size, 3);
    for (const route of routes) { assert.deepEqual(route.points[0], { x: 100, y: 100 }); assert.deepEqual(route.points.at(-1), { x: 400, y: 100 }); }
});

test('backwards and nearby wires keep finite separate return lanes', () => {
    for (const targetX of [40, 120, 179]) {
        const routes = [0, 1, 2].map(index => edgeRoute({ sourceX: 100, sourceY: 80, targetX, targetY: 20, lanes: { routeIndex: index, routeCount: 3, targetIndex: index, targetCount: 3 } }));
        assert.equal(new Set(routes.map(route => route.path)).size, 3);
        assert.equal(new Set(routes.map(route => route.labelY)).size, 3);
        for (const route of routes) { assert(!route.path.includes('NaN')); assert(!route.path.includes('Infinity')); assert.deepEqual(route.points.at(-1), { x: targetX, y: 20 }); }
    }
});

test('custom wire preserves XYFlow interaction path, markers and readable labels', async () => {
    const f = await reactFixture('export { StudioFlowEdge } from "./components/automation/studio-flow-edge";');
    try {
        f.dom.window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 30, height: 12 }; };
        const props = { id: 'wire', source: 'a', target: 'b', sourceX: 100, sourceY: 80, targetX: 400, targetY: 180, label: '該当しない', markerEnd: 'url(#arrow)', data: { port: 'no' }, selected: true, style: { stroke: '#666' } };
        await f.render(f.React.createElement('svg', null, f.React.createElement(f.exports.StudioFlowEdge, props)));
        const wire = f.container.querySelector('.react-flow__edge-path'), hit = f.container.querySelector('.react-flow__edge-interaction'), halo = f.container.querySelector('.studio-edge-halo');
        assert(wire); assert(hit); assert(halo);
        assert.equal(wire.getAttribute('marker-end'), 'url(#arrow)');
        assert.equal(hit.getAttribute('d'), wire.getAttribute('d'));
        assert.equal(hit.getAttribute('stroke-width'), '22');
        assert.equal(halo.getAttribute('pointer-events'), 'none');
        assert.equal(wire.style.strokeWidth, '4');
        assert.equal(f.container.querySelector('.react-flow__edge-text').textContent, '該当しない');
        assert(f.container.querySelector('.react-flow__edge-textbg'));
    } finally { await f.close(); }
});

function segmentCrosses(a, b, box) {
    assert(a.x === b.x || a.y === b.y, 'obstacle routes have orthogonal segments');
    if (a.y === b.y) return a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
    return a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
}
function avoids(route, boxes, sourceId, targetId) {
    for (const box of boxes) for (let i = 1; i < route.points.length; i++) {
        if ((i === 1 && box.id === sourceId) || (i === route.points.length - 1 && box.id === targetId)) continue;
        assert(!segmentCrosses(route.points[i - 1], route.points[i], box), `wire crosses ${box.id || 'obstacle'} on segment ${i}: ${JSON.stringify(route.points)}`);
    }
    assert(!route.path.includes('NaN')); assert(!route.path.includes('Infinity'));
}

test('an unrelated moved block reroutes a wire immediately without changing its sockets', () => {
    const endpoints = { sourceX: 100, sourceY: 100, targetX: 650, targetY: 100 };
    const offscreen = { id: 'moving', x: 280, y: 220, width: 150, height: 110 }, blocking = { ...offscreen, y: 40 };
    const clear = edgeRoute({ ...endpoints, obstacles: [offscreen] }), routed = edgeRoute({ ...endpoints, obstacles: [blocking] });
    assert.notEqual(clear.path, routed.path);
    assert.deepEqual(routed.points[0], { x: 100, y: 100 }); assert.deepEqual(routed.points.at(-1), { x: 650, y: 100 });
    avoids(routed, [blocking]);
});

test('expanded source and target cards escape outside their measured bounds', () => {
    const obstacles = [{ id: 'expanded', x: 0, y: 0, width: 440, height: 620 }, { id: 'target', x: 700, y: 70, width: 180, height: 180 }, { id: 'other', x: 490, y: 95, width: 130, height: 140 }];
    const route = edgeRoute({ sourceX: 440, sourceY: 90, targetX: 700, targetY: 130, sourceId: 'expanded', targetId: 'target', obstacles });
    avoids(route, obstacles, 'expanded', 'target');
    assert(route.points[1].x >= 456, 'expanded block actual width is used for socket escape');
});

test('backwards connections skirt their own cards and intervening blocks', () => {
    const obstacles = [{ id: 'source', x: 650, y: 60, width: 220, height: 200 }, { id: 'target', x: 80, y: 250, width: 200, height: 170 }, { id: 'middle', x: 310, y: 50, width: 260, height: 350 }];
    const route = edgeRoute({ sourceX: 870, sourceY: 120, targetX: 80, targetY: 310, sourceId: 'source', targetId: 'target', obstacles });
    avoids(route, obstacles, 'source', 'target');
    assert.deepEqual(route.points.at(-1), { x: 80, y: 310 });
});

test('expanded unrelated cards and collapsed group rectangles are equally respected', () => {
    for (const height of [110, 720]) {
        const obstacles = [{ id: '__group:collapsed', x: 250, y: -50, width: 280, height }];
        const route = edgeRoute({ sourceX: 90, sourceY: 20, targetX: 700, targetY: 80, obstacles });
        avoids(route, obstacles);
        assert(route.points.some(point => point.y <= -66 || point.y >= height - 34));
    }
});

test('large shared-socket fan-out offsets never sweep through neighboring cards', () => {
    const obstacles = [{ id: 'source', x: 0, y: 0, width: 150, height: 120 }, { id: 'crossing', x: 160, y: 200, width: 230, height: 180 }, { id: 'target', x: 800, y: 50, width: 190, height: 200 }];
    const route = edgeRoute({ sourceX: 150, sourceY: 60, targetX: 800, targetY: 110, sourceId: 'source', targetId: 'target', obstacles, lanes: { sourceIndex: 30, sourceCount: 41, targetIndex: 0, targetCount: 1, routeIndex: 30, routeCount: 41 } });
    avoids(route, obstacles, 'source', 'target'); assert(!route.blocked);
});

test('an actual enclosing overlap is marked explicitly while the edge stays visible', () => {
    const obstacles = [{ id: 'source', x: 0, y: 0, width: 200, height: 200 }, { id: 'covering', x: 150, y: 50, width: 200, height: 200 }];
    const route = edgeRoute({ sourceX: 200, sourceY: 100, targetX: 600, targetY: 100, sourceId: 'source', obstacles });
    assert.equal(route.blocked, true); assert(route.path.startsWith('M 200 100'));
    const separated = edgeRoute({ sourceX: 200, sourceY: 100, targetX: 600, targetY: 100, sourceId: 'source', obstacles: obstacles.map(box => box.id === 'covering' ? { ...box, y: 250 } : box) });
    assert(!separated.blocked); avoids(separated, obstacles.map(box => box.id === 'covering' ? { ...box, y: 250 } : box), 'source');
});

test('converging shared sockets use distinct obstacle paths and label segments', () => {
    const obstacles = [{ id: 'blocker', x: 280, y: 30, width: 120, height: 240 }];
    const specs = [0, 1, 2].map(index => ({ id: `edge:${index}`, sourceX: 100, sourceY: 100, targetX: 600, targetY: 160, lanes: { sourceIndex: index, sourceCount: 3, targetIndex: index, targetCount: 3, routeIndex: index, routeCount: 3 } }));
    const routes = edgeRoutes(specs, { obstacles });
    assert.equal(new Set([...routes.values()].map(route => route.path)).size, 3);
    for (const route of routes.values()) {
        avoids(route, obstacles);
        assert(route.points.some((point, index) => index && point.y === route.labelY && route.points[index - 1].y === route.labelY && route.labelX >= Math.min(point.x, route.points[index - 1].x) && route.labelX <= Math.max(point.x, route.points[index - 1].x)), 'label lies on clear horizontal segment');
        assert(!(route.labelX > 235 && route.labelX < 445 && route.labelY > 17 && route.labelY < 283), 'label avoids card bounds');
    }
    assert.deepEqual([...edgeRoutes([...specs].reverse(), { obstacles })], [...routes], 'stable regardless of edge render order');
});

test('parallel unrelated connections gain separate channels instead of covering one another', () => {
    const routes = [...edgeRoutes([{ id: 'a', sourceX: 100, sourceY: 100, targetX: 700, targetY: 100 }, { id: 'b', sourceX: 110, sourceY: 100, targetX: 710, targetY: 100 }]).values()];
    const shared = (a, b) => a.points.slice(1, -1).reduce((length, point, index) => {
        const previous = a.points[index];
        return length + b.points.slice(1).reduce((sum, p, j) => { const q = b.points[j]; if (point.y === previous.y && p.y === q.y && point.y === p.y) return sum + Math.max(0, Math.min(Math.max(point.x, previous.x), Math.max(p.x, q.x)) - Math.max(Math.min(point.x, previous.x), Math.min(p.x, q.x))); return sum; }, 0);
    }, 0);
    assert(shared(...routes) < 80, `only short socket stubs can overlap: ${shared(...routes)}`);
});

test('dense measured obstacles remain deterministic, finite and clear through repeated motion', () => {
    const obstacles = Array.from({ length: 35 }, (_, index) => ({ id: `card:${index}`, x: 220 + index % 7 * 160, y: -300 + Math.floor(index / 7) * 145, width: 115, height: 100 }));
    const options = { sourceX: 50, sourceY: 30, targetX: 1450, targetY: 290, obstacles };
    for (const offset of [0, 18, 47, -32]) {
        const moved = obstacles.map(box => box.id === 'card:16' ? { ...box, y: box.y + offset } : box), route = edgeRoute({ ...options, obstacles: moved });
        avoids(route, moved); assert.deepEqual(route, edgeRoute({ ...options, obstacles: moved }));
    }
});

test('128 measured cards and 256 wires route within a bounded interactive workload', t => {
    const obstacles = Array.from({ length: 128 }, (_, index) => ({ id: `card:${index}`, x: index % 16 * 230, y: Math.floor(index / 16) * 190, width: 150, height: 120 }));
    const specs = Array.from({ length: 256 }, (_, index) => {
        const source = obstacles[index % 128], target = obstacles[(index + 37) % 128];
        return { id: `wire:${String(index).padStart(3, '0')}`, sourceId: source.id, targetId: target.id, sourceX: source.x + source.width, sourceY: source.y + 45 + (index >= 128 ? 20 : 0), targetX: target.x, targetY: target.y + 45 + (index >= 128 ? 20 : 0) };
    });
    const began = performance.now(), routes = edgeRoutes(specs, { obstacles }), elapsed = performance.now() - began;
    assert.equal(routes.size, 256);
    for (const spec of specs) avoids(routes.get(spec.id), obstacles, spec.sourceId, spec.targetId);
    assert(elapsed < 1500, `bounded routing time: ${Math.round(elapsed)}ms`);
    const moved = obstacles.map(box => box.id === 'card:65' ? { ...box, x: box.x + 35, y: box.y + 40 } : box);
    const movedSpecs = specs.map(spec => {
        const source = moved.find(box => box.id === spec.sourceId), target = moved.find(box => box.id === spec.targetId);
        return { ...spec, sourceX: source.x + source.width, sourceY: source.y + 45 + (Number(spec.id.slice(5)) >= 128 ? 20 : 0), targetX: target.x, targetY: target.y + 45 + (Number(spec.id.slice(5)) >= 128 ? 20 : 0) };
    });
    const draggedAt = performance.now(), dragged = edgeRoutes(movedSpecs, { obstacles: moved, previousRoutes: routes }), dragElapsed = performance.now() - draggedAt;
    for (const spec of movedSpecs) avoids(dragged.get(spec.id), moved, spec.sourceId, spec.targetId);
    assert([...dragged].filter(([id, route]) => route === routes.get(id)).length > 128, 'unaffected wire geometries survive a moved card');
    assert(dragElapsed < 500, `incremental routing time: ${Math.round(dragElapsed)}ms`);
    const unchanged = edgeRoutes(movedSpecs, { obstacles: moved, previousRoutes: dragged });
    assert([...unchanged].every(([id, route]) => route === dragged.get(id)), 'an unchanged dense graph keeps all measured wire objects');
    t.diagnostic(`128-card/256-wire cold=${elapsed.toFixed(1)}ms moved-card=${dragElapsed.toFixed(1)}ms reused=${[...dragged].filter(([id, route]) => route === routes.get(id)).length}/256`);
});

function wireIntersections(first, second, sharedSockets = []) {
    let count = 0;
    for (let i = 1; i < first.points.length; i++) for (let j = 1; j < second.points.length; j++) {
        const a = first.points[i - 1], b = first.points[i], c = second.points[j - 1], d = second.points[j], horizontal = a.y === b.y;
        assert(a.x === b.x || horizontal, 'batch routing has no untracked diagonal fan-outs');
        assert(c.x === d.x || c.y === d.y);
        if (horizontal === (c.y === d.y)) {
            if ((horizontal ? a.y : a.x) !== (horizontal ? c.y : c.x)) continue;
            const low = Math.max(Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y), Math.min(horizontal ? c.x : c.y, horizontal ? d.x : d.y)), high = Math.min(Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y), Math.max(horizontal ? c.x : c.y, horizontal ? d.x : d.y));
            if (high <= low) continue;
            let length = high - low;
            for (const socket of sharedSockets) {
                if ((horizontal ? socket.y : socket.x) !== (horizontal ? a.y : a.x)) continue;
                const coordinate = horizontal ? socket.x : socket.y;
                length -= Math.max(0, Math.min(high, coordinate + 48) - Math.max(low, coordinate - 48));
            }
            if (length > 0.001) count++;
        } else {
            const cross = horizontal ? { x: c.x, y: a.y } : { x: a.x, y: c.y };
            if (cross.x < Math.min(a.x, b.x) || cross.x > Math.max(a.x, b.x) || cross.y < Math.min(a.y, b.y) || cross.y > Math.max(a.y, b.y)
                || cross.x < Math.min(c.x, d.x) || cross.x > Math.max(c.x, d.x) || cross.y < Math.min(c.y, d.y) || cross.y > Math.max(c.y, d.y)) continue;
            if (!sharedSockets.some(socket => Math.hypot(cross.x - socket.x, cross.y - socket.y) <= 48.001)) count++;
        }
    }
    return count;
}

test('perpendicular wires take an available route around the other wire ends', () => {
    const specs = [{ id: 'a', sourceX: 100, sourceY: 100, targetX: 600, targetY: 100 }, { id: 'b', sourceX: 350, sourceY: 0, targetX: 350, targetY: 250 }];
    const routes = edgeRoutes(specs);
    assert.equal(wireIntersections(routes.get('a'), routes.get('b')), 0);
    assert(!routes.get('b').routingConflictKey, 'a feasible crossing-free alternative is used');
    assert.deepEqual([...edgeRoutes([...specs].reverse())], [...routes]);
    assert.deepEqual(routes.get('b').points[0], { x: 350, y: 0 });
    assert.deepEqual(routes.get('b').points.at(-1), { x: 350, y: 250 });
});

test('crossed target rows skirt measured cards without intersecting the retained wire', () => {
    const obstacles = [{ id: 'left-top', x: 0, y: 0, width: 120, height: 90 }, { id: 'left-bottom', x: 0, y: 180, width: 120, height: 90 }, { id: 'right-top', x: 400, y: 0, width: 120, height: 90 }, { id: 'right-bottom', x: 400, y: 180, width: 120, height: 90 }];
    const specs = [{ id: 'a', sourceId: 'left-top', targetId: 'right-bottom', sourceX: 120, sourceY: 45, targetX: 400, targetY: 225 }, { id: 'b', sourceId: 'left-bottom', targetId: 'right-top', sourceX: 120, sourceY: 225, targetX: 400, targetY: 45 }];
    const routes = edgeRoutes(specs, { obstacles });
    assert.equal(wireIntersections(routes.get('a'), routes.get('b')), 0);
    for (const spec of specs) avoids(routes.get(spec.id), obstacles, spec.sourceId, spec.targetId);
    const expanded = obstacles.map(box => box.id === 'right-bottom' ? { ...box, height: 310 } : box), moved = edgeRoutes(specs, { obstacles: expanded, previousRoutes: routes });
    assert.equal(wireIntersections(moved.get('a'), moved.get('b')), 0);
    for (const spec of specs) avoids(moved.get(spec.id), expanded, spec.sourceId, spec.targetId);
});

test('previous unannotated crossing routes are repaired rather than cached against empty peers', () => {
    const specs = [{ id: 'a', sourceX: 100, sourceY: 100, targetX: 600, targetY: 100 }, { id: 'b', sourceX: 350, sourceY: 0, targetX: 350, targetY: 250 }];
    const first = { path: 'M 100 100 L 600 100', points: [{ x: 100, y: 100 }, { x: 600, y: 100 }], labelX: 200, labelY: 100 };
    const second = { path: 'M 350 0 L 350 250', points: [{ x: 350, y: 0 }, { x: 350, y: 250 }], labelX: 350, labelY: 125 };
    const previousRoutes = new Map([['a', first], ['b', second]]), routes = edgeRoutes(specs, { previousRoutes });
    assert.equal(routes.get('a'), first, 'the clear primary wire does not jump');
    assert.notEqual(routes.get('b'), second);
    assert.equal(wireIntersections(routes.get('a'), routes.get('b')), 0);
    assert.deepEqual(previousRoutes.get('b'), second, 'previous geometry is not mutated');
});

test('moving a peer socket across a cached wire reroutes the peer and keeps the clear wire stable', () => {
    const specs = [{ id: 'a', sourceX: 100, sourceY: 100, targetX: 600, targetY: 100 }, { id: 'b', sourceX: 350, sourceY: -150, targetX: 350, targetY: -50 }];
    const original = edgeRoutes(specs), movedSpecs = specs.map(spec => spec.id === 'b' ? { ...spec, targetY: 250 } : spec), moved = edgeRoutes(movedSpecs, { previousRoutes: original });
    assert.equal(moved.get('a'), original.get('a'));
    assert.equal(wireIntersections(moved.get('a'), moved.get('b')), 0);
    assert.deepEqual(moved.get('b').points.at(-1), { x: 350, y: 250 });
});

test('shared actual sockets permit only their short fan-out and convergence region', () => {
    const specs = [0, 1, 2].map(index => ({ id: `wire:${index}`, sourceId: 'source', targetId: 'target', sourceX: 100, sourceY: 100, targetX: 600, targetY: 200, lanes: { sourceIndex: index, sourceCount: 3, targetIndex: index, targetCount: 3, routeIndex: index, routeCount: 3 } }));
    const routes = [...edgeRoutes(specs).values()];
    for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) assert.equal(wireIntersections(routes[i], routes[j], [{ x: 100, y: 100 }, { x: 600, y: 200 }]), 0);
    assert.equal(new Set(routes.map(route => route.path)).size, 3);
});

test('unrelated node IDs at the same coordinate never receive the shared socket allowance', () => {
    const routes = edgeRoutes([{ id: 'a', sourceId: 'source:a', targetId: 'target:a', sourceX: 100, sourceY: 100, targetX: 600, targetY: 100 }, { id: 'b', sourceId: 'source:b', targetId: 'target:b', sourceX: 100, sourceY: 100, targetX: 400, targetY: 200 }]);
    assert(routes.get('b').routingConflictKey, 'coincident unrelated sockets stay an explicit wire fallback');
    assert(!routes.get('b').blocked, 'wire coincidence alone is not a card-overlap state');
});

test('a wire-only closed corridor falls back visibly without claiming overlapping cards', () => {
    const occupied = [[{ x: 50, y: 50 }, { x: 200, y: 50 }, { x: 200, y: 150 }, { x: 50, y: 150 }, { x: 50, y: 50 }]];
    const route = edgeRoute({ sourceX: 100, sourceY: 100, targetX: 600, targetY: 100, occupied });
    assert(route.routingConflictKey, 'the renderer can decorate a known bounded wire fallback');
    assert(!route.blocked, 'wire conflicts never become a card-overlap warning');
    assert.deepEqual(route.points[0], { x: 100, y: 100 });
    assert.deepEqual(route.points.at(-1), { x: 600, y: 100 });
    assert(!route.path.includes('NaN')); assert(!route.path.includes('Infinity'));
});

test('anonymous obstacles are treated as unrelated cards instead of the source and target', () => {
    const obstacles = [{ x: 200, y: 50, width: 150, height: 150 }];
    const route = edgeRoute({ sourceX: 100, sourceY: 100, targetX: 600, targetY: 100, obstacles });
    avoids(route, obstacles);
});
