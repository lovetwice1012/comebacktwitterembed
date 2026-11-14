'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../../src/twitterGridCards');

const original = { guildId: '333333333333333333', channelId: '444444444444444444', author: { id: '111111111111111111' } };
const image = n => `https://pbs.twimg.com/media/photo${n}?format=jpg`;
function steps(urls, rows = []) {
    const first = urls.slice(0, 10), second = urls.slice(10);
    return [
        { components: rows, files: first, twitterGrid: { imageUrls: first, sequence: 0, totalParts: 2 } },
        { files: second, twitterGrid: { imageUrls: second, sequence: 1, totalParts: 2 } },
    ];
}
function memory() {
    const rows = new Map();
    return {
        rows,
        storage: {
            save: async (payload) => { rows.set(payload.id, { messageId: null, data: JSON.stringify(payload) }); },
            bind: async (id, messageId, persistent = false) => { rows.get(id).messageId = messageId; rows.get(id).persistent = persistent; },
        },
        db: { queryDatabase: async (sql, [next, id, messageId, expected]) => {
            const row = rows.get(id);
            if (!row || row.messageId !== messageId || row.data !== expected) return { affectedRows: 0 };
            row.data = next; return { affectedRows: 1 };
        } },
    };
}
function sent(id, files = []) {
    return { id, author: { id: '222222222222222222' }, content: '', embeds: [], components: [], attachments: new Map(files.map((file, i) => [String(i), file])) };
}
test('hidden combine button still records the complete ordered split without adding a control', async () => {
    const urls = Array.from({ length: 13 }, (_, i) => image(i));
    for (const button_invisible of [{ tg: true }, { all: true }]) {
        const [first, second] = steps(urls), { rows, storage, db } = memory();
        const result = await cards.prepare(first, original, { providerId: 'twitter', presentationSettings: { button_invisible } }, storage, [second]);
        assert.equal(result.step, first); assert.equal(result.grids.length, 1);
        const [record] = result.grids;
        assert.equal(record.headless, true); assert.equal(record.isPrimary, true);
        assert.equal(await cards.bind(record, sent('555555555555555555'), storage, db, first.twitterGrid), true);
        assert.deepEqual(await cards.finish(record, db), { state: 'pending' });
        assert.equal(await cards.append(record, second.twitterGrid, sent('666666666666666666'), db), true);
        assert.deepEqual(await cards.finish(record, db), { state: 'complete' });
        const saved = JSON.parse(rows.get(record.id).data);
        assert.deepEqual(saved.imageUrls, urls); assert.equal(saved.messageIds.length, 2);
        assert.deepEqual(saved.partSizes, [10, 3]); assert.equal(saved.partSignatures.length, 2);
        assert.equal(saved.partsState, 'complete');
    }
});
test('split-post action locators are present before binding and never bypass missing records', async () => {
    const urls = Array.from({ length: 13 }, (_, i) => image(i));
    const [first, second] = steps(urls, [{ type: 1, components: [{ type: 2, custom_id: 'delete', label: 'Delete' }] }]);
    const { storage, db, rows } = memory();
    const result = await cards.prepare(first, original, { providerId: 'twitter', presentationSettings: { button_invisible: { tg: true } } }, storage, [second]);
    const record = result.grids[0], customId = result.step.components[0].components[0].custom_id;
    assert.equal(customId, `delete:sl1:${record.id}`); assert.equal(cards.locatorIdFromAction(customId), record.id);
    let actions = 0;
    const interaction = { ...original, customId, message: { id: '555555555555555555', components: [], embeds: [], attachments: [] } };
    const missing = { withDatabaseTransaction: async fn => fn(async () => []) };
    await assert.rejects(cards.withMessageLock(interaction, async () => { actions++; }, missing, { action: 'delete' }), /GRID_LOCK_UNAVAILABLE/);
    assert.equal(actions, 0);
    assert.equal(await cards.bind(record, sent(interaction.message.id), storage, db, first.twitterGrid), true);
    assert.equal(rows.get(record.id).persistent, true);
});
test('video-only split posts receive a headless physical-message record', async () => {
    const { storage, db } = memory();
    const first = { files: ['https://video.twimg.com/ext_tw_video/1/video.mp4'],
        twitterGrid: { imageUrls: [], sequence: 0, totalParts: 2 } };
    const second = { files: ['https://video.twimg.com/ext_tw_video/2/video.mp4'],
        twitterGrid: { imageUrls: [], sequence: 1, totalParts: 2 } };
    const result = await cards.prepare(first, original, { providerId: 'twitter', presentationSettings: {} }, storage, [second]);
    assert.equal(result.step, first); assert.equal(result.grids[0].headless, true);
    const record = result.grids[0];
    assert.equal(await cards.bind(record, sent('555555555555555555'), storage, db, { ...first.twitterGrid, containsNonImage: true }), true);
    assert.deepEqual(await cards.finish(record, db), { state: 'pending' });
    assert.equal(await cards.append(record, { ...second.twitterGrid, containsNonImage: true }, sent('666666666666666666'), db), true);
    assert.deepEqual(await cards.finish(record, db), { state: 'complete' });
    assert.deepEqual(record.partSizes, [0, 0]); assert.deepEqual(record.partContainsNonImage, [true, true]);
    assert.deepEqual(record.messageIds, ['555555555555555555', '666666666666666666']);
});
test('video-only parts cannot be recorded out of physical order', async () => {
    const { storage, db } = memory();
    const first = { files: ['https://video.twimg.com/ext_tw_video/1/video.mp4'], twitterGrid: { imageUrls: [], sequence: 0, totalParts: 3 } };
    const second = { files: ['https://video.twimg.com/ext_tw_video/2/video.mp4'], twitterGrid: { imageUrls: [], sequence: 1, totalParts: 3 } };
    const third = { files: ['https://video.twimg.com/ext_tw_video/3/video.mp4'], twitterGrid: { imageUrls: [], sequence: 2, totalParts: 3 } };
    const { grids: [record] } = await cards.prepare(first, original, { providerId: 'twitter', presentationSettings: {} }, storage, [second, third]);
    assert.equal(await cards.bind(record, sent('555555555555555555'), storage, db, first.twitterGrid), true);
    assert.equal(await cards.append(record, third.twitterGrid, sent('777777777777777777'), db), false);
    assert.deepEqual(await cards.finish(record, db), { state: 'pending' });
    assert.equal(await cards.append(record, second.twitterGrid, sent('666666666666666666'), db), true);
    assert.equal(await cards.append(record, third.twitterGrid, sent('777777777777777777'), db), true);
    assert.deepEqual(await cards.finish(record, db), { state: 'complete' });
});
test('a full component budget still records a split; single posts do not create hidden records', async () => {
    const urls = Array.from({ length: 13 }, (_, i) => image(i)), rows = Array.from({ length: 5 }, () => ({ type: 1, components: [] }));
    const [first, second] = steps(urls, rows), { storage } = memory();
    const result = await cards.prepare(first, original, { providerId: 'twitter', presentationSettings: {} }, storage, [second]);
    assert.equal(result.grids[0].headless, true); assert.equal(result.step.components, rows);
    const only = { ...first, twitterGrid: { ...first.twitterGrid, totalParts: 1 } };
    assert.equal((await cards.prepare(only, original, { providerId: 'twitter', presentationSettings: { button_invisible: { tg: true } } }, storage)).grids, undefined);
});
test('saved source attachments bind to confirmed Discord attachments while the combine control stays hidden', async () => {
    const source = 'https://twidata.sprink.cloud/data/1234567890123456/123/data.json';
    const urls = Array.from({ length: 13 }, (_, i) => `https://twidata.sprink.cloud/data/1234567890123456/123/media-${i}-photo.jpg`);
    const [first, second] = steps(urls), { storage, db } = memory();
    const result = await cards.prepare(first, original, { providerId: 'twitter', url: source, presentationSettings: {} }, storage, [second]);
    assert.equal(result.grids[0].headless, true); assert.equal(result.step, first);
    const attachment = (url, i) => ({ id: String(i + 1), name: url.split('/').at(-1), contentType: 'image/jpeg', url: `https://cdn.discordapp.com/attachments/1/${i + 1}/photo.jpg` });
    const [record] = result.grids;
    assert.equal(await cards.bind(record, sent('555555555555555555', first.files.map(attachment)), storage, db, first.twitterGrid), true);
    assert.equal(await cards.append(record, second.twitterGrid, sent('666666666666666666', second.files.map((url, i) => attachment(url, i + 10))), db), true);
    assert.deepEqual(await cards.finish(record, db), { state: 'complete' });
    assert.ok(record.partRefs.flat().every(ref => ref.type === 'attachment' && ref.initialUrl.startsWith('https://cdn.discordapp.com/')));
});
test('saved attachment references reject mismatched IDs and non-Discord URLs', () => {
    const refs = [{ type: 'attachment', name: 'photo.jpg' }];
    for (const url of [
        'https://cdn.discordapp.com/attachments/1/999/photo.jpg',
        'https://pbs.twimg.com/media/photo.jpg',
    ]) {
        const message = sent('555555555555555555', [{ id: '2', name: 'photo.jpg', contentType: 'image/jpeg', url }]);
        assert.throws(() => cards.resolveReferences(refs, message));
    }
});
test('incomplete references and changed parts do not expose a control or a complete group', async () => {
    const urls = Array.from({ length: 13 }, (_, i) => image(i)), [first, second] = steps(urls), { storage, db } = memory();
    const settings = { providerId: 'twitter', presentationSettings: { button_invisible: { tg: true } } };
    assert.equal((await cards.prepare(first, original, settings, storage, [])).grids, undefined);
    const [record] = (await cards.prepare(first, original, settings, storage, [second])).grids;
    assert.equal(await cards.bind(record, sent('555555555555555555'), storage, db, first.twitterGrid), true);
    assert.equal(await cards.append(record, { ...second.twitterGrid, imageUrls: [image(99)] }, sent('666666666666666666'), db), false);
    assert.deepEqual(await cards.finish(record, db), { state: 'pending' });
    assert.equal(await cards.markIncomplete(record, 'failed', db), true);
    assert.equal(record.partsState, 'failed');
});
test('a failed database compare-and-swap never marks a multipart record complete', async () => {
    const urls = Array.from({ length: 13 }, (_, i) => image(i)), [first, second] = steps(urls), { storage } = memory();
    const settings = { providerId: 'twitter', presentationSettings: { button_invisible: { tg: true } } };
    const [record] = (await cards.prepare(first, original, settings, storage, [second])).grids;
    const conflictDb = { queryDatabase: async () => ({ affectedRows: 0 }) };
    assert.equal(await cards.bind(record, sent('555555555555555555'), storage, conflictDb, first.twitterGrid), false);
    assert.equal(record.completedParts, 0);
    assert.equal(record.partsState, 'pending');
});
test('a storage outage preserves the original send payload and does not add a control', async () => {
    const gallery = require('../../src/mediaGallery'), originalReport = gallery.report;
    const [first, second] = steps(Array.from({ length: 13 }, (_, i) => image(i)));
    const settings = { providerId: 'twitter', presentationSettings: { button_invisible: { all: true } } };
    gallery.report = () => {};
    try {
        const result = await cards.prepare(first, original, settings, { save: async () => { throw new Error('database unavailable'); } }, [second]);
        assert.equal(result.step, first); assert.equal(result.grids, undefined);
        assert.equal(result.step.components.length, 0); assert.equal(result.step.files.length, 10);
    } finally { gallery.report = originalReport; }
});
test('a split sent without durable metadata hides unsafe partial-action controls', async () => {
    const urls = Array.from({ length: 13 }, (_, i) => image(i));
    const [first, second] = steps(urls, [{ type: 1, components: [
        { type: 2, custom_id: 'delete' }, { type: 2, custom_id: 'translate' },
        { type: 2, custom_id: 'showAttachmentsAsEmbedsImage' }, { type: 2, custom_id: 'savetweet' },
    ] }]);
    const storage = { save: async () => { throw Error('fixture outage'); } };
    const output = await cards.prepare(first, original, { providerId: 'twitter', presentationSettings: {} }, storage, [second]);
    assert.deepEqual(output.step.files, first.files);
    assert.deepEqual(output.step.components.flatMap(row => row.components.map(button => button.custom_id)), ['savetweet']);
    assert.equal(output.grids, undefined);
});
test('a headless record retains non-image markers for safe later action checks', async () => {
    const urls = Array.from({ length: 13 }, (_, i) => image(i)), [first, second] = steps(urls), { storage, db } = memory();
    const settings = { providerId: 'twitter', presentationSettings: { button_invisible: { tg: true } } };
    const [record] = (await cards.prepare(first, original, settings, storage, [second])).grids;
    assert.equal(await cards.bind(record, sent('555555555555555555'), storage, db, { ...first.twitterGrid, containsNonImage: true }), true);
    assert.equal(await cards.append(record, { ...second.twitterGrid, containsNonImage: false }, sent('666666666666666666'), db), true);
    assert.deepEqual(await cards.finish(record, db), { state: 'complete' });
    assert.deepEqual(record.partContainsNonImage, [true, false]);
});
test('untrusted, ambiguous and spoiler saved attachments are not recorded', async () => {
    const source = 'https://twidata.sprink.cloud/data/1234567890123456/123/data.json';
    const safe = Array.from({ length: 13 }, (_, i) => `https://twidata.sprink.cloud/data/1234567890123456/123/media-${i}-photo.jpg`);
    for (const urls of [
        safe.map((v, i) => i === 12 ? 'https://unsafe.example/photo.jpg' : v),
        safe.map((v, i) => i === 12 ? safe[11] : v),
    ]) {
        const [first, second] = steps(urls), { storage } = memory();
        assert.equal((await cards.prepare(first, original, { providerId: 'twitter', url: source, presentationSettings: {} }, storage, [second])).grids, undefined);
    }
    const [first, second] = steps(safe), { storage } = memory();
    first.files[0] = { attachment: safe[0], name: 'SPOILER_photo.jpg' };
    assert.equal((await cards.prepare(first, original, { providerId: 'twitter', url: source, presentationSettings: {} }, storage, [second])).grids, undefined);
});
