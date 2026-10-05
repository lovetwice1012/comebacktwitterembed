'use strict';

const { NODE_TYPES, FIELDS, OPS, newWorkflow, assertWorkflow } = require('./schema');
const GOALS = [
    ['all', 'すべての新着', null],
    ['sale', 'セール告知', { field: 'title', op: 'contains', value: 'セール' }],
    ['announce', 'お知らせ', { field: 'title', op: 'contains', value: 'お知らせ' }],
    ['releaseText', '新作のお知らせ', { field: 'title', op: 'contains', value: '新作' }],
    ['excludeAd', '広告語を除外', { field: 'title', op: 'notContains', value: '広告' }],
    ['excludeSpoiler', 'ネタバレ語を除外', { field: 'title', op: 'notContains', value: 'ネタバレ' }],
    ['keyword', '指定キーワード', { field: 'title', op: 'contains', value: '新着' }],
    ['bodyWord', '本文に指定語', { field: 'body', op: 'contains', value: '発売' }],
    ['tag', '指定タグ', { field: 'tags', op: 'contains', value: '新作' }],
    ['author', '指定作者', { field: 'author', op: 'eq', value: '作者名' }],
    ['youtube', 'YouTube新着', { field: 'providerId', op: 'eq', value: 'youtube' }],
    ['github', 'GitHub公開イベント', { field: 'providerId', op: 'eq', value: 'github' }],
    ['release', 'GitHubリリース', { field: 'kind', op: 'eq', value: 'ReleaseEvent' }],
    ['push', 'GitHub Push', { field: 'kind', op: 'eq', value: 'PushEvent' }],
    ['twitch', 'Twitch配信', { field: 'providerId', op: 'eq', value: 'twitch' }],
    ['spotify', 'Spotify新着', { field: 'providerId', op: 'eq', value: 'spotify' }],
    ['pixiv', 'Pixiv作品', { field: 'providerId', op: 'eq', value: 'pixiv' }],
    ['booth', 'BOOTH商品', { field: 'providerId', op: 'eq', value: 'booth' }],
    ['amazon', 'Amazon価格', { field: 'providerId', op: 'eq', value: 'amazon' }],
    ['steam', 'Steam価格', { field: 'providerId', op: 'eq', value: 'steam' }],
    ['down', '値下げのみ', { field: 'priceDelta', op: 'lt', value: 0 }],
    ['up', '値上げのみ', { field: 'priceDelta', op: 'gt', value: 0 }],
    ['down500', '500以上の値下げ', { field: 'priceDelta', op: 'lte', value: -500 }],
    ['budget', '予算以下', { field: 'priceAmount', op: 'lte', value: 3000 }],
    ['half', '50%以上割引', { field: 'discountPercent', op: 'gte', value: 50 }],
    ['free', '無料になった商品', { field: 'priceAmount', op: 'eq', value: 0 }],
    ['images', '複数画像', { field: 'mediaCount', op: 'gte', value: 2 }],
    ['longVideo', '10分以上の動画', { field: 'durationSeconds', op: 'gte', value: 600 }],
    ['ja', '日本語投稿', { field: 'language', op: 'eq', value: 'ja' }],
    ['safe', 'センシティブではない投稿', { field: 'sensitive', op: 'eq', value: false }],
    ['recent', '公開24時間以内', { field: 'ageMinutes', op: 'lte', value: 1440 }],
    ['available', '購入可能', { field: 'available', op: 'eq', value: true }],
];
const TIMES = [
    ['now', '即時', null], ['morning', '毎朝9時', ['09:00', '09:01']], ['noon', '毎日12時', ['12:00', '12:01']],
    ['evening', '毎日18時', ['18:00', '18:01']], ['day', '9〜22時', ['09:00', '22:00']],
    ['weekday', '平日9〜18時', ['09:00', '18:00']], ['weekend', '週末10〜18時', ['10:00', '18:00']], ['delay', '30分後', null],
];
const FORMATS = ['expanded', 'card', 'text', 'url'];
function template(goalId = 'all', timeId = 'now', format = 'expanded') {
    const goal = GOALS.find(g => g[0] === goalId), time = TIMES.find(t => t[0] === timeId);
    if (!goal || !time || !FORMATS.includes(format)) throw new Error('TEMPLATE_UNKNOWN');
    const rule = newWorkflow(`${goal[1]} / ${time[1]}`);
    rule.description = '取得できない項目は不明として通知しません。金額条件は監視商品の通貨単位です。';
    rule.nodes = [rule.nodes[0]]; rule.edges = [];
    let previous = 'start', port = 'out';
    const add = (id, type, config) => { rule.nodes.push({ id, type, config, position: { x: rule.nodes.length * 240, y: 80 } }); rule.edges.push({ id: `e_${id}`, source: previous, target: id, port }); previous = id; port = 'out'; };
    if (goal[2]) { add('filter', 'condition', { predicate: structuredClone(goal[2]) }); port = 'yes'; }
    if (time[2]) add('time', 'schedule', { ...structuredClone(NODE_TYPES.schedule.defaults), days: timeId === 'weekday' ? [1, 2, 3, 4, 5] : timeId === 'weekend' ? [6, 7] : [1, 2, 3, 4, 5, 6, 7], windows: [{ start: time[2][0], end: time[2][1] }] });
    if (timeId === 'delay') add('delay', 'delay', { minutes: 30, anchor: 'observed' });
    add('display', 'transform', { ...structuredClone(NODE_TYPES.transform.defaults), format });
    add('send', 'send', { destination: 'default' });
    return assertWorkflow(rule);
}
function catalog() {
    return { version: 1, nodes: NODE_TYPES, fields: FIELDS, operators: OPS,
        goals: GOALS.map(([id, label, predicate]) => ({ id, label, predicate })),
        times: TIMES.map(([id, label]) => ({ id, label })), formats: FORMATS, templateCount: GOALS.length * TIMES.length * FORMATS.length,
        delayPresets: [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880, 4320, 10080, 20160, 43200],
        dailyLimits: [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 40, 50, 75, 100] };
}
module.exports = { catalog, template, GOALS, TIMES, FORMATS };
