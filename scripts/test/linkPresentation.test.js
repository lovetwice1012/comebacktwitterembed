'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const gallery = require('../../src/mediaGallery');
const { createHistory, contentKey, addNotice } = require('../../src/sharedPostHistory');

const settings = { gallery_display_mode: 'gallery', enabled: true, defaultLanguage: 'ja', media_display_mode: 'embed' };
const step = () => ({ embeds: [
    { title: 'Album', url: 'https://www.pixiv.net/artworks/42', description: 'Caption', image: { url: 'https://images.example/a.jpg' } },
    { url: 'https://www.pixiv.net/artworks/42', image: { url: 'https://images.example/b.jpg' } },
], components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'showMediaAsAttachments', label: 'Files' },
    { type: 2, style: 4, custom_id: 'delete:pixiv', label: 'Delete' }] }],
analytics: { content: { contentUrl: 'https://www.pixiv.net/artworks/42' } } });
const message = (id = '100', channelId = '200', guildId = '300') => ({ id, channelId, guildId,
    channel: { id: channelId, messages: { fetch: async () => ({ channelId }) } } });
const success = id => ({ sent: [{ stepIndex: 0, messageId: id }], postprocess: [], outcome: 'F' });

test('gallery is opt-in, preserves metadata and leaves original payload unchanged', async () => {
    assert.equal(gallery.pagesFor(step(), {}), null);
    const original = step(), before = structuredClone(original);
    const saved = [];
    const prepared = await gallery.prepare(original, message(), { providerId: 'pixiv', presentationSettings: settings }, { save: async g => saved.push(g) });
    assert.deepEqual(original, before);
    assert.equal(prepared.step.embeds.length, 1);
    assert.equal(prepared.step.embeds[0].description, 'Caption');
    assert.equal(saved[0].pages.length, 2);
    const buttons = prepared.step.components.flatMap(row => row.components);
    assert.ok(buttons.some(b => b.custom_id === 'delete:pixiv'));
    assert.ok(!buttons.some(b => b.custom_id === 'showMediaAsAttachments'));
    assert.equal(buttons.find(b => b.label === '1 / 2').disabled, true);
    const second = gallery.render(saved[0], 1, '123456789012345678');
    assert.equal(second.embeds[0].image.url, 'https://images.example/b.jpg');
    assert.deepEqual(second.attachments, []);
    assert.equal(second.components[0].components[2].disabled, true);
    assert.ok(second.components[0].components.every(b => b.custom_id.endsWith(':123456789012345678')));
});

test('gallery preserves spoiler attachments and mixed media source order', () => {
    const mixed = { embeds: [{ title: 'Mixed' }], files: [
        { attachment: 'https://images.example/a.jpg', name: 'SPOILER_a.jpg' },
        { attachment: 'https://images.example/b.mp4', name: 'b.mp4' },
        { attachment: 'https://images.example/c.jpg', name: 'c.jpg' },
    ] };
    const pages = gallery.pagesFor(mixed, settings);
    assert.equal(pages.length, 3);
    assert.equal(pages[0].files[0].name, 'SPOILER_a.jpg');
    assert.equal(pages[0].embeds[0].image, undefined);
    assert.equal(pages[1].files[0].attachment, 'https://images.example/b.mp4');
});

test('gallery never restores hidden media, failure notices or opaque local files', async () => {
    for (const mode of ['link_only', 'thumbnail_only']) assert.equal(gallery.pagesFor(step(), { ...settings, media_display_mode: mode }), null);
    assert.equal(gallery.pagesFor({ embeds: [{ title: 'Metadata only' }] }, settings), null);
    assert.equal(gallery.pagesFor({ ...step(), outputRole: 'failure_notice' }, settings), null);
    assert.equal(gallery.pagesFor({ ...step(), files: [{ attachment: Buffer.from('test') }] }, settings), null);
    const original = step();
    const prepared = await gallery.prepare(original, message(), { providerId: 'pixiv', presentationSettings: { ...settings, button_invisible: { all: true } } }, { save: async () => assert.fail('must not save') });
    assert.equal(prepared.step, original);
});

test('a spoiler attachment referenced by an embed is never promoted to an uncovered image', () => {
    const original = step();
    original.files = [{ attachment: original.embeds[0].image.url, name: 'SPOILER_a.jpg' }];
    const pages = gallery.pagesFor(original, settings);
    assert.equal(pages[0].embeds[0].image, undefined);
    assert.equal(pages[0].files[0].name, 'SPOILER_a.jpg');
    assert.equal(pages.length, 2);
});

test('gallery storage failure falls back to the complete normal response', async () => {
    const original = step();
    const prepared = await gallery.prepare(original, message(), { providerId: 'instagram', presentationSettings: settings }, { save: async () => { throw new Error('fixture storage unavailable'); } });
    assert.equal(prepared.step, original);
    assert.equal(prepared.galleryId, undefined);
});

test('gallery settings fingerprint is order independent and detects restrictions changing', () => {
    assert.equal(gallery.settingsHash({ a: 1, b: { c: 2, d: 3 } }), gallery.settingsHash({ b: { d: 3, c: 2 }, a: 1 }));
    assert.notEqual(gallery.settingsHash(settings), gallery.settingsHash({ ...settings, media_display_mode: 'link_only' }));
});

function historyDb() {
    const rows = new Map();
    return { rows, queryDatabase: async (sql, p) => {
        if (sql.startsWith('DELETE')) return {};
        const key = p.slice(0, 3).join(':');
        if (sql.startsWith('SELECT')) {
            const row = rows.get(key);
            return row && BigInt(row.source_message_id) < BigInt(p[4]) ? [row] : [];
        }
        if (sql.startsWith('INSERT')) {
            const old = rows.get(key);
            if (!old || BigInt(old.source_message_id) < BigInt(p[3])) rows.set(key, {
                source_message_id: p[3], link_message_id: p[4], response_message_id: p[5],
            });
            return {};
        }
        assert.fail(sql);
    } };
}
const context = { providerId: 'pixiv', url: 'https://www.pixiv.net/artworks/42', sharedHistory: true, presentationSettings: settings };

test('gallery snapshots retain the inherited NSFW state of a thread', async () => {
    const source = message();
    source.channel.parent = { nsfw: true };
    let saved;
    await gallery.prepare(step(), source, context, { save: async value => { saved = value; } });
    assert.equal(saved.nsfw, true);
    assert.equal(saved.nsfwContextVersion, 1);
});

test('repeat posts still expand every image and receive a same-channel history link', async () => {
    const history = createHistory(historyDb());
    await history.run(message('100'), [step()], context, async () => success('101'));
    let actual;
    await history.run(message('102'), [step()], context, async steps => { actual = steps; return success('103'); });
    assert.equal(actual[0].embeds.length, 2);
    assert.match(actual[0].content, /以前にも共有/);
    assert.match(actual[0].content, /channels\/300\/200\/100/);
    for (const msg of [message('104', '201'), message('104', '200', '301')]) {
        await history.run(msg, [step()], context, async steps => { assert.equal(steps[0].content, undefined); return success('105'); });
    }
});

test('failed sends, silent results, failure notices and same-message retries do not count as prior shares', async () => {
    const db = historyDb(), history = createHistory(db);
    await history.run(message('100'), [step()], context, async () => ({ sent: [] }));
    assert.equal(db.rows.size, 0);
    await history.run(message('100'), [{ content: 'failure', outputRole: 'failure_notice' }], context, async () => success('101'));
    assert.equal(db.rows.size, 0);
    await history.run(message('100'), [step()], context, async () => success('101'));
    await history.run(message('100'), [step()], context, async steps => { assert.equal(steps[0].content, undefined); return success('102'); });
});

test('concurrent shares serialize history without suppressing either expansion', async () => {
    const history = createHistory(historyDb());
    const outputs = [];
    await Promise.all(['100', '102'].map(id => history.run(message(id), [step()], context, async steps => {
        outputs.push(steps); await new Promise(resolve => setImmediate(resolve)); return success(String(Number(id) + 1));
    })));
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0][0].content, undefined);
    assert.match(outputs[1][0].content, /以前にも共有/);
});

test('deleted source links fall back to confirmed bot reply; deleted replies produce no notice', async () => {
    const history = createHistory(historyDb());
    const key = contentKey(context.providerId, [step()], context.url);
    await history.remember(message('100'), key, success('101'), 0);
    const next = message('102');
    next.channel.messages.fetch = async ({ message: id }) => { if (id === '100') throw { code: 10008 }; return { channelId: '200' }; };
    assert.match(await history.previous(next, key), /\/101$/);
    next.channel.messages.fetch = async () => { throw { code: 10008 }; };
    assert.equal(await history.previous(next, key), null);
});

test('history database failure never blocks the original expansion', async () => {
    let sent = 0;
    const history = createHistory({ queryDatabase: async () => { throw new Error('fixture history unavailable'); } });
    await history.run(message(), [step()], context, async steps => { sent++; assert.equal(steps[0].embeds.length, 2); return success('101'); });
    assert.equal(sent, 1);
});

test('content identities unify Twitter aliases, use canonical URLs, and distinguish video IDs', () => {
    assert.equal(contentKey('twitter', [], 'https://twitter.com/alice/status/123?s=20'), contentKey('twitter', [], 'https://x.com/bob/status/123'));
    assert.equal(contentKey('pixiv', [step()], 'https://short.example/a'), contentKey('pixiv', [step()], 'https://short.example/b'));
    assert.notEqual(contentKey('youtube', [], 'https://youtube.com/watch?v=1'), contentKey('youtube', [], 'https://youtube.com/watch?v=2'));
});

test('history notice never truncates long original content', () => {
    const original = { content: 'x'.repeat(1990), files: ['https://images.example/a.jpg'] };
    const result = addNotice([original], 'https://discord.com/channels/1/2/3', 'en');
    assert.equal(result[0].content, original.content);
    assert.deepEqual(result[0].files, original.files);
    assert.match(result[1].content, /Previously shared/);
});
