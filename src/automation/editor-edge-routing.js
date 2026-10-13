'use strict';

// These offsets describe the picture only. The saved workflow and its handles
// stay unchanged, including when collapsed groups share a displayed handle.
function edgeLanes(edges) {
    const incoming = new Map(), outgoing = new Map(), handles = new Map();
    const collect = (map, key, edge) => { const list = map.get(key) || []; list.push(edge); map.set(key, list); };
    for (const edge of edges) {
        collect(incoming, edge.target, edge);
        collect(outgoing, edge.source, edge);
        collect(handles, JSON.stringify([edge.source, edge.sourceHandle || 'out']), edge);
    }
    const portOrder = { yes: 0, no: 1, unknown: 2, out: 3 };
    const compare = (a, b) => (portOrder[a.data?.port || a.sourceHandle] ?? 4) - (portOrder[b.data?.port || b.sourceHandle] ?? 4)
        || a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id);
    for (const map of [incoming, outgoing, handles]) for (const list of map.values()) list.sort(compare);
    return new Map(edges.map(edge => {
        const into = incoming.get(edge.target), from = outgoing.get(edge.source), shared = handles.get(JSON.stringify([edge.source, edge.sourceHandle || 'out']));
        return [edge.id, { targetIndex: into.indexOf(edge), targetCount: into.length, sourceIndex: shared.indexOf(edge), sourceCount: shared.length, routeIndex: from.indexOf(edge), routeCount: from.length }];
    }));
}

const centered = (index = 0, count = 1) => index - (count - 1) / 2;
const point = (x, y) => ({ x, y });
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
function roundedPath(raw, radius = 10) {
    const points = raw.filter((p, i) => !i || p.x !== raw[i - 1].x || p.y !== raw[i - 1].y);
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
        const before = points[i - 1], here = points[i], after = points[i + 1];
        const left = distance(before, here), right = distance(here, after), bend = Math.min(radius, left / 2, right / 2);
        if (!bend || (here.x - before.x) * (after.y - here.y) === (here.y - before.y) * (after.x - here.x)) { path += ` L ${here.x} ${here.y}`; continue; }
        const enter = point(here.x + (before.x - here.x) * bend / left, here.y + (before.y - here.y) * bend / left);
        const leave = point(here.x + (after.x - here.x) * bend / right, here.y + (after.y - here.y) * bend / right);
        path += ` L ${enter.x} ${enter.y} Q ${here.x} ${here.y} ${leave.x} ${leave.y}`;
    }
    const last = points.at(-1);
    return `${path} L ${last.x} ${last.y}`;
}

/** @param {{ sourceX: number, sourceY: number, targetX: number, targetY: number, lanes?: Partial<import('./editor-edge-routing').EdgeLanes> }} options */
function laneRoute({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, lanes = {} }) {
    const sourceLane = centered(lanes.sourceIndex, lanes.sourceCount), targetLane = centered(lanes.targetIndex, lanes.targetCount), routeLane = centered(lanes.routeIndex, lanes.routeCount);
    const sourceY = sy + sourceLane * 30, targetY = ty + targetLane * 14;
    const span = tx - sx;
    let points, labelX, labelY;
    if (span >= 88) {
        // Fan out/in near the actual sockets so converging wires share only
        // their final short stub rather than an entire horizontal segment.
        const exitX = sx + 30, entryX = tx - 30;
        const laneX = Math.max(exitX + 8, Math.min(entryX - 8, (sx + tx) / 2 + routeLane * 32 + targetLane * 16));
        points = [point(sx, sy), point(sx + 14, sy), point(exitX, sourceY), point(laneX, sourceY), point(laneX, targetY), point(entryX, targetY), point(tx - 14, ty), point(tx, ty)];
        // Labels stay close to the originating branch. Several wires from a
        // single socket use their fan-out rows for separate label positions.
        labelX = (exitX + laneX) / 2;
        labelY = sourceY;
    } else {
        // Keep backwards and tightly spaced connections outside their sockets;
        // distinct return lanes prevent parallel return wires from hiding.
        const exitX = sx + 40 + (lanes.sourceIndex || 0) * 14, entryX = tx - 40 - (lanes.targetIndex || 0) * 14;
        const returnY = Math.max(sy, ty) + 84 + (lanes.routeIndex || 0) * 28;
        points = [point(sx, sy), point(exitX, sy), point(exitX, returnY), point(entryX, returnY), point(entryX, ty), point(tx, ty)];
        labelX = (exitX + entryX) / 2; labelY = returnY;
    }
    return { path: roundedPath(points), points, labelX, labelY };
}

const EPSILON = 0.001;
const between = (value, low, high) => value > low + EPSILON && value < high - EPSILON;
const overlap = (a, b, c, d) => Math.max(0, Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d)));
const coordinateKey = value => Math.round(value * 1000);
const lastIndexWhere = (values, predicate) => { for (let i = values.length - 1; i >= 0; i--) if (predicate(values[i])) return i; return -1; };
function boxesOf(obstacles, clearance) {
    return (obstacles || []).filter(box => [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0)
        .map(box => ({ id: box.id, left: box.x - clearance, right: box.x + box.width + clearance, top: box.y - clearance, bottom: box.y + box.height + clearance }));
}
function hitsBox(a, b, box) {
    // Liang-Barsky against an open rectangle, including legacy diagonal fan-outs.
    let low = 0, high = 1;
    for (const [start, delta, min, max] of [[a.x, b.x - a.x, box.left + EPSILON, box.right - EPSILON], [a.y, b.y - a.y, box.top + EPSILON, box.bottom - EPSILON]]) {
        if (Math.abs(delta) < EPSILON) { if (start < min || start > max) return false; continue; }
        const first = (min - start) / delta, last = (max - start) / delta;
        low = Math.max(low, Math.min(first, last)); high = Math.min(high, Math.max(first, last));
        if (low > high) return false;
    }
    return high >= 0 && low <= 1;
}
function simplify(points) {
    const result = [];
    for (const p of points) {
        if (result.length && Math.abs(p.x - result.at(-1).x) < EPSILON && Math.abs(p.y - result.at(-1).y) < EPSILON) continue;
        while (result.length > 1) {
            const a = result.at(-2), b = result.at(-1);
            if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) result.pop();
            else break;
        }
        if (result.length && samePoint(p, result.at(-1))) continue;
        result.push(p);
    }
    return result;
}
function occupiedSegments(routes) {
    const horizontal = new Map(), vertical = new Map();
    const occupied = { horizontal, vertical, segments: [], conflicts: new Map() };
    for (const points of routes || []) addOccupied(occupied, points);
    return occupied;
}
function addOccupied(occupied, points, socketIds = [], id) {
    const { horizontal, vertical, segments } = occupied;
    occupied.conflicts.clear();
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const map = a.y === b.y ? horizontal : a.x === b.x ? vertical : null;
        if (!map) continue;
        const key = coordinateKey(map === horizontal ? a.y : a.x);
        const segment = { a, b, id, sockets: [{ ...points[0], id: socketIds[0] }, { ...points.at(-1), id: socketIds[1] }] };
        const interval = { low: map === horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y), high: map === horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y), segment };
        const intervals = map.get(key) || []; intervals.push(interval); map.set(key, intervals);
        segments.push(segment);
    }
}
function samePoint(a, b) { return Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON; }
function sameSocket(a, b) { return samePoint(a, b) && a.id === b.id; }
function wireConflicts(a, b, occupied, sockets) {
    if (samePoint(a, b)) return { crossings: 0, shared: 0 };
    const key = `${coordinateKey(a.x)},${coordinateKey(a.y)}:${coordinateKey(b.x)},${coordinateKey(b.y)}:${sockets.map(p => `${coordinateKey(p.x)},${coordinateKey(p.y)},${p.id || ''}`).join(':')}`;
    const cached = occupied.conflicts.get(key); if (cached) return cached;
    let crossings = 0, shared = 0;
    const horizontal = Math.abs(a.y - b.y) < EPSILON;
    const candidates = (horizontal ? occupied.horizontal : occupied.vertical).get(coordinateKey(horizontal ? a.y : a.x)) || [];
    const perpendicular = [], lowKey = coordinateKey(Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y)), highKey = coordinateKey(Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y)), crossCoordinate = horizontal ? a.y : a.x;
    for (const [coordinate, intervals] of horizontal ? occupied.vertical : occupied.horizontal) {
        if (coordinate < lowKey || coordinate > highKey) continue;
        for (const interval of intervals) if (crossCoordinate >= interval.low - EPSILON && crossCoordinate <= interval.high + EPSILON) perpendicular.push(interval);
    }
    for (const interval of [...candidates, ...perpendicular]) {
        const segment = interval.segment;
        const { a: c, b: d } = segment, otherHorizontal = Math.abs(c.y - d.y) < EPSILON;
        const common = sockets.filter(socket => segment.sockets.some(other => sameSocket(socket, other)));
        if (horizontal === otherHorizontal) {
            if (Math.abs((horizontal ? a.y : a.x) - (horizontal ? c.y : c.x)) >= EPSILON) continue;
            const low = Math.max(Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y), Math.min(horizontal ? c.x : c.y, horizontal ? d.x : d.y));
            const high = Math.min(Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y), Math.max(horizontal ? c.x : c.y, horizontal ? d.x : d.y));
            if (high < low - EPSILON) continue;
            if (high <= low + EPSILON) {
                const touch = horizontal ? point(low, a.y) : point(a.x, low);
                if (!common.some(socket => distance(touch, socket) <= 48 + EPSILON)) crossings++;
                continue;
            }
            let length = high - low;
            // Only actual common sockets get a short shared stub. Nearby but
            // unrelated endpoints cannot acquire this allowance accidentally.
            for (const socket of common) {
                if (Math.abs((horizontal ? socket.y : socket.x) - (horizontal ? a.y : a.x)) < EPSILON) {
                    const coordinate = horizontal ? socket.x : socket.y;
                    length -= overlap(low, high, coordinate - 48, coordinate + 48);
                }
            }
            shared += Math.max(0, length);
        } else {
            const cross = horizontal ? point(c.x, a.y) : point(a.x, c.y);
            if (cross.x < Math.min(a.x, b.x) - EPSILON || cross.x > Math.max(a.x, b.x) + EPSILON || cross.y < Math.min(a.y, b.y) - EPSILON || cross.y > Math.max(a.y, b.y) + EPSILON
                || cross.x < Math.min(c.x, d.x) - EPSILON || cross.x > Math.max(c.x, d.x) + EPSILON || cross.y < Math.min(c.y, d.y) - EPSILON || cross.y > Math.max(c.y, d.y) + EPSILON) continue;
            if (!common.some(socket => distance(cross, socket) <= 48 + EPSILON)) crossings++;
        }
    }
    const result = { crossings, shared }; occupied.conflicts.set(key, result); return result;
}
function routeIsClear(points, boxes, sourceId, targetId, occupied, wireStrict = true) {
    const sockets = [{ ...points[0], id: sourceId }, { ...points.at(-1), id: targetId }];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (boxes.some(box => !((i === 1 && sourceId !== undefined && box.id === sourceId) || (i === points.length - 1 && targetId !== undefined && box.id === targetId)) && hitsBox(a, b, box))) return false;
        if (wireStrict && (a.x === b.x || a.y === b.y)) {
            const conflict = wireConflicts(a, b, occupied, sockets);
            if (conflict.crossings || conflict.shared > EPSILON) return false;
        }
    }
    return true;
}
class MinHeap {
    constructor() { this.items = []; }
    less(a, b) { return a.f < b.f || (a.f === b.f && (a.g < b.g || (a.g === b.g && a.state < b.state))); }
    push(item) {
        const items = this.items; let i = items.length; items.push(item);
        while (i) { const parent = (i - 1) >> 1; if (!this.less(item, items[parent])) break; items[i] = items[parent]; i = parent; } items[i] = item;
    }
    pop() {
        const items = this.items, first = items[0], last = items.pop();
        if (items.length) { let i = 0; while (i * 2 + 1 < items.length) { let child = i * 2 + 1; if (child + 1 < items.length && this.less(items[child + 1], items[child])) child++; if (!this.less(items[child], last)) break; items[i] = items[child]; i = child; } items[i] = last; }
        return first;
    }
}
function rectilinearRoute(start, end, boxes, occupied, preferred, margin, sockets, strict) {
    const bounds = { left: Math.min(start.x, end.x) - margin, right: Math.max(start.x, end.x) + margin, top: Math.min(start.y, end.y) - margin, bottom: Math.max(start.y, end.y) + margin };
    const nearby = boxes.filter(box => box.right >= bounds.left && box.left <= bounds.right && box.bottom >= bounds.top && box.top <= bounds.bottom);
    const xSet = new Set([start.x, end.x, bounds.left, bounds.right]), ySet = new Set([start.y, end.y, bounds.top, bounds.bottom]);
    for (const box of nearby) { if (box.left >= bounds.left) xSet.add(box.left); if (box.right <= bounds.right) xSet.add(box.right); if (box.top >= bounds.top) ySet.add(box.top); if (box.bottom <= bounds.bottom) ySet.add(box.bottom); }
    for (const p of preferred) { if (between(p.x, bounds.left, bounds.right)) xSet.add(p.x); if (between(p.y, bounds.top, bounds.bottom)) ySet.add(p.y); }
    // A perpendicular barrier must be skirted at its ends, rather than merely
    // receiving a neighboring parallel channel. Include both sides of nearby
    // wire endpoints so an available outer route can actually be searched.
    const wireEnds = occupied.segments.flatMap(segment => [segment.a, segment.b]);
    const closeEnds = wireEnds.map(p => ({ p, score: Math.min(Math.abs(p.x - start.x) + Math.abs(p.y - start.y), Math.abs(p.x - end.x) + Math.abs(p.y - end.y)) })).sort((a, b) => a.score - b.score || a.p.x - b.p.x || a.p.y - b.p.y).slice(0, 32).map(item => item.p);
    for (const p of closeEnds) {
        for (const x of [p.x - 12, p.x + 12]) if (between(x, bounds.left, bounds.right)) xSet.add(x);
        for (const y of [p.y - 12, p.y + 12]) if (between(y, bounds.top, bounds.bottom)) ySet.add(y);
    }
    // Give shared trunks neighboring channels. Bound the extra channels so a
    // large graph does not create a quadratic grid of every previous wire.
    const extraX = [...occupied.vertical.keys()].map(key => key / 1000).filter(x => between(x, bounds.left, bounds.right)).sort((a, b) => Math.min(Math.abs(a - start.x), Math.abs(a - end.x)) - Math.min(Math.abs(b - start.x), Math.abs(b - end.x)) || a - b).slice(0, 24);
    const extraY = [...occupied.horizontal.keys()].map(key => key / 1000).filter(y => between(y, bounds.top, bounds.bottom)).sort((a, b) => Math.min(Math.abs(a - start.y), Math.abs(a - end.y)) - Math.min(Math.abs(b - start.y), Math.abs(b - end.y)) || a - b).slice(0, 24);
    for (const x of extraX) for (const value of [x - 12, x + 12]) if (between(value, bounds.left, bounds.right)) xSet.add(value);
    for (const y of extraY) for (const value of [y - 12, y + 12]) if (between(value, bounds.top, bounds.bottom)) ySet.add(value);
    const xs = [...xSet].sort((a, b) => a - b), ys = [...ySet].sort((a, b) => a - b), width = xs.length, height = ys.length, count = width * height;
    const horizontalBlocked = new Uint8Array((width - 1) * height), verticalBlocked = new Uint8Array(width * (height - 1));
    for (const box of nearby) {
        const xLow = xs.findIndex(x => x > box.left + EPSILON), xHigh = lastIndexWhere(xs, x => x < box.right - EPSILON), yLow = ys.findIndex(y => y > box.top + EPSILON), yHigh = lastIndexWhere(ys, y => y < box.bottom - EPSILON);
        const hLow = Math.max(0, xs.findIndex(x => x >= box.left - EPSILON) - 1), hHighRaw = lastIndexWhere(xs, x => x <= box.right + EPSILON), hHigh = Math.min(width - 2, hHighRaw);
        const vLow = Math.max(0, ys.findIndex(y => y >= box.top - EPSILON) - 1), vHighRaw = lastIndexWhere(ys, y => y <= box.bottom + EPSILON), vHigh = Math.min(height - 2, vHighRaw);
        for (let y = Math.max(0, yLow); yLow >= 0 && y <= yHigh; y++) for (let x = hLow; x <= hHigh; x++) if (overlap(xs[x], xs[x + 1], box.left, box.right) > EPSILON) horizontalBlocked[y * (width - 1) + x] = 1;
        for (let x = Math.max(0, xLow); xLow >= 0 && x <= xHigh; x++) for (let y = vLow; y <= vHigh; y++) if (overlap(ys[y], ys[y + 1], box.top, box.bottom) > EPSILON) verticalBlocked[y * width + x] = 1;
    }
    const sx = xs.indexOf(start.x), sy = ys.indexOf(start.y), tx = xs.indexOf(end.x), ty = ys.indexOf(end.y), startNode = sy * width + sx, endNode = ty * width + tx;
    const costs = new Float64Array(count * 2); costs.fill(Infinity); const previous = new Int32Array(count * 2); previous.fill(-1); const heap = new MinHeap();
    const heuristic = (x, y) => Math.abs(xs[x] - end.x) + Math.abs(ys[y] - end.y);
    costs[startNode * 2] = 0; heap.push({ state: startNode * 2, g: 0, f: heuristic(sx, sy) });
    let found = -1, expanded = 0;
    while (heap.items.length) {
        const current = heap.pop(); if (current.g !== costs[current.state]) continue;
        if (strict && ++expanded > 15000) return null;
        const node = current.state >> 1, direction = current.state & 1, x = node % width, y = Math.floor(node / width);
        if (node === endNode) { found = current.state; break; }
        const neighbors = [];
        if (x + 1 < width && !horizontalBlocked[y * (width - 1) + x]) neighbors.push([x + 1, y, 0]);
        if (y + 1 < height && !verticalBlocked[y * width + x]) neighbors.push([x, y + 1, 1]);
        if (x > 0 && !horizontalBlocked[y * (width - 1) + x - 1]) neighbors.push([x - 1, y, 0]);
        if (y > 0 && !verticalBlocked[(y - 1) * width + x]) neighbors.push([x, y - 1, 1]);
        for (const [nx, ny, nextDirection] of neighbors) {
            const nextState = (ny * width + nx) * 2 + nextDirection, a = point(xs[x], ys[y]), b = point(xs[nx], ys[ny]), conflict = wireConflicts(a, b, occupied, sockets);
            if (strict && (conflict.crossings || conflict.shared > EPSILON)) continue;
            const cost = current.g + distance(a, b) + (direction !== nextDirection ? 24 : 0) + conflict.crossings * 1000000 + (conflict.shared > EPSILON ? 100000 + conflict.shared * 1000 : 0);
            if (cost + EPSILON >= costs[nextState]) continue;
            costs[nextState] = cost; previous[nextState] = current.state; heap.push({ state: nextState, g: cost, f: cost + heuristic(nx, ny) });
        }
    }
    if (found < 0) return null;
    const points = []; for (let state = found; state >= 0; state = previous[state]) { const node = state >> 1; points.push(point(xs[node % width], ys[Math.floor(node / width)])); }
    return simplify(points.reverse());
}
function labelPosition(points, boxes) {
    let best = null;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i], horizontal = a.y === b.y, length = distance(a, b);
        const ratios = length >= 112 ? [0.5, 56 / length, 1 - 56 / length] : [0.5];
        for (const ratio of ratios) {
            const x = a.x + (b.x - a.x) * ratio, y = a.y + (b.y - a.y) * ratio, labelBox = { left: x - 45, right: x + 45, top: y - 13, bottom: y + 13 };
            const covered = boxes.some(box => overlap(labelBox.left, labelBox.right, box.left, box.right) > EPSILON && overlap(labelBox.top, labelBox.bottom, box.top, box.bottom) > EPSILON);
            const score = length + (horizontal ? 270 : 0) - (covered ? 10000 : 0) - ((i === 1 || i === points.length - 1) && length < 96 ? 200 : 0);
            if (!best || score > best.score) best = { score, labelX: x, labelY: y };
        }
    }
    return { labelX: best?.labelX ?? points[0].x, labelY: best?.labelY ?? points[0].y };
}

function detourCandidate(start, end, boxes, occupied, preferred, sockets, strict) {
    const dense = boxes.length > 64 || occupied.segments.length > 128;
    const rows = new Set([start.y, end.y]), columns = new Set([start.x, end.x]);
    const near = boxes.filter(box => box.right >= Math.min(start.x, end.x) - 64 && box.left <= Math.max(start.x, end.x) + 64 && box.bottom >= Math.min(start.y, end.y) - 96 && box.top <= Math.max(start.y, end.y) + 96);
    for (const box of near) { rows.add(box.top); rows.add(box.bottom); columns.add(box.left); columns.add(box.right); }
    const closest = (set, a, b) => [...set].sort((x, y) => Math.min(Math.abs(x - a), Math.abs(x - b)) - Math.min(Math.abs(y - a), Math.abs(y - b)) || x - y).slice(0, dense ? 8 : 20);
    const ys = closest(rows, start.y, end.y), xs = closest(columns, start.x, end.x);
    for (const y of [...occupied.horizontal.keys()].map(key => key / 1000).sort((a, b) => Math.min(Math.abs(a - start.y), Math.abs(a - end.y)) - Math.min(Math.abs(b - start.y), Math.abs(b - end.y))).slice(0, dense ? 4 : 8)) ys.push(y - 12, y + 12);
    for (const x of [...occupied.vertical.keys()].map(key => key / 1000).sort((a, b) => Math.min(Math.abs(a - start.x), Math.abs(a - end.x)) - Math.min(Math.abs(b - start.x), Math.abs(b - end.x))).slice(0, dense ? 4 : 8)) xs.push(x - 12, x + 12);
    const occupiedEnds = occupied.segments.flatMap(segment => [segment.a, segment.b]);
    for (const { p } of occupiedEnds.map(p => ({ p, score: Math.min(Math.abs(p.x - start.x) + Math.abs(p.y - start.y), Math.abs(p.x - end.x) + Math.abs(p.y - end.y)) })).sort((a, b) => a.score - b.score || a.p.x - b.p.x || a.p.y - b.p.y).slice(0, dense ? 8 : 16)) {
        xs.push(p.x - 12, p.x + 12); ys.push(p.y - 12, p.y + 12);
    }
    if (occupiedEnds.length) {
        xs.push(Math.min(...occupiedEnds.map(p => p.x)) - 24, Math.max(...occupiedEnds.map(p => p.x)) + 24);
        ys.push(Math.min(...occupiedEnds.map(p => p.y)) - 24, Math.max(...occupiedEnds.map(p => p.y)) + 24);
    }
    const candidates = [preferred, ...ys.map(y => [start, point(start.x, y), point(end.x, y), end]), ...xs.map(x => [start, point(x, start.y), point(x, end.y), end])];
    let best = null;
    for (const raw of candidates) {
        const points = simplify(raw); let score = 0, clear = true;
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1], b = points[i];
            if (boxes.some(box => hitsBox(a, b, box))) { clear = false; break; }
            const conflict = wireConflicts(a, b, occupied, sockets);
            if (strict && (conflict.crossings || conflict.shared > EPSILON)) { clear = false; break; }
            score += distance(a, b) + 24 + conflict.crossings * 1000000 + (conflict.shared > EPSILON ? 100000 + conflict.shared * 1000 : 0);
        }
        if (clear && (!best || score < best.score)) best = { score, points };
    }
    return best?.points || null;
}

function conflictKey(points, occupied, sockets) {
    for (let i = 1; i < points.length; i++) {
        const conflict = wireConflicts(points[i - 1], points[i], occupied, sockets);
        if (conflict.crossings || conflict.shared > EPSILON) return 'bounded-fallback';
    }
    return '';
}
/** Route around cards and prior wires without changing saved graph geometry. */
function edgeRoute(options, preparedBoxes, preparedOccupied) {
    const original = laneRoute(options), clearance = Math.max(0, options.clearance ?? 16), boxes = preparedBoxes || boxesOf(options.obstacles, clearance), occupied = preparedOccupied || occupiedSegments(options.occupied);
    // Standalone legacy lane previews remain unchanged; graph batches always
    // use orthogonal paths so every segment participates in crossing checks.
    if (!preparedBoxes && !boxes.length && !occupied.horizontal.size && !occupied.vertical.size) return original;
    const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty, sourceId, targetId, lanes = {} } = options;
    const sockets = [{ x: sx, y: sy, id: sourceId }, { x: tx, y: ty, id: targetId }], sourceBox = sourceId === undefined ? undefined : boxes.find(box => box.id === sourceId), targetBox = targetId === undefined ? undefined : boxes.find(box => box.id === targetId);
    let sourceLaneY = sy + centered(lanes.sourceIndex, lanes.sourceCount) * 30, targetLaneY = ty + centered(lanes.targetIndex, lanes.targetCount) * 14;
    let exitX = Math.max(sx + 30 + (lanes.sourceIndex || 0) * 6, sourceBox?.right ?? -Infinity), entryX = Math.min(tx - 30 - (lanes.targetIndex || 0) * 6, targetBox?.left ?? Infinity);
    for (const box of boxes) {
        if (box.id !== sourceId && box.left > sx && box.left >= (sourceBox?.right ?? sx) && overlap(Math.min(sy, sourceLaneY) - EPSILON, Math.max(sy, sourceLaneY) + EPSILON, box.top, box.bottom) > 0) exitX = Math.min(exitX, box.left);
        if (box.id !== targetId && box.right < tx && box.right <= (targetBox?.left ?? tx) && overlap(Math.min(ty, targetLaneY) - EPSILON, Math.max(ty, targetLaneY) + EPSILON, box.top, box.bottom) > 0) entryX = Math.max(entryX, box.right);
    }
    if (boxes.some(box => box.id !== sourceId && hitsBox(point(exitX, sy), point(exitX, sourceLaneY), box))) sourceLaneY = sy;
    if (boxes.some(box => box.id !== targetId && hitsBox(point(entryX, ty), point(entryX, targetLaneY), box))) targetLaneY = ty;
    const makeAnchors = (exit, entry) => {
        const sourceY = boxes.some(box => box.id !== sourceId && hitsBox(point(exit, sy), point(exit, sourceLaneY), box)) ? sy : sourceLaneY;
        const targetY = boxes.some(box => box.id !== targetId && hitsBox(point(entry, ty), point(entry, targetLaneY), box)) ? ty : targetLaneY;
        const prefix = [point(sx, sy), point(exit, sy), point(exit, sourceY)], suffix = [point(entry, targetY), point(entry, ty), point(tx, ty)];
        const start = prefix.at(-1), end = suffix[0], trunk = (exit + entry) / 2 + centered(lanes.routeIndex, lanes.routeCount) * 24;
        return { prefix, suffix, start, end, preferred: [start, point(trunk, start.y), point(trunk, end.y), end] };
    };
    const shortExit = Math.min(exitX, Math.max(sx + 14, sourceBox?.right ?? sx + 14)), shortEntry = Math.max(entryX, Math.min(tx - 14, targetBox?.left ?? tx - 14));
    const alternatives = [[exitX, entryX], [shortExit, shortEntry], [shortExit, entryX], [exitX, shortEntry]];
    const anchors = alternatives.filter(([exit, entry], index) => alternatives.findIndex(pair => pair[0] === exit && pair[1] === entry) === index).map(([exit, entry]) => makeAnchors(exit, entry));
    const finish = points => {
        const routingConflictKey = conflictKey(points, occupied, sockets);
        return { path: roundedPath(points, clearance >= 10 ? 10 : 0), points, ...labelPosition(points, boxes), ...(routingConflictKey ? { routingConflictKey } : {}) };
    };
    const wireEnds = occupied.segments.flatMap(segment => [segment.a, segment.b]);
    const allSpan = Math.max(160, ...boxes.flatMap(box => [Math.abs(box.left - sx) + 64, Math.abs(box.right - tx) + 64, Math.abs(box.top - sy) + 64, Math.abs(box.bottom - ty) + 64]), ...wireEnds.map(p => Math.max(Math.abs(p.x - sx), Math.abs(p.x - tx), Math.abs(p.y - sy), Math.abs(p.y - ty)) + 64));
    let fallback = null, fallbackScore = Infinity;
    const dense = boxes.length > 64 || occupied.segments.length > 128;
    for (const anchor of anchors) {
        const { prefix, suffix, preferred, start, end } = anchor, direct = simplify([...prefix, ...preferred, ...suffix]);
        if (routeIsClear(direct, boxes, sourceId, targetId, occupied)) return finish(direct);
        if (dense && fallback) continue;
        // A fixed socket stub crossing another wire cannot be repaired in the
        // middle search. Try the short-stub alternatives before a soft route.
        const fixedClear = routeIsClear(simplify(prefix), boxes, sourceId, undefined, occupied) && routeIsClear(simplify(suffix), boxes, undefined, targetId, occupied);
        if (fixedClear) {
            let middle = detourCandidate(start, end, boxes, occupied, preferred, sockets, true);
            if (middle) {
                const full = simplify([...prefix, ...middle, ...suffix]);
                if (routeIsClear(full, boxes, sourceId, targetId, occupied)) return finish(full);
            }
            for (const margin of boxes.length <= 64 && occupied.segments.length <= 128 ? [...new Set([96, 240, allSpan])] : []) {
                middle = rectilinearRoute(start, end, boxes, occupied, preferred, margin, sockets, true);
                if (!middle) continue;
                const full = simplify([...prefix, ...middle, ...suffix]);
                if (routeIsClear(full, boxes, sourceId, targetId, occupied)) return finish(full);
            }
        }
        const middle = detourCandidate(start, end, boxes, occupied, preferred, sockets, false);
        if (middle) {
            const full = simplify([...prefix, ...middle, ...suffix]);
            if (!routeIsClear(full, boxes, sourceId, targetId, occupied, false)) continue;
            let score = 0;
            for (let i = 1; i < full.length; i++) { const conflict = wireConflicts(full[i - 1], full[i], occupied, sockets); score += distance(full[i - 1], full[i]) + 24 + conflict.crossings * 1000000 + conflict.shared * 1000; }
            if (score < fallbackScore) { fallback = full; fallbackScore = score; }
        }
    }
    if (fallback) return finish(fallback);
    // Wire-only failure keeps a visible minimal-crossing route. A blocked flag
    // is reserved for genuinely overlapping cards enclosing a socket.
    for (const { prefix, suffix, preferred, start, end } of anchors) {
        for (const margin of [...new Set([96, 240, allSpan])]) {
            const middle = rectilinearRoute(start, end, boxes, occupied, preferred, margin, sockets, false);
            if (!middle) continue;
            const full = simplify([...prefix, ...middle, ...suffix]);
            if (routeIsClear(full, boxes, sourceId, targetId, occupied, false)) return finish(full);
        }
    }
    if (clearance > 0) return edgeRoute({ ...options, clearance: 0 }, undefined, occupied);
    return { ...original, blocked: true };
}

/** Stable peers are kept first; invalid cached crossings are rerouted as well. */
function edgeRoutes(edges, options = {}) {
    const routes = new Map(), occupied = occupiedSegments(options.occupied), boxes = boxesOf(options.obstacles, Math.max(0, options.clearance ?? 16)), pending = [], ordered = [...edges].sort((a, b) => a.id.localeCompare(b.id));
    for (const edge of ordered) {
        const previous = options.previousRoutes?.get(edge.id), first = previous?.points[0], last = previous?.points.at(-1);
        // New/moved wires are routed after all stable peers. A previously
        // searched fallback can therefore keep its node-safe geometry without
        // cascading a complete reroute through a dense nonplanar graph.
        const unchangedFallback = !options.occupied?.length && !!previous?.routingConflictKey;
        if (!previous?.blocked && first?.x === edge.sourceX && first.y === edge.sourceY && last?.x === edge.targetX && last.y === edge.targetY && routeIsClear(previous.points, boxes, edge.sourceId, edge.targetId, occupied, !unchangedFallback)) {
            const labelBox = { left: previous.labelX - 45, right: previous.labelX + 45, top: previous.labelY - 13, bottom: previous.labelY + 13 };
            const covered = boxes.some(box => overlap(labelBox.left, labelBox.right, box.left, box.right) > EPSILON && overlap(labelBox.top, labelBox.bottom, box.top, box.bottom) > EPSILON);
            const label = covered ? labelPosition(previous.points, boxes) : previous;
            // A route that no longer intersects a peer must not retain stale
            // fallback crossing annotations after moving or deleting a wire.
            const { crossings: ignoredCrossings, routingConflictKey: ignoredConflictKey, ...withoutCrossings } = previous;
            const stale = !unchangedFallback && (!!ignoredCrossings?.length || !!ignoredConflictKey);
            const route = label.labelX === previous.labelX && label.labelY === previous.labelY && !stale ? previous : { ...(unchangedFallback ? previous : withoutCrossings), labelX: label.labelX, labelY: label.labelY };
            routes.set(edge.id, route); addOccupied(occupied, route.points, [edge.sourceId, edge.targetId], edge.id);
        } else pending.push(edge);
    }
    for (const edge of pending) {
        const route = edgeRoute({ ...options, ...edge, occupied: options.occupied || [] }, boxes, occupied);
        routes.set(edge.id, route); addOccupied(occupied, route.points, [edge.sourceId, edge.targetId], edge.id);
    }
    return new Map(ordered.map(edge => [edge.id, routes.get(edge.id)]));
}

module.exports = { edgeLanes, edgeRoute, edgeRoutes };
