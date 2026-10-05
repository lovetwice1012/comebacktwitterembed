'use strict';

// This module has no DB, Discord, filesystem, or browser dependencies. Both
// representations and the runtime use exactly this contract.
const VERSION = 1;
const LIMITS = Object.freeze({ bytes: 1048576, nodes: 128, edges: 256, depth: 8, predicates: 128, paths: 512, outputs: 32 });
const FIELDS = Object.freeze({
    providerId: 'string', kind: 'string', sourceKey: 'string', contentId: 'string', url: 'string',
    title: 'string', body: 'string', author: 'string', tags: 'array', language: 'string',
    sensitive: 'boolean', mediaCount: 'number', durationSeconds: 'number', priceAmount: 'number',
    previousPriceAmount: 'number', priceDelta: 'number', discountPercent: 'number', currency: 'string',
    available: 'boolean', publishedAtMs: 'number', observedAtMs: 'number', ageMinutes: 'number',
});
const NODE_TYPES = Object.freeze({
    start: { label: '開始', ports: ['out'], defaults: {} },
    condition: { label: '条件分岐', ports: ['yes', 'no', 'unknown'], defaults: { predicate: { field: 'title', op: 'contains', value: 'セール' } } },
    dictionary: { label: '辞書照合', ports: ['yes', 'no', 'unknown'], defaults: { dictionary: 'words', fields: ['title', 'body'] } },
    merge: { label: '経路を合流', ports: ['out'], defaults: { mode: 'any', displayConflict: 'stop' } },
    delay: { label: '遅延', ports: ['out'], defaults: { minutes: 30, anchor: 'observed' } },
    schedule: { label: '通知時間', ports: ['out'], defaults: { zone: 'Asia/Tokyo', days: [1, 2, 3, 4, 5, 6, 7], windows: [{ start: '09:00', end: '22:00' }], quiet: [], datesExcluded: [], maxWaitDays: 14 } },
    transform: { label: '表示を変更', ports: ['out'], defaults: { format: 'expanded', template: '{title}\n{url}', maxLength: 1900, media: 'inherit', mentions: 'none' } },
    limit: { label: '件数制限', ports: ['out'], defaults: { count: 10, minutes: 60, key: 'sourceKey', overflow: 'defer' } },
    aggregate: { label: 'まとめ通知', ports: ['out'], defaults: { minutes: 60, key: 'sourceKey', mode: 'all', maxItems: 20 } },
    send: { label: '通知', ports: [], defaults: { destination: 'default' } },
    stop: { label: '通知しない', ports: [], defaults: { reason: 'ルールにより除外' } },
});
const OPS = ['eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'gt', 'gte', 'lt', 'lte', 'exists'];
const BRANCH_TYPES = new Set(['condition', 'dictionary']);
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

class RuleError extends Error {
    constructor(issues) {
        super('ルールの検証に失敗しました。');
        this.code = 'AUTOMATION_RULE_INVALID';
        this.issues = issues;
    }
}

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed, path, issues) {
    if (!plain(value)) { issues.push({ path, message: 'オブジェクトを指定してください。' }); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.push({ path: `${path}.${key}`, message: '未対応の項目です。' });
    return true;
}
function safeTree(value, issues, path = '$', depth = 0, seen = new Set()) {
    if (depth > 32) { issues.push({ path, message: '入れ子が深すぎます。' }); return; }
    if (typeof value === 'number' && !Number.isFinite(value)) issues.push({ path, message: '有限の数値が必要です。' });
    if (value && typeof value === 'object') {
        if (seen.has(value)) { issues.push({ path, message: '循環参照は使えません。' }); return; }
        seen.add(value);
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) issues.push({ path, message: '予約済みのキーです。' });
            else safeTree(item, issues, `${path}.${key}`, depth + 1, seen);
        }
        seen.delete(value);
    }
}
function validTime(value, end = false) { return typeof value === 'string' && (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) || end && value === '24:00'); }
function validDate(value) { const time = Date.parse(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value; }

function checkPredicate(p, path, issues, depth = 0, budget = { count: 0 }) {
    if (++budget.count > LIMITS.predicates || depth > LIMITS.depth) { issues.push({ path, message: '条件数または入れ子の上限を超えました。' }); return; }
    if (!plain(p)) { issues.push({ path, message: '条件が必要です。' }); return; }
    if (['all', 'any', 'not'].includes(p.op)) {
        keys(p, ['op', 'conditions'], path, issues);
        if (!Array.isArray(p.conditions) || p.conditions.length < 1 || p.conditions.length > 32 || p.op === 'not' && p.conditions.length !== 1) {
            issues.push({ path, message: '条件グループは1〜32件、否定は1件です。' }); return;
        }
        p.conditions.forEach((c, i) => checkPredicate(c, `${path}.conditions[${i}]`, issues, depth + 1, budget));
        return;
    }
    keys(p, ['field', 'op', 'value', 'ignoreCase'], path, issues);
    const type = FIELDS[p.field];
    if (!type || !Object.hasOwn(FIELDS, p.field)) issues.push({ path, message: '未対応のフィールドです。' });
    if (!OPS.includes(p.op)) issues.push({ path, message: '未対応の比較です。' });
    if (p.op === 'exists') return;
    if (['gt', 'gte', 'lt', 'lte'].includes(p.op) && (type !== 'number' || typeof p.value !== 'number' || !Number.isFinite(p.value))) issues.push({ path, message: '数値比較には数値フィールドと数値が必要です。' });
    else if (['contains', 'notContains', 'startsWith', 'endsWith'].includes(p.op) && (!['string', 'array'].includes(type) || typeof p.value !== 'string' || p.value.length > 2048 || !p.value.length)) issues.push({ path, message: '文字列条件が不正です。' });
    else if (p.op === 'in' && (!Array.isArray(p.value) || p.value.length > 100 || p.value.some(v => !['string', 'number', 'boolean'].includes(typeof v)))) issues.push({ path, message: '候補を100件以内で指定してください。' });
    else if (['eq', 'ne'].includes(p.op) && (type !== typeof p.value || type === 'array')) issues.push({ path, message: '比較値の型がフィールドと一致しません。' });
    if (p.ignoreCase !== undefined && typeof p.ignoreCase !== 'boolean') issues.push({ path, message: '大文字小文字の設定は真偽値です。' });
}

function checkConfig(node, path, issues) {
    const c = node.config;
    const allowed = Object.keys(NODE_TYPES[node.type].defaults);
    if (node.type === 'start') allowed.push('providers', 'kinds');
    if (node.type === 'transform') allowed.push('replacements', 'prefix', 'suffix');
    if (!keys(c, allowed, `${path}.config`, issues)) return;
    const issue = message => issues.push({ path: `${path}.config`, nodeId: node.id, message });
    const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
    if (node.type === 'start') {
        for (const k of ['providers', 'kinds']) if (c[k] !== undefined && (!Array.isArray(c[k]) || c[k].length > 32 || c[k].some(v => typeof v !== 'string' || v.length > 64))) issue('対象一覧が不正です。');
    }
    if (node.type === 'condition') checkPredicate(c.predicate, `${path}.config.predicate`, issues);
    if (node.type === 'merge' && (!['any', 'all'].includes(c.mode) || !['stop', 'reset'].includes(c.displayConflict))) issue('合流は「どれか／すべて」、表示の競合は「停止／標準に戻す」を選択してください。');
    if (node.type === 'dictionary' && (!NAME.test(c.dictionary || '') || !Array.isArray(c.fields) || !c.fields.length || c.fields.length > 8 || c.fields.some(f => !Object.hasOwn(FIELDS, f) || !['string', 'array'].includes(FIELDS[f])))) issue('辞書名と照合対象を指定してください。');
    if (node.type === 'delay' && (!integer(c.minutes, 0, 525600) || !['observed', 'published'].includes(c.anchor))) issue('遅延は0〜525600分、基準は検知または公開です。');
    if (node.type === 'schedule') {
        try { new Intl.DateTimeFormat('en', { timeZone: c.zone }).format(0); if (typeof c.zone !== 'string') issue('タイムゾーンが必要です。'); } catch { issue('タイムゾーンが不正です。'); }
        if (!Array.isArray(c.days) || !c.days.length || c.days.length > 7 || c.days.some(d => !integer(d, 1, 7))) issue('曜日を1〜7で指定してください。');
        for (const k of ['windows', 'quiet']) {
            if (!Array.isArray(c[k]) || c[k].length > 16 || k === 'windows' && !c[k].length) { issue('時間帯は1〜16件です。'); continue; }
            for (const w of c[k]) if (!plain(w) || Object.keys(w).some(key => !['start', 'end'].includes(key)) || !validTime(w.start) || !validTime(w.end, true) || w.start === w.end) issue('開始・終了時刻が不正です。');
        }
        if (!Array.isArray(c.datesExcluded) || c.datesExcluded.length > 366 || c.datesExcluded.some(d => !validDate(d))) issue('除外日をYYYY-MM-DDで指定してください。');
        if (!integer(c.maxWaitDays, 1, 366)) issue('最大待機は1〜366日です。');
    }
    if (node.type === 'transform') {
        if (!['expanded', 'card', 'text', 'url'].includes(c.format) || !['inherit', 'hide', 'links'].includes(c.media) || c.mentions !== 'none') issue('表示形式が不正です。');
        if (typeof c.template !== 'string' || c.template.length > 4000 || !integer(c.maxLength, 1, 1900)) issue('定型文または文字数上限が不正です。');
        for (const placeholder of String(c.template || '').matchAll(/\{([^{}]+)\}/g)) if (!Object.hasOwn(FIELDS, placeholder[1])) issue(`未対応の差し込み項目: ${placeholder[1]}`);
        for (const k of ['prefix', 'suffix']) if (c[k] !== undefined && (typeof c[k] !== 'string' || c[k].length > 500)) issue('前後の追加文は500文字以内です。');
        if (c.replacements !== undefined && (!Array.isArray(c.replacements) || c.replacements.length > 32 || c.replacements.some(r => !plain(r) || typeof r.from !== 'string' || !r.from.length || r.from.length > 128 || typeof r.to !== 'string' || r.to.length > 128))) issue('置換を32件以内で指定してください。');
    }
    if (node.type === 'limit' && (!integer(c.count, 1, 10000) || !integer(c.minutes, 1, 10080) || !['sourceKey', 'author', 'providerId', 'currency', 'all'].includes(c.key) || !['drop', 'defer'].includes(c.overflow))) issue('件数制限が不正です。');
    if (node.type === 'aggregate' && (!integer(c.minutes, 1, 10080) || !integer(c.maxItems, 1, 100) || !['sourceKey', 'author', 'providerId', 'currency', 'all'].includes(c.key) || !['all', 'latest'].includes(c.mode))) issue('まとめ通知の設定が不正です。');
    if (node.type === 'send' && !NAME.test(c.destination || '')) issue('通知先の差し込み名が不正です。');
    if (node.type === 'stop' && (typeof c.reason !== 'string' || c.reason.length > 500)) issue('除外理由は500文字以内です。');
}

function validateWorkflow(input) {
    const issues = [];
    safeTree(input, issues);
    if (issues.length) return { valid: false, issues };
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > LIMITS.bytes) return { valid: false, issues: [{ path: '$', message: 'ルールが大きすぎます。' }] };
    if (!keys(input, ['schemaVersion', 'name', 'description', 'nodes', 'edges', 'layout', 'expiresAfterMinutes'], '$', issues)) return { valid: false, issues };
    if (input.schemaVersion !== VERSION) issues.push({ path: '$.schemaVersion', message: '未対応のルール版です。' });
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) issues.push({ path: '$.name', message: '名前は1〜120文字です。' });
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 8000)) issues.push({ path: '$.description', message: '説明は8000文字以内です。' });
    if (input.expiresAfterMinutes !== undefined && (!Number.isSafeInteger(input.expiresAfterMinutes) || input.expiresAfterMinutes < 1 || input.expiresAfterMinutes > 525600)) issues.push({ path: '$.expiresAfterMinutes', message: '有効期限は1〜525600分です。' });
    if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > LIMITS.nodes || !Array.isArray(input.edges) || input.edges.length > LIMITS.edges) return { valid: false, issues: [...issues, { path: '$', message: 'ブロックは2〜128個、接続は256本までです。' }] };
    const nodes = new Map();
    input.nodes.forEach((node, i) => {
        const p = `$.nodes[${i}]`;
        if (!keys(node, ['id', 'type', 'config', 'position', 'group'], p, issues)) return;
        if (!NAME.test(node.id) || nodes.has(node.id)) issues.push({ path: p, message: 'ブロックIDが不正または重複しています。' });
        nodes.set(node.id, node);
        if (!Object.hasOwn(NODE_TYPES, node.type)) issues.push({ path: p, nodeId: node.id, message: '未対応のブロックです。' });
        else checkConfig(node, p, issues);
        if (node.position !== undefined && (!plain(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || Math.abs(node.position.x) > 1000000 || Math.abs(node.position.y) > 1000000)) issues.push({ path: p, message: '配置が不正です。' });
        if (node.group !== undefined && !NAME.test(node.group)) issues.push({ path: p, message: 'グループIDが不正です。' });
    });
    const starts = input.nodes.filter(n => n?.type === 'start');
    if (starts.length !== 1) issues.push({ path: '$.nodes', message: '開始ブロックは1つ必要です。' });
    const adjacency = new Map(input.nodes.map(n => [n?.id, []]));
    const edgeIds = new Set(), pairs = new Set();
    input.edges.forEach((edge, i) => {
        const p = `$.edges[${i}]`;
        if (!keys(edge, ['id', 'source', 'target', 'port'], p, issues)) return;
        const from = nodes.get(edge.source), to = nodes.get(edge.target);
        if (!NAME.test(edge.id) || edgeIds.has(edge.id)) issues.push({ path: p, message: '接続IDが不正または重複しています。' });
        edgeIds.add(edge.id);
        if (!from || !to || to.type === 'start' || !NODE_TYPES[from.type]?.ports.includes(edge.port)) { issues.push({ path: p, message: '接続先または分岐が不正です。' }); return; }
        const pair = `${edge.source}:${edge.port}:${edge.target}`;
        if (pairs.has(pair)) issues.push({ path: p, message: '同じ接続が重複しています。' });
        pairs.add(pair); adjacency.get(edge.source).push(edge.target);
    });
    const visited = new Set(), visiting = new Set();
    const visit = id => {
        if (visiting.has(id)) { issues.push({ path: '$.edges', nodeId: id, message: '循環接続は使えません。' }); return; }
        if (visited.has(id)) return;
        visiting.add(id);
        for (const next of adjacency.get(id) || []) visit(next);
        visiting.delete(id); visited.add(id);
    };
    if (starts[0]) visit(starts[0].id);
    for (const node of input.nodes) {
        if (!visited.has(node?.id)) issues.push({ path: '$.nodes', nodeId: node?.id, message: '開始から到達できません。' });
        if (NODE_TYPES[node?.type]?.ports.length && !(adjacency.get(node?.id) || []).length) issues.push({ path: '$.edges', nodeId: node?.id, message: '次のブロックへ接続してください。' });
    }
    if (input.layout !== undefined) {
        if (keys(input.layout, ['groups', 'viewport'], '$.layout', issues)) {
            const groups = input.layout.groups || [];
            if (!Array.isArray(groups) || groups.length > 32) issues.push({ path: '$.layout', message: 'グループは32個までです。' });
            else for (const g of groups) {
                if (!keys(g, ['id', 'label', 'collapsed'], '$.layout.groups', issues)) continue;
                if (!NAME.test(g.id) || typeof g.label !== 'string' || !g.label.trim() || g.label.length > 120 || g.collapsed !== undefined && typeof g.collapsed !== 'boolean' || groups.filter(other => other?.id === g.id).length !== 1) issues.push({ path: '$.layout.groups', message: 'グループが不正または重複しています。' });
            }
            const viewport = input.layout.viewport;
            if (viewport !== undefined && (!keys(viewport, ['x', 'y', 'zoom'], '$.layout.viewport', issues) || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0 || viewport.zoom > 10)) issues.push({ path: '$.layout.viewport', message: '表示位置・倍率が不正です。' });
        }
    }
    for (const node of input.nodes) if (node?.group && (!Array.isArray(input.layout?.groups) || !input.layout.groups.some(g => g?.id === node.group))) issues.push({ path: '$.nodes', nodeId: node.id, message: '所属グループが見つかりません。' });
    return { valid: !issues.length, issues };
}
function assertWorkflow(input) {
    const result = validateWorkflow(input);
    if (!result.valid) throw new RuleError(result.issues);
    return input;
}
function newWorkflow(name = '新しいルール') {
    return { schemaVersion: VERSION, name, nodes: [{ id: 'start', type: 'start', config: {}, position: { x: 40, y: 80 } }, { id: 'send', type: 'send', config: { destination: 'default' }, position: { x: 400, y: 80 } }], edges: [{ id: 'e1', source: 'start', target: 'send', port: 'out' }] };
}
module.exports = { VERSION, LIMITS, FIELDS, OPS, NODE_TYPES, BRANCH_TYPES, RuleError, validateWorkflow, assertWorkflow, newWorkflow };
