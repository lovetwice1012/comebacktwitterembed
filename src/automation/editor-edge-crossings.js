'use strict';

// Routing is responsible for avoiding crossings. When fixed sockets leave an
// unavoidable crossing, break only the lower stroke, never the logical edge or
// its continuous hit area. This also distinguishes a crossing from a junction.
const EPSILON = 0.0001;
const CURVE_STEPS = 12;
const GAP_RADIUS = 11;
// Incoming wires intentionally share their last socket stub. Keep the same
// allowance as the router so convergence into one socket is not shown as a gap.
const SOCKET_RADIUS = 48;
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const samePoint = (a, b) => Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const coordinate = value => Math.round(value * 1000) / 1000;
const xy = point => `${coordinate(point.x)} ${coordinate(point.y)}`;

function at(primitive, t) {
    if (!primitive.control) return lerp(primitive.start, primitive.end, t);
    return lerp(lerp(primitive.start, primitive.control, t), lerp(primitive.control, primitive.end, t), t);
}

function geometry(route) {
    if (!Array.isArray(route.points) || route.points.length < 2 || route.points.length > 512
        || route.points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        || typeof route.path !== 'string' || route.path.length > 32768) return null;
    const points = route.points.filter((point, index) => !index || !samePoint(point, route.points[index - 1]));
    if (points.length < 2) return null;
    // Read actual SVG primitives: obstacle routing can deliberately use radius 0
    // near a card. Reconstructing those corners at radius 10 would cross the card.
    const pattern = /[MLQ]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/g;
    const tokens = route.path.match(pattern) || [];
    if (route.path.replace(pattern, '').replace(/[\s,]/g, '') || tokens[0] !== 'M') return null;
    const initial = { x: Number(tokens[1]), y: Number(tokens[2]) };
    if (!Number.isFinite(initial.x) || !Number.isFinite(initial.y) || !samePoint(initial, points[0])) return null;
    const primitives = [], segments = [];
    let cursor = initial, length = 0;
    const append = (end, control) => {
        if (samePoint(cursor, end) && !control) return;
        const primitive = { start: cursor, end, control, offset: length, samples: [{ t: 0, length: 0 }] };
        let before = cursor, localLength = 0;
        const steps = control ? CURVE_STEPS : 1;
        for (let step = 1; step <= steps; step++) {
            const t = step / steps, point = at(primitive, t), span = distance(before, point);
            if (span > EPSILON) segments.push({ start: before, end: point, primitive, t0: (step - 1) / steps, t1: t, offset: length + localLength, length: span,
                left: Math.min(before.x, point.x), right: Math.max(before.x, point.x), top: Math.min(before.y, point.y), bottom: Math.max(before.y, point.y) });
            localLength += span; primitive.samples.push({ t, length: localLength }); before = point;
        }
        primitive.length = localLength; primitives.push(primitive); length += localLength; cursor = end;
    };
    for (let index = 3; index < tokens.length;) {
        const command = tokens[index++], count = command === 'L' ? 2 : command === 'Q' ? 4 : 0;
        if (!count || index + count > tokens.length) return null;
        const values = tokens.slice(index, index + count).map(Number);
        if (!values.every(Number.isFinite)) return null;
        index += count;
        if (command === 'L') append({ x: values[0], y: values[1] });
        else append({ x: values[2], y: values[3] }, { x: values[0], y: values[1] });
    }
    if (!samePoint(cursor, points.at(-1))) return null;
    return { points, primitives, segments, length };
}

function intersection(first, second) {
    const rx = first.end.x - first.start.x, ry = first.end.y - first.start.y;
    const sx = second.end.x - second.start.x, sy = second.end.y - second.start.y;
    const denominator = rx * sy - ry * sx;
    if (Math.abs(denominator) < EPSILON) return null; // Parallel trunks are separated by the router.
    const qx = second.start.x - first.start.x, qy = second.start.y - first.start.y;
    const t = (qx * sy - qy * sx) / denominator, u = (qx * ry - qy * rx) / denominator;
    if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
    return { point: lerp(first.start, first.end, Math.min(1, Math.max(0, t))), first: first.offset + Math.min(1, Math.max(0, t)) * first.length,
        second: second.offset + Math.min(1, Math.max(0, u)) * second.length };
}

function sharedSocket(first, second, point) {
    return [first.points[0], first.points.at(-1)].some(a => [second.points[0], second.points.at(-1)].some(b => samePoint(a, b) && distance(a, point) <= SOCKET_RADIUS));
}

function parameter(primitive, along) {
    if (!primitive.control) return along / primitive.length;
    const samples = primitive.samples;
    for (let index = 1; index < samples.length; index++) {
        if (along <= samples[index].length) {
            const before = samples[index - 1], after = samples[index];
            return before.t + (after.t - before.t) * (along - before.length) / Math.max(EPSILON, after.length - before.length);
        }
    }
    return 1;
}

function pathWithGaps(geometry, crossings) {
    const ranges = crossings.map(value => [Math.max(1, value - GAP_RADIUS), Math.min(geometry.length - 1, value + GAP_RADIUS)]).sort((a, b) => a[0] - b[0]);
    const gaps = [];
    for (const range of ranges) {
        if (range[0] >= range[1]) continue;
        if (gaps.length && range[0] <= gaps.at(-1)[1]) gaps.at(-1)[1] = Math.max(gaps.at(-1)[1], range[1]);
        else gaps.push(range);
    }
    let cursor = 0;
    const spans = [];
    for (const [start, end] of gaps) { if (start > cursor) spans.push([cursor, start]); cursor = end; }
    if (cursor < geometry.length) spans.push([cursor, geometry.length]);
    let path = '';
    for (const [start, end] of spans) {
        let started = false;
        for (const primitive of geometry.primitives) {
            if (primitive.offset + primitive.length <= start || primitive.offset >= end) continue;
            const t0 = parameter(primitive, Math.max(0, start - primitive.offset)), t1 = parameter(primitive, Math.min(primitive.length, end - primitive.offset));
            const from = at(primitive, t0), to = at(primitive, t1);
            if (!started) { path += `${path ? ' ' : ''}M ${xy(from)}`; started = true; }
            if (primitive.control) {
                const derivative = { x: (1 - t0) * (primitive.control.x - primitive.start.x) + t0 * (primitive.end.x - primitive.control.x),
                    y: (1 - t0) * (primitive.control.y - primitive.start.y) + t0 * (primitive.end.y - primitive.control.y) };
                path += ` Q ${xy({ x: from.x + derivative.x * (t1 - t0), y: from.y + derivative.y * (t1 - t0) })} ${xy(to)}`;
            } else path += ` L ${xy(to)}`;
        }
    }
    return path;
}

/**
 * Decorate the visible stroke only. Points/path/endpoints remain suitable for
 * routing, reconnection, keyboard navigation and the continuous hit target.
 * @param {ReadonlyMap<string, import('./editor-edge-routing').EdgeRoute>} routes
 * @returns {Map<string, import('./editor-edge-crossings').CrossingEdgeRoute>}
 */
function decorateEdgeCrossings(routes) {
    const records = [], allSegments = [], gaps = new Map();
    for (const [id, route] of routes) {
        const shape = geometry(route), record = { id, route, shape };
        records.push(record); gaps.set(id, []);
        if (shape) for (const segment of shape.segments) allSegments.push({ ...segment, record });
    }
    allSegments.sort((a, b) => a.left - b.left || a.top - b.top || a.record.id.localeCompare(b.record.id));
    let active = [];
    for (const segment of allSegments) {
        active = active.filter(other => other.right + EPSILON >= segment.left);
        for (const other of active) {
            if (other.record === segment.record || other.bottom + EPSILON < segment.top || other.top - EPSILON > segment.bottom) continue;
            const crossing = intersection(segment, other);
            if (!crossing || sharedSocket(segment.record.shape, other.record.shape, crossing.point)) continue;
            const firstAvailable = crossing.first > GAP_RADIUS && crossing.first < segment.record.shape.length - GAP_RADIUS;
            const secondAvailable = crossing.second > GAP_RADIUS && crossing.second < other.record.shape.length - GAP_RADIUS;
            if (!firstAvailable && !secondAvailable) continue; // Preserve actual sockets and endpoint arrows.
            const under = firstAvailable && (!secondAvailable || segment.record.id.localeCompare(other.record.id) < 0) ? segment.record : other.record;
            gaps.get(under.id).push(under === segment.record ? crossing.first : crossing.second);
        }
        active.push(segment);
    }
    return new Map(records.map(({ id, route, shape }) => {
        const distinct = [...new Set(gaps.get(id).map(value => Math.round(value * 1000) / 1000))];
        return [id, { ...route, displayPath: distinct.length && shape ? pathWithGaps(shape, distinct) : route.path, crossingCount: distinct.length }];
    }));
}

module.exports = { decorateEdgeCrossings };
