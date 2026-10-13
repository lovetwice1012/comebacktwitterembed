'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decorateEdgeCrossings } = require('../../src/automation/editor-edge-crossings');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');

function route(points, path = `M ${points.map(point => `${point.x} ${point.y}`).join(' L ')}`) {
    return { path, points, labelX: points[0].x, labelY: points[0].y };
}

test('residual orthogonal crossings get a short visible gap while endpoints and logical geometry stay intact', () => {
    const horizontal = route([{ x: 0, y: 50 }, { x: 100, y: 50 }]);
    const vertical = route([{ x: 50, y: 0 }, { x: 50, y: 100 }]);
    const routes = new Map([['a', horizontal], ['b', vertical]]), original = structuredClone(routes);
    const next = decorateEdgeCrossings(routes);
    assert.equal(next.get('a').displayPath, 'M 0 50 L 39 50 M 61 50 L 100 50');
    assert.equal(next.get('a').crossingCount, 1);
    assert.equal(next.get('a').path, horizontal.path);
    assert.deepEqual(next.get('a').points, horizontal.points);
    assert.equal(next.get('b').displayPath, vertical.path);
    assert.equal(next.get('b').crossingCount, 0);
    assert.deepEqual(routes, original, 'saved geometry and caller-owned routes are not mutated');
    assert.deepEqual([...decorateEdgeCrossings(new Map([...routes].reverse()))].sort(), [...next].sort(), 'stacking is stable across render order');
});

test('a crossing on an actual rounded bend splits the curve without turning it into a sharp corner', () => {
    const rounded = route([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }], 'M 0 0 L 40 0 Q 50 0 50 10 L 50 100');
    const acrossBend = route([{ x: 35, y: 3 }, { x: 65, y: 3 }]);
    const next = decorateEdgeCrossings(new Map([['a', rounded], ['b', acrossBend]]));
    assert.equal(next.get('a').crossingCount, 1);
    assert.equal((next.get('a').displayPath.match(/M /g) || []).length, 2);
    assert(next.get('a').displayPath.endsWith('L 50 100'));
    assert(!next.get('a').displayPath.includes('NaN'));
    // Shorter gap through another long curve leaves its unaffected rounded part.
    const long = route([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 100 }, { x: 160, y: 100 }], 'M 0 0 L 50 0 Q 60 0 60 10 L 60 90 Q 60 100 70 100 L 160 100');
    const crossing = route([{ x: 20, y: 50 }, { x: 100, y: 50 }]);
    const visible = decorateEdgeCrossings(new Map([['a', long], ['b', crossing]])).get('a').displayPath;
    assert(visible.includes('Q 60 0 60 10'));
    assert(visible.includes('Q 60 100 70 100'));
});

test('sharp clearance-zero fallback corners stay sharp when a residual crossing is decorated', () => {
    const sharp = route([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 100 }, { x: 160, y: 100 }]);
    const crossing = route([{ x: 20, y: 50 }, { x: 100, y: 50 }]);
    const decorated = decorateEdgeCrossings(new Map([['a', sharp], ['b', crossing]])).get('a');
    assert.equal(decorated.crossingCount, 1);
    assert(!decorated.displayPath.includes('Q'), 'the decorated path never sweeps a new rounded bend into card bounds');
    assert.equal(decorated.displayPath, 'M 0 0 L 60 0 L 60 39 M 60 61 L 60 100 L 160 100');
});

test('shared sockets remain joined and unrelated endpoint touches preserve the endpoint arrow', () => {
    const joined = decorateEdgeCrossings(new Map([
        ['a', route([{ x: 0, y: 0 }, { x: 100, y: 0 }])],
        ['b', route([{ x: 0, y: 0 }, { x: 0, y: 100 }])],
    ]));
    assert([...joined.values()].every(edge => edge.crossingCount === 0));
    const touch = decorateEdgeCrossings(new Map([
        ['a', route([{ x: 50, y: -100 }, { x: 50, y: 0 }])],
        ['b', route([{ x: 0, y: 0 }, { x: 100, y: 0 }])],
    ]));
    assert.equal(touch.get('a').crossingCount, 0, 'a terminating wire is never cut at its socket');
    assert.equal(touch.get('b').crossingCount, 1);
});

test('rounded common-target socket convergence keeps its legitimate final shared stub joined', () => {
    const no = route([{ x: 600, y: 490.7098 }, { x: 647.2857, y: 490.7098 }, { x: 647.2857, y: 497.7098 }, { x: 677.2857, y: 497.7098 }],
        'M 600 490.7098 L 643.7857 490.7098 Q 647.2857 490.7098 647.2857 494.2098 L 647.2857 494.2098 Q 647.2857 497.7098 650.7857 497.7098 L 677.2857 497.7098');
    const unknown = route([{ x: 600, y: 504.7098 }, { x: 641.2857, y: 504.7098 }, { x: 641.2857, y: 497.7098 }, { x: 677.2857, y: 497.7098 }],
        'M 600 504.7098 L 637.7857 504.7098 Q 641.2857 504.7098 641.2857 501.2098 L 641.2857 501.2098 Q 641.2857 497.7098 644.7857 497.7098 L 677.2857 497.7098');
    const decorated = decorateEdgeCrossings(new Map([['no', no], ['unknown', unknown]]));
    assert.equal(decorated.get('no').crossingCount, 0);
    assert.equal(decorated.get('unknown').crossingCount, 0);
    assert.equal(decorated.get('no').displayPath, no.path);
    assert.equal(decorated.get('unknown').displayPath, unknown.path);

    // Sharing a target does not exempt genuine remote crossings on the way in.
    const remote = decorateEdgeCrossings(new Map([
        ['a', route([{ x: 0, y: 0 }, { x: 1000, y: 0 }])],
        ['b', route([{ x: 500, y: -100 }, { x: 500, y: 0 }, { x: 1000, y: 0 }])],
    ]));
    assert.equal(remote.get('a').crossingCount, 1);
    assert.notEqual(remote.get('a').displayPath, remote.get('a').path);
});

test('nearby gaps merge, duplicate curve sample intersections are counted once, and invalid input stays recoverable', () => {
    const next = decorateEdgeCrossings(new Map([
        ['a', route([{ x: 0, y: 0 }, { x: 200, y: 0 }])],
        ['b', route([{ x: 90, y: -100 }, { x: 90, y: 100 }])],
        ['c', route([{ x: 100, y: -100 }, { x: 100, y: 100 }])],
    ]));
    assert.equal(next.get('a').crossingCount, 2);
    assert.equal(next.get('a').displayPath, 'M 0 0 L 79 0 M 111 0 L 200 0');
    const invalid = new Map([['empty', { path: 'M 0 0', points: [], labelX: 0, labelY: 0 }], ['invalid', { path: '', points: [{ x: NaN, y: 0 }], labelX: 0, labelY: 0 }]]);
    const fallback = decorateEdgeCrossings(invalid);
    assert.equal(fallback.size, 2);
    assert.equal(fallback.get('empty').displayPath, 'M 0 0');
    assert.equal(fallback.get('invalid').crossingCount, 0);
});

test('a dense 256-wire workload stays finite and within a bounded interactive pass', t => {
    const routes = new Map();
    for (let index = 0; index < 128; index++) {
        routes.set(`h:${String(index).padStart(3, '0')}`, route([{ x: 0, y: 100 + index * 24 }, { x: 3400, y: 100 + index * 24 }]));
        routes.set(`v:${String(index).padStart(3, '0')}`, route([{ x: 100 + index * 24, y: 0 }, { x: 100 + index * 24, y: 3400 }]));
    }
    const started = performance.now(), next = decorateEdgeCrossings(routes), elapsed = performance.now() - started;
    assert.equal(next.size, 256);
    assert.equal([...next.values()].reduce((count, edge) => count + edge.crossingCount, 0), 128 * 128);
    for (const edge of next.values()) { assert(edge.displayPath.length); assert(!/NaN|Infinity/.test(edge.displayPath)); }
    assert(elapsed < 1500, `dense pass ${elapsed.toFixed(1)}ms`);
    t.diagnostic(`256-wire/16384-crossing visual pass=${elapsed.toFixed(1)}ms`);
});

test('split visible strokes retain continuous hit targets, single endpoint markers and branch labels', async () => {
    const f = await reactFixture('export { StudioEdgePicture } from "./components/automation/studio-flow-edge";');
    try {
        f.dom.window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 30, height: 12 }; };
        const decorated = decorateEdgeCrossings(new Map([
            ['a', route([{ x: 0, y: 50 }, { x: 100, y: 50 }])],
            ['b', route([{ x: 50, y: 0 }, { x: 50, y: 100 }])],
        ])).get('a');
        const props = { id: 'a', source: 'source', target: 'target', sourceX: 0, sourceY: 50, targetX: 100, targetY: 50,
            data: { port: 'no' }, selected: true, label: '該当しない', markerStart: 'url(#start)', markerEnd: 'url(#end)', style: { stroke: '#456' }, route: decorated };
        await f.render(f.React.createElement('svg', null, f.React.createElement(f.exports.StudioEdgePicture, props)));
        const wire = f.container.querySelector('.react-flow__edge-path'), hit = f.container.querySelector('.react-flow__edge-interaction');
        const markers = f.container.querySelector('.studio-edge-endmarkers'), halo = f.container.querySelector('.studio-edge-halo');
        assert.equal(wire.getAttribute('d'), decorated.displayPath);
        assert.equal(halo.getAttribute('d'), decorated.displayPath);
        assert.equal(hit.getAttribute('d'), decorated.path);
        assert.equal(hit.getAttribute('stroke-width'), '22');
        assert.equal(markers.getAttribute('d'), decorated.path);
        assert.equal(markers.getAttribute('marker-start'), 'url(#start)');
        assert.equal(markers.getAttribute('marker-end'), 'url(#end)');
        assert.equal(markers.getAttribute('stroke-width'), '4', 'markerUnits follows the selected stroke width');
        assert.equal(wire.getAttribute('marker-end'), null, 'split subpaths do not grow spurious arrowheads');
        assert.equal(f.container.querySelector('.react-flow__edge-text').textContent, '該当しない');
        assert.equal(wire.style.strokeWidth, '4');
        assert.equal(markers.getAttribute('pointer-events'), 'none');
    } finally { await f.close(); }
});
