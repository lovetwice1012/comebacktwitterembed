'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransport } = require('../../src/automation/transport');
const owner = '222222222222222222', channel = '333333333333333333';
async function prepare(format, members, kind = 'auto') {
    let calls = 0;
    const rest = { post: async route => { assert.equal(route, '/users/@me/channels'); calls++; return { id: channel }; } };
    const transport = createTransport({}, {}, { options: { jsonTransformer: value => value } }, { rest });
    const job = { id: 'aggregate-rendering', owner_user_id: owner, target_kind: kind, plan: {
        context: {}, event: { title: 'obsolete parent' }, text: 'obsolete text', display: { format, media: 'inherit' }, members,
    } };
    const result = await transport.prepare(job, { kind: 'dm', dm_user_id: owner });
    assert.equal(calls, 1, 'only destination preparation; no member expansion requests');
    for (const payload of result.payloads) assert.deepEqual(payload.body.allowed_mentions.parse, []);
    return result.payloads.map(payload => payload.body);
}
const members = ['first', 'second'].map(title => ({ event: { title, url: `https://github.com/example/${title}` }, text: `${title}\nhttps://github.com/example/${title}` }));
test('aggregate cards retain every member title, URL and transformed text', async () => {
    const bodies = await prepare('card', members);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies.flatMap(body => body.embeds.map(embed => embed.title)), ['first', 'second']);
    assert.deepEqual(bodies.flatMap(body => body.embeds.map(embed => embed.description)), members.map(member => member.text));
    assert(bodies.every(body => !body.flags));
});
test('aggregate text and URL-only output suppress secondary Discord expansion', async () => {
    for (const format of ['text', 'url']) {
        const bodies = await prepare(format, members);
        assert(bodies.every(body => body.flags === 4 && !body.embeds?.length));
        assert.equal(bodies.length, 1); assert.equal(bodies[0].content, members.map(member => member.text).join('\n\n'));
    }
});
test('expanded aggregate snapshots preserve historical prices and deltas without refetching', async () => {
    const bodies = await prepare('expanded', [{ event: { title: 'observed', priceAmount: 950, priceDelta: -150, currency: 'JPY', observedAtMs: 1000 }, text: 'recorded' }], 'price');
    assert.equal(bodies[0].embeds[0].timestamp, '1970-01-01T00:00:01.000Z');
    assert(bodies[0].embeds[0].fields.some(field => field.name === '増減' && field.value === '-150 JPY'));
});
test('each retained display is used and old members fall back to the frozen parent display', async () => {
    const bodies = await prepare('card', [{ ...members[0], display: { format: 'text', media: 'hide' } }, members[1]]);
    assert.equal(bodies[0].content, members[0].text); assert.equal(bodies[0].flags, 4);
    assert.equal(bodies[1].embeds[0].title, 'second');
});
test('expanded auto aggregates use recorded metadata and never fetch each URL at once', async () => {
    const bodies = await prepare('expanded', members);
    assert.deepEqual(bodies.flatMap(body => body.embeds.map(embed => embed.title)), ['first', 'second']);
});
test('large aggregate cards split before Discord embed-count and total-text limits', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({ event: { title: `member ${i}` }, text: 'x'.repeat(1900) }));
    const bodies = await prepare('card', entries);
    assert.equal(bodies.length, 9);
    assert.equal(bodies.flatMap(body => body.embeds).length, 25);
    assert(bodies.every(body => body.embeds.length <= 10 && body.embeds.reduce((n, embed) => n + embed.title.length + embed.description.length, 0) <= 6000));
    const short = await prepare('card', entries.map(entry => ({ ...entry, text: 'short' })));
    assert.deepEqual(short.map(body => body.embeds.length), [10, 10, 5]);
});
