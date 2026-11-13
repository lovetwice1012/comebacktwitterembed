'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../../src/twitterGridCards');
const grid = require('../../src/components/twitterGrid');
const id = 'a'.repeat(32), user = '111111111111111111', bot = '222222222222222222', guildId = '333333333333333333', channelId = '444444444444444444';
const image = n => `https://pbs.twimg.com/media/photo${n}?format=jpg`;
const settings = { enabled: true, defaultLanguage: 'ja', button_disabled: { user: [], role: [], channel: [] }, twitter_grid_replace_permission: 'restricted' };
const files = (n, start = 0) => new Map(Array.from({ length: n }, (_, i) => [String(i + start), { id: String(i + start), name: `photo${i + start}.jpg`, contentType: 'image/jpeg' }]));
function fixture(totalParts = 2, effectiveSettings = settings) {
    const first = { id: '555555555555555555', author: { id: bot }, content: '', embeds: [{ title: '投稿本文', description: '本文', url: 'https://x.com/example/status/1' }], components: [], attachments: files(10) };
    const second = { id: '666666666666666666', author: { id: bot }, content: '', embeds: [], components: [], attachments: files(3, 10) };
    const payload = { id, lockId: id, kind: 'twitter-image-grid-v1', imageUrls: Array.from({ length: totalParts === 2 ? 13 : 10 }, (_, i) => image(i)),
        totalParts, completedParts: totalParts, messageIds: totalParts === 2 ? [first.id, second.id] : [first.id], partSizes: totalParts === 2 ? [10, 3] : [10],
        partSignatures: totalParts === 2 ? [cards.fingerprint(first), cards.fingerprint(second)] : [cards.fingerprint(first)], firstStaticSignature: cards.fingerprint(first, true), requesterId: user,
        settingsHash: cards.safetyHash(effectiveSettings), nsfw: false, nsfwContextVersion: 1 };
    let data = JSON.stringify(payload), deleted = false, deleteCalls = 0, editCalls = 0, failDelete = false, uncertainDelete = false, uncertainEdit = false;
    const editPayloads = [];
    first.edit = async obj => { editCalls++; editPayloads.push(obj); first.embeds = obj.embeds; const kept = [...first.attachments].filter(([, file]) => obj.attachments.some(item => item.id === file.id)); first.attachments = new Map([...kept, ['grid', { id: '999999999999999999', name: obj.files[0].name, contentType: obj.files[0].name.endsWith('.png') ? 'image/png' : 'image/jpeg' }]]); if (uncertainEdit) { uncertainEdit = false; throw Error('timeout'); } return first; };
    second.delete = async () => { deleteCalls++; if (failDelete) { failDelete = false; throw Error('temporary'); } deleted = true; if (uncertainDelete) { uncertainDelete = false; throw Error('timeout'); } };
    const row = () => ({ gallery_id: id, provider_id: 'twitter', message_id: first.id, payload: JSON.parse(data), payload_json: data });
    let lock = Promise.resolve();
    const db = { withDatabaseTransaction: async fn => {
        let unlock; const previous = lock; lock = new Promise(r => { unlock = r; }); await previous;
        try { return await fn(async (sql, values) => {
            if (/^SELECT/.test(sql)) return [row()];
            if (/^UPDATE/.test(sql)) { data = values[0]; return { affectedRows: 1 }; }
            throw Error(sql);
        }); } finally { unlock(); }
    } };
    const calls = [];
    const interaction = { customId: `tg:${id}:0:open`, guildId, channelId, locale: 'ja', user: { id: user }, client: { user: { id: bot } },
        memberPermissions: { has: () => true }, message: { ...first, flags: { has: () => false } },
        channel: { nsfw: false, messages: { fetch: async ({ message }) => { if (message === first.id) return first; if (message === second.id && !deleted) return second; throw { code: 10008 }; } } },
        deferReply: async p => { calls.push(['deferReply', p]); interaction.deferred = true; }, deferUpdate: async () => { calls.push(['deferUpdate']); interaction.deferred = true; },
        editReply: async p => { calls.push(['editReply', p]); }, reply: async p => { calls.push(['reply', p]); }, showModal: async m => calls.push(['showModal', m]),
    };
    const deps = { storage: { get: async (i, g, c) => i === id && g === guildId && c === channelId ? row() : null }, getSettings: async () => effectiveSettings,
        isAllowed: async () => true, freshAccess: async () => ({ has: () => true }), compose: async () => ({ data: Buffer.from('image'), filename: 'twitter-grid.jpg', adapted: false }), db };
    return { interaction, deps, row, first, second, calls, editPayloads, patchPayload: patch => { data = JSON.stringify({ ...JSON.parse(data), ...patch }); }, get data() { return JSON.parse(data); }, get deleted() { return deleted; }, get deleteCalls() { return deleteCalls; }, get editCalls() { return editCalls; }, failNextDelete: () => { failDelete = true; }, failNextDeleteAfterSuccess: () => { uncertainDelete = true; }, failNextEditAfterSuccess: () => { uncertainEdit = true; } };
}
test('public button opens only a private editor with customizable defaults', async () => {
    const f = fixture(); await grid.handle(f.interaction, f.deps);
    assert.deepEqual(f.calls[0], ['deferReply', { ephemeral: true }]);
    const view = f.calls.at(-1)[1]; assert.equal(view.components.length, 5); assert.equal(view.files, undefined);
    const layout = view.components[0].components[0]; assert.equal(layout.options.length, 20);
    assert.ok(layout.custom_id.includes(`:${user}:layout:`));
});
test('automatic sizing uses one target size while cropped cells retain width and height', async () => {
    for (const [fit, expectedValue, expectedLabel] of [['i', '640', /画像サイズの目安/], ['c', '640x384', /枠の幅×高さ/]]) {
        const f = fixture(), state = { ...grid._internal.defaults(settings, 13), width: 640, height: 384, fit };
        f.interaction.customId = grid._internal.custom(id, user, 'advanced', state);
        f.interaction.message.flags.has = n => n === 64;
        await grid.handle(f.interaction, f.deps);
        const modal = f.calls.find(call => call[0] === 'showModal')[1].toJSON();
        const size = modal.components.map(row => row.components[0]).find(component => component.custom_id === 'size');
        assert.equal(size.value, expectedValue); assert.match(size.label, expectedLabel);
        const view = grid._internal.view(id, user, state, settings, 'ja');
        assert.match(view.content, fit === 'i' ? /サイズの目安 640px/ : /サイズの目安 640×384px/);
        assert.match(view.components[1].components[0].options[0].label, /自動調整/);
    }
});
test('new and existing sizing dialogs keep the encoded state compatible', () => {
    const old = { ...grid._internal.defaults(settings, 13), width: 512, height: 768, fit: 'i' };
    const submit = (size, state = old) => grid._internal.modalState({ fields: { getTextInputValue: key => ({ size, columns: '2', gap: '0', background: '#123456', quality: '85' })[key] } }, state);
    assert.deepEqual([submit('640').width, submit('640').height], [640, 768]);
    assert.deepEqual([submit('640x320').width, submit('640x320').height], [640, 320]);
    const cover = { ...old, fit: 'c' };
    assert.equal(submit('640', cover), null);
    assert.deepEqual([submit('640×320', cover).width, submit('640×320', cover).height], [640, 320]);
    assert.equal(submit('2049'), null); assert.equal(submit('0'), null);
    assert.deepEqual(grid._internal.decode(grid._internal.encode(old)), old);
});
test('private preview combines only persisted media and rechecks access', async () => {
    const f = fixture(); const state = grid._internal.defaults(settings, 13);
    f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
    let actual; f.deps.compose = async (urls, options) => { actual = { urls, options }; return { data: Buffer.from('preview'), filename: 'twitter-grid.jpg' }; };
    await grid.handle(f.interaction, f.deps);
    assert.equal(actual.urls.length, 13); assert.equal(actual.options.columns, 2);
    assert.equal(f.calls.at(-1)[1].files[0].name, 'twitter-grid.jpg');
    f.calls.length = 0; f.deps.freshAccess = async () => null; await grid.handle(f.interaction, f.deps);
    assert.deepEqual(f.calls.at(-1)[1].components, []); assert.deepEqual(f.calls.at(-1)[1].attachments, []);
});
test('private image errors display fixed actionable reasons without exposing exception content', async () => {
    const cases = [
        ['IMAGE_GRID_INPUT_SIZE', /元の画像が大きすぎ/], ['IMAGE_GRID_OUTPUT_SIZE', /画像のサイズを小さく/],
        ['IMAGE_GRID_FORMAT', /対応する形式/], ['IMAGE_GRID_BUSY', /混み合っています/],
        ['IMAGE_GRID_TIMEOUT', /時間がかかりました/], ['IMAGE_GRID_DOWNLOAD', /画像を取得できません/], ['IMAGE_GRID_LAYOUT', /縦横比/],
        ['IMAGE_GRID_URL', /画像のリンクを確認できません/], ['IMAGE_GRID_UNAVAILABLE', /現在利用できません/],
        ['UNTRUSTED_CODE', /画像をまとめられませんでした/],
    ];
    for (const [code, message] of cases) {
        const f = fixture(), state = grid._internal.defaults(settings, 13);
        f.interaction.customId = grid._internal.custom(id, user, 'preview', state);
        f.interaction.message.flags.has = n => n === 64;
        f.deps.compose = async () => { throw Object.assign(new Error('secret-token https://private.example/'), { code }); };
        await grid.handle(f.interaction, f.deps);
        const content = f.calls.at(-1)[1].content;
        assert.match(content, message, code); assert.doesNotMatch(content, /secret-token|private\.example/);
    }
    assert.equal(grid._internal.gridErrorText({ get code() { throw Error('secret'); } }, 'ja'),
        '画像をまとめられませんでした。時間をおいて再試行してください。');
    assert.match(grid._internal.gridErrorText({ code: 'IMAGE_GRID_TIMEOUT' }, 'en-US'), /timed out/);
});
test('private previews stop if any delivered part changes or disappears during composition', async () => {
    for (const scenario of ['delete', 'change']) {
        const f = fixture(), state = grid._internal.defaults(settings, 13);
        f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
        f.deps.compose = async () => { if (scenario === 'delete') await f.second.delete(); else f.second.attachments.clear(); return { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }; };
        await grid.handle(f.interaction, f.deps);
        assert.deepEqual(f.calls.at(-1)[1].attachments, []); assert.equal(f.calls.at(-1)[1].files, undefined);
    }
});
test('no preview or replacement is generated while any photo part is unconfirmed', async () => {
    const f = fixture(), state = grid._internal.defaults(settings, 10); let attempts = 0;
    f.patchPayload({ imageUrls: Array.from({ length: 10 }, (_, i) => image(i)), completedParts: 1, partsState: 'pending', pendingAtMs: Date.now(),
        messageIds: [f.first.id], partSignatures: [cards.fingerprint(f.first)], partSizes: [10] });
    f.deps.compose = async () => { attempts++; return { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }; };
    f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
    await grid.handle(f.interaction, f.deps);
    assert.equal(attempts, 0); assert.match(f.calls.at(-1)[1].content, /すべての画像/); assert.equal(f.calls.at(-1)[1].files, undefined);
    state.target = 'r'; f.interaction.customId = grid._internal.custom(id, user, 'run', state);
    await grid.handle(f.interaction, f.deps); assert.equal(attempts, 0); assert.match(f.calls.at(-1)[1].content, /すべての画像/);
});
test('incomplete delivery distinguishes rejection, uncertain Discord result, record failure and stale pending', () => {
    const at = 1900000000000, base = { completedParts: 1, totalParts: 2 };
    const display = state => grid._internal.partsProgress({ ...base, ...state }, 'ja', at);
    assert.match(display({ partsState: 'pending', pendingAtMs: at - 1000 }), /すべての画像を確認/);
    assert.match(display({ partsState: 'failed' }), /送信できませんでした/);
    assert.match(display({ partsState: 'delivery_unknown' }), /送信結果を確認できません/);
    assert.match(display({ partsState: 'record_unknown' }), /登録状況を確認できません/);
    for (const state of [{ partsState: 'pending', pendingAtMs: at - 301000 }, { partsState: 'pending', pendingAtMs: null }, {}]) {
        assert.match(display(state), /送信状況を確認できません/);
        assert.doesNotMatch(display(state), /送信できませんでした/);
    }
    assert.equal(grid._internal.partsProgress({ completedParts: 2, totalParts: 2 }, 'ja', at), null);
});
test('a single delivered photo still reports a known continuation failure', async () => {
    const f = fixture(), state = grid._internal.defaults(settings, 1);
    f.patchPayload({ imageUrls: [image(0)], completedParts: 1, partsState: 'failed', pendingAtMs: Date.now(),
        messageIds: [f.first.id], partSignatures: [cards.fingerprint(f.first)], partSizes: [1] });
    f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
    let composed = 0; f.deps.compose = async () => { composed++; return { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }; };
    await grid.handle(f.interaction, f.deps);
    assert.equal(composed, 0); assert.match(f.calls.at(-1)[1].content, /送信できませんでした/); assert.equal(f.calls.at(-1)[1].files, undefined);
});

test('a video-only first part presents a pending state without exposing unconfirmed photos', async () => {
    const f = fixture();
    f.patchPayload({ imageUrls: [], completedParts: 1, totalParts: 2, partsState: 'pending', pendingAtMs: Date.now(),
        messageIds: [f.first.id], partSizes: [0], partSignatures: [cards.fingerprint(f.first)] });
    await grid.handle(f.interaction, f.deps);
    const view = f.calls.at(-1)[1];
    assert.match(view.content, /すべての画像を確認/);
    assert.equal(view.files, undefined);
});
test('zero or one confirmed photo reports the exact incomplete state for every output action', async () => {
    const states = [
        ['pending', /すべての画像を確認/],
        ['failed', /送信できませんでした/],
        ['delivery_unknown', /送信結果を確認できません/],
        ['record_unknown', /登録状況を確認できません/],
    ];
    for (const count of [0, 1]) for (const [partsState, expected] of states) for (const action of ['open', 'preview', 'run', 'confirm']) {
        const f = fixture();
        f.patchPayload({ imageUrls: count ? [image(0)] : [], completedParts: 1, totalParts: 2, partsState, pendingAtMs: Date.now(),
            messageIds: [f.first.id], partSizes: [count], partSignatures: [cards.fingerprint(f.first)] });
        if (action !== 'open') {
            f.interaction.customId = grid._internal.custom(id, user, action, grid._internal.defaults(settings, 1, true));
            f.interaction.message.flags.has = n => n === 64;
        }
        let composed = 0;
        f.deps.compose = async () => { composed++; throw Error('incomplete images must not be fetched'); };
        await grid.handle(f.interaction, f.deps);
        const result = f.calls.at(-1)[1];
        assert.match(result.content, expected, `${count}/${partsState}/${action}`);
        assert.equal(result.files, undefined); assert.equal(composed, 0);
    }
});
test('a role added during composition blocks both private output and public replacement', async () => {
    const restricted = { ...settings, button_disabled: { user: [], channel: [], role: ['888888888888888888'] } };
    const f = fixture(2, restricted), state = grid._internal.defaults(restricted, 13);
    f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
    let checks = 0;
    f.deps.freshAccess = async () => ({ permissions: { has: () => true }, member: { roles: checks++ ? ['888888888888888888'] : [] } });
    await grid.handle(f.interaction, f.deps); assert.deepEqual(f.calls.at(-1)[1].components, []); assert.equal(f.calls.at(-1)[1].files, undefined);
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }, f.deps), 'denied');
    assert.equal(f.editCalls, 0); assert.equal(f.deleteCalls, 0);
});
test('role restrictions fail closed for incomplete role data and accept only complete safe membership', () => {
    const f = fixture(), policy = { button_disabled: { role: ['888888888888888888'] } };
    assert.equal(grid._internal.currentButtonAccess(f.interaction, policy, { roles: {} }), false);
    assert.equal(grid._internal.currentButtonAccess(f.interaction, policy, { roles: [] }), true);
    assert.equal(grid._internal.currentButtonAccess(f.interaction, policy, { roles: { cache: new Map([['888888888888888888', {}]]) } }), false);
    assert.equal(grid._internal.currentButtonAccess(f.interaction, policy, { _roles: ['888888888888888888'], roles: { cache: new Map() } }), false);
});
test('private thread membership is fetched again and removal during composition denies output', async () => {
    const f = fixture(), state = grid._internal.defaults(settings, 13); let inThread = true;
    f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
    f.interaction.guild = { id: guildId, roles: { fetch: async () => new Map([[guildId, {}]]) }, members: { fetch: async () => ({ _roles: [], roles: [] }) } };
    f.interaction.channel.isThread = () => true; f.interaction.channel.type = 12;
    f.interaction.channel.id = channelId; f.interaction.channel.guildId = guildId; f.interaction.channel.parentId = '999999999999999999';
    const parent = { id: f.interaction.channel.parentId, guildId, permissionsFor: () => ({ has: permission => Array.isArray(permission) }) };
    f.interaction.client.guilds = { fetch: async opts => { assert.equal(opts.force, true); return f.interaction.guild; } };
    f.interaction.client.channels = { fetch: async (channel, opts) => { assert.equal(opts.force, true); return channel === channelId ? f.interaction.channel : parent; } };
    f.interaction.channel.members = { fetch: async opts => { assert.equal(opts.force, true); if (!inThread) throw { code: 10007 }; return { id: user }; } };
    f.deps.freshAccess = grid._internal.freshAccess;
    f.deps.compose = async () => { inThread = false; return { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }; };
    await grid.handle(f.interaction, f.deps);
    assert.deepEqual(f.calls.at(-1)[1].components, []); assert.equal(f.calls.at(-1)[1].files, undefined);
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }, f.deps), 'denied');
    assert.equal(f.editCalls, 0); assert.equal(f.deleteCalls, 0);
});
test('current channel overwrites and NSFW state are refetched after composition', async () => {
    const f = fixture(), state = grid._internal.defaults(settings, 13); let allowed = true;
    f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
    const guild = { id: guildId, roles: { fetch: async () => new Map([[guildId, {}]]) }, members: { fetch: async () => ({ _roles: [], roles: [] }) } };
    const channel = { ...f.interaction.channel, id: channelId, guildId, permissionsFor: () => ({ has: p => Array.isArray(p) && allowed }) };
    f.interaction.client.guilds = { fetch: async () => guild };
    f.interaction.client.channels = { fetch: async (_, opts) => { assert.equal(opts.force, true); return channel; } };
    f.deps.freshAccess = grid._internal.freshAccess;
    f.deps.compose = async () => { allowed = false; return { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }; };
    await grid.handle(f.interaction, f.deps); assert.equal(f.calls.at(-1)[1].files, undefined);
    assert.deepEqual(f.calls.at(-1)[1].components, []);
});
test('current NSFW channel state is rechecked and incomplete role lists fail closed', async () => {
    const f = fixture(), state = grid._internal.defaults(settings, 13); f.patchPayload({ nsfw: true });
    f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.interaction.message.flags.has = n => n === 64;
    const guild = { id: guildId, roles: { fetch: async () => new Map([[guildId, {}]]) }, members: { fetch: async () => ({ _roles: [], roles: [] }) } };
    const channel = { ...f.interaction.channel, nsfw: true, id: channelId, guildId, permissionsFor: () => ({ has: p => Array.isArray(p) }) };
    f.interaction.client.guilds = { fetch: async () => guild }; f.interaction.client.channels = { fetch: async () => channel };
    f.deps.freshAccess = grid._internal.freshAccess;
    f.deps.compose = async () => { channel.nsfw = false; return { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }; };
    await grid.handle(f.interaction, f.deps); assert.equal(f.calls.at(-1)[1].files, undefined);
    guild.members.fetch = async () => ({ _roles: ['888888888888888888'], roles: { cache: new Map() } });
    assert.equal(await grid._internal.freshAccess(f.interaction), null);
});
test('another user, disabled provider and missing original cannot use the private editor', async () => {
    const f = fixture(); const state = grid._internal.defaults(settings, 13); f.interaction.message.flags.has = n => n === 64;
    f.interaction.customId = grid._internal.custom(id, '777777777777777777', 'preview', state); await grid.handle(f.interaction, f.deps); assert.equal(f.calls[0][0], 'reply');
    f.calls.length = 0; f.interaction.customId = grid._internal.custom(id, user, 'preview', state); f.deps.getSettings = async () => ({ ...settings, enabled: false });
    await grid.handle(f.interaction, f.deps); assert.deepEqual(f.calls.at(-1)[1].components, []);
});
test('public replacement checks current permission and leaves a changed second message untouched', async () => {
    const f = fixture(); const row = f.row(), composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
    f.interaction.user.id = '777777777777777777'; f.deps.freshAccess = async () => ({ has: () => false });
    assert.equal(await grid._internal.replacePublic(f.interaction, row, composed, f.deps), 'denied'); assert.equal(f.editCalls, 0);
    f.interaction.user.id = user; f.deps.freshAccess = async () => ({ has: () => true }); f.second.content = '変更済み';
    assert.equal(await grid._internal.replacePublic(f.interaction, row, composed, f.deps), 'changed'); assert.equal(f.deleteCalls, 0); assert.equal(f.editCalls, 0);
});
test('public replacement never deletes a continuation containing video or unexpected attachments', () => {
    const f = fixture(); const expected = cards.fingerprint(f.second);
    f.second.attachments.get('10').contentType = 'video/mp4';
    assert.equal(grid._internal.safeContinuation(f.second, expected, 3), false);
    f.second.attachments.get('10').contentType = 'image/jpeg';
    assert.equal(grid._internal.safeContinuation(f.second, expected, 2), false);
    assert.equal(grid._internal.safeContinuation(f.second, expected, 3), true);
});
test('recorded non-image media in any part prevents public replacement', async () => {
    const f = fixture(); f.patchPayload({ partContainsNonImage: [false, true] });
    const result = await grid._internal.replacePublic(f.interaction, f.row(), { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' }, f.deps);
    assert.equal(result, 'changed'); assert.equal(f.editCalls, 0); assert.equal(f.deleteCalls, 0);
});
test('replacement permission is requester or manager unless the server opts in to everyone', () => {
    const f = fixture(); f.interaction.user.id = '777777777777777777';
    const nonManager = { has: p => p === 'ManageMessages' }, manager = { has: p => p === 'Administrator' };
    assert.equal(grid._internal.mayReplace(f.interaction, f.row().payload, settings, nonManager), false);
    assert.equal(grid._internal.mayReplace(f.interaction, f.row().payload, settings, manager), true);
    assert.equal(grid._internal.mayReplace(f.interaction, f.row().payload, { ...settings, twitter_grid_replace_permission: 'everyone' }, nonManager), true);
});
test('public replacement keeps continuation on failure and safely finishes on retry', async () => {
    const f = fixture(); const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' }; f.failNextDelete();
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'partial');
    assert.equal(f.deleted, false); assert.equal(f.data.replacePhase, 'partial'); assert.equal(f.first.embeds[0].description, '本文');
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done');
    assert.equal(f.deleted, true); assert.equal(f.deleteCalls, 2); assert.equal(f.data.replacePhase, 'done');
    assert.equal(await grid._internal.sourcesRemainValid(f.interaction, f.row()), true);
});
test('retry after partial completion applies the newly selected composite after preserving all images', async () => {
    const f = fixture(); f.failNextDelete();
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), { data: Buffer.from('old layout'), filename: 'twitter-grid.jpg' }, f.deps), 'partial');
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), { data: Buffer.from('new layout'), filename: 'twitter-grid.png' }, f.deps), 'done');
    assert.deepEqual(f.editPayloads.map(item => item.files[0].attachment.toString()), ['old layout', 'new layout']);
    assert.match(f.editPayloads.at(-1).files[0].name, /\.png$/);
    assert.equal(f.deleted, true);
});
test('a removed or changed combined first message prevents any continuation deletion', async () => {
    for (const scenario of ['removed', 'content_changed', 'marker_removed']) {
        const f = fixture(), originalEdit = f.first.edit, originalFetch = f.interaction.channel.messages.fetch;
        let changed = false;
        f.first.edit = async payload => {
            const result = await originalEdit(payload); changed = true;
            if (scenario === 'content_changed') f.first.content = 'another update';
            if (scenario === 'marker_removed') f.first.attachments.clear();
            return result;
        };
        f.interaction.channel.messages.fetch = async request => {
            if (changed && scenario === 'removed' && request.message === f.first.id) throw { code: 10008 };
            return originalFetch(request);
        };
        const result = await grid._internal.replacePublic(f.interaction, f.row(), { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' }, f.deps);
        assert.equal(result, 'partial', scenario);
        assert.equal(f.deleteCalls, 0, scenario);
        assert.equal(f.data.replacePhase, 'partial', scenario);
    }
});

test('a first message removed between later deletions stops and preserves the remaining continuation', async () => {
    const f = fixture(), thirdId = '777777777777777777';
    const third = { id: thirdId, author: { id: bot }, content: '', embeds: [], components: [], attachments: files(3, 13) };
    let thirdDeleted = false, firstRemoved = false;
    third.delete = async () => { thirdDeleted = true; };
    const originalFetch = f.interaction.channel.messages.fetch;
    f.interaction.channel.messages.fetch = async request => {
        if (firstRemoved && request.message === f.first.id) throw { code: 10008 };
        if (request.message === thirdId && !thirdDeleted) return third;
        return originalFetch(request);
    };
    f.patchPayload({ imageUrls: Array.from({ length: 16 }, (_, i) => image(i)), totalParts: 3, completedParts: 3,
        messageIds: [f.first.id, f.second.id, thirdId], partSizes: [10, 3, 3],
        partSignatures: [cards.fingerprint(f.first), cards.fingerprint(f.second), cards.fingerprint(third)] });
    const deleteSecond = f.second.delete;
    f.second.delete = async () => { await deleteSecond(); firstRemoved = true; };
    const result = await grid._internal.replacePublic(f.interaction, f.row(), { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' }, f.deps);
    assert.equal(result, 'partial'); assert.equal(f.deleted, true); assert.equal(thirdDeleted, false);
});
test('multi-part replacement stops on permission loss and resumes without repeating the first edit', async () => {
    const f = fixture(), thirdId = '777777777777777777';
    const third = { id: thirdId, author: { id: bot }, content: '', embeds: [], components: [], attachments: files(3, 13) };
    let thirdDeleted = false;
    third.delete = async () => { thirdDeleted = true; };
    const originalFetch = f.interaction.channel.messages.fetch;
    f.interaction.channel.messages.fetch = async request => {
        if (request.message === thirdId && !thirdDeleted) return third;
        return originalFetch(request);
    };
    f.patchPayload({ imageUrls: Array.from({ length: 16 }, (_, i) => image(i)), totalParts: 3, completedParts: 3,
        messageIds: [f.first.id, f.second.id, thirdId], partSizes: [10, 3, 3],
        partSignatures: [cards.fingerprint(f.first), cards.fingerprint(f.second), cards.fingerprint(third)] });
    const deleteSecond = f.second.delete;
    f.second.delete = async () => { await deleteSecond(); f.deps.freshAccess = async () => null; };
    const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'partial');
    assert.equal(f.deleted, true); assert.equal(thirdDeleted, false); assert.equal(f.editCalls, 1);
    f.deps.freshAccess = async () => ({ has: () => true });
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done');
    assert.equal(thirdDeleted, true); assert.equal(f.editCalls, 2);
});
test('a lost acknowledgement deleting the third part is checked, not submitted twice', async () => {
    const f = fixture(), thirdId = '777777777777777777';
    const third = { id: thirdId, author: { id: bot }, content: '', embeds: [], components: [], attachments: files(3, 13) };
    let thirdDeleted = false, thirdAttempts = 0;
    third.delete = async () => { thirdAttempts++; thirdDeleted = true; throw Error('unknown acknowledgement'); };
    const originalFetch = f.interaction.channel.messages.fetch;
    f.interaction.channel.messages.fetch = async request => {
        if (request.message === thirdId) {
            if (thirdDeleted) throw { code: 10008 };
            return third;
        }
        return originalFetch(request);
    };
    f.patchPayload({ imageUrls: Array.from({ length: 16 }, (_, i) => image(i)), totalParts: 3, completedParts: 3,
        messageIds: [f.first.id, f.second.id, thirdId], partSizes: [10, 3, 3],
        partSignatures: [cards.fingerprint(f.first), cards.fingerprint(f.second), cards.fingerprint(third)] });
    const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'partial');
    assert.equal(thirdDeleted, true); assert.equal(thirdAttempts, 1); assert.equal(f.editCalls, 1);
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done');
    assert.equal(thirdAttempts, 1); assert.equal(f.editCalls, 2);
});
test('uncertain first edit never deletes the continuation and deterministic marker allows recovery', async () => {
    const f = fixture(); const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' }; f.failNextEditAfterSuccess();
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'unknown'); assert.equal(f.deleteCalls, 0);
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done'); assert.equal(f.deleted, true);
});
test('lost delete acknowledgement recovers through the normal interaction source check', async () => {
    const f = fixture(), composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' }; f.failNextDeleteAfterSuccess();
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'partial');
    assert.equal(f.deleted, true); assert.equal(await grid._internal.sourcesRemainValid(f.interaction, f.row()), true);
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done'); assert.equal(f.deleteCalls, 1);
});
test('replacing an already-combined message never removes any newly added unrelated attachment', async () => {
    const f = fixture(1), composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done');
    f.first.attachments.set('extra', { id: 'extra', name: 'unrelated.png', contentType: 'image/png' });
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'changed'); assert.equal(f.editCalls, 1);
});
test('a valid unrelated attachment added after replacement is explicitly retained on retry', async () => {
    const f = fixture(1), composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done');
    f.first.attachments.set('other', { id: '888888888888888888', name: 'unrelated.png', contentType: 'image/png' });
    assert.equal(await grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), 'done');
    assert.ok([...f.first.attachments.values()].some(file => file.id === '888888888888888888'));
});
test('concurrent replacements serialize and cannot delete the continuation twice', async () => {
    const f = fixture(); const composed = { data: Buffer.from('grid'), filename: 'twitter-grid.jpg' };
    const result = await Promise.all([grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps), grid._internal.replacePublic(f.interaction, f.row(), composed, f.deps)]);
    assert.deepEqual(result, ['done', 'done']); assert.equal(f.deleteCalls, 1);
});
test('grid state is bounded and all component IDs fit Discord limits', () => {
    const s = { columns: 20, width: 2048, height: 2048, gap: 64, background: 'ffffff', fit: 'c', format: 'w', quality: 95, target: 'p' };
    assert.deepEqual(grid._internal.decode(grid._internal.encode(s)), s);
    for (const action of ['advanced', 'confirm', 'preview', 'format']) assert.ok(grid._internal.custom(id, '1'.repeat(22), action, s).length <= 100);
    assert.equal(grid._internal.decode('21.2048.2048.64.ffffff.c.j.95'), null);
});
test('visibility dropdown reflects server defaults and hides public replacement from unauthorized users', async () => {
    const f = fixture(); f.interaction.user.id = '777777777777777777'; f.interaction.memberPermissions.has = key => Array.isArray(key);
    f.deps.freshAccess = async () => ({ permissions: { has: key => Array.isArray(key) }, member: { roles: [] } });
    f.deps.getSettings = async () => ({ ...settings, twitter_grid_default_visibility: 'replace', twitter_grid_default_layout: 'horizontal' });
    await grid.handle(f.interaction, f.deps);
    const view = f.calls.at(-1)[1], visibility = view.components[3].components[0];
    assert.deepEqual(visibility.options.map(x => x.value), ['p']); assert.equal(visibility.options[0].default, true);
    assert.equal(view.components[0].components[0].options[12].default, true);
    assert.match(view.content, /投稿者・管理者/);
});
test('horizontal default uses all expected images while the manifest is still pending', async () => {
    const f = fixture(), options = { ...settings, twitter_grid_default_layout: 'horizontal' };
    f.deps.getSettings = async () => options;
    f.patchPayload({ imageUrls: Array.from({ length: 5 }, (_, i) => image(i)), expectedImageUrls: Array.from({ length: 20 }, (_, i) => image(i)),
        completedParts: 1, totalParts: 2, partsState: 'pending', pendingAtMs: Date.now(), messageIds: [f.first.id], partSizes: [5], partSignatures: [cards.fingerprint(f.first)] });
    await grid.handle(f.interaction, f.deps);
    const layout = f.calls.at(-1)[1].components[0].components[0];
    assert.equal(layout.options.find(option => option.value === '20').default, true); assert.equal(f.calls.at(-1)[1].files, undefined);
});
test('grid card persists each inline quote separately and never creates a button for one photo', async () => {
    const saved = []; const storage = { save: async value => saved.push(value) };
    const meta = n => ({ sequence: 0, totalParts: 1, imageUrls: Array.from({ length: n }, (_, i) => image(i)) });
    const result = await cards.prepare({ components: [], twitterGrid: meta(1), twitterGridInline: [meta(2), meta(3)] }, { guildId, channelId, author: { id: user } }, { providerId: 'twitter', presentationSettings: settings }, storage);
    assert.equal(saved.length, 2); assert.deepEqual(saved.map(x => x.expectedImageUrls.length), [2,3]); assert.equal(result.step.components[0].components.length, 2);
});
test('a video-only first physical part stays pending until all expected photographs are confirmed', async () => {
    const initial = { imageUrls: [], sequence: 0, totalParts: 2 }, next = { imageUrls: [image(0), image(1)], sequence: 1, totalParts: 2 };
    const storage = { save: async () => {}, bind: async () => {} }, db = { queryDatabase: async () => ({ affectedRows: 1 }) };
    const prepared = await cards.prepare({ twitterGrid: initial, components: [] }, { guildId, channelId, author: { id: user } },
        { providerId: 'twitter', presentationSettings: settings }, storage, [{ twitterGrid: next }]);
    assert.equal(prepared.grids.length, 1);
    const item = prepared.grids[0];
    const first = { id: '555555555555555555', content: '', components: prepared.step.components, embeds: [{ title: '投稿' }], attachments: new Map() };
    assert.equal(await cards.bind(item, first, storage, db, { imageUrls: [], containsNonImage: true }), true);
    assert.deepEqual(await cards.finish(item, db), { state: 'pending' });
    assert.equal(item.partsState, 'pending'); assert.deepEqual(item.imageUrls, []);
    const second = { id: '666666666666666666', content: '', components: [], embeds: [], attachments: files(2) };
    assert.equal(await cards.append(item, { imageUrls: next.imageUrls, containsNonImage: false }, second, db), true);
    assert.deepEqual(await cards.finish(item, db), { state: 'complete' });
    assert.deepEqual(item.partContainsNonImage, [true, false]);
});
test('a pre-split three-message manifest retains every photo and rejects an invalid or duplicate ACK', async () => {
    const images = Array.from({ length: 20 }, (_, i) => image(i));
    const parts = [images.slice(0, 5), images.slice(5, 10), images.slice(10)].map((imageUrls, sequence) => ({ imageUrls, sequence, totalParts: 3 }));
    const storage = { save: async () => {}, bind: async () => {} }, db = { queryDatabase: async () => ({ affectedRows: 1 }) };
    const prepared = await cards.prepare({ twitterGrid: parts[0], components: [] }, { guildId, channelId, author: { id: user } },
        { providerId: 'twitter', presentationSettings: settings }, storage, [{ twitterGrid: parts[1] }, { twitterGrid: parts[2] }]);
    assert.equal(prepared.grids.length, 1);
    const item = prepared.grids[0], first = { id: '555555555555555555', content: '', embeds: [{ title: '投稿' }], components: prepared.step.components, attachments: files(5) };
    assert.deepEqual(item.expectedImageUrls, images);
    assert.equal(await cards.bind(item, first, storage, db, { imageUrls: parts[0].imageUrls, containsNonImage: false }), true);
    const second = { id: '666666666666666666', content: '', embeds: [], components: [], attachments: files(5, 5) };
    assert.equal(await cards.append(item, { imageUrls: parts[2].imageUrls, containsNonImage: false }, second, db), false, 'out-of-order photos must not be admitted');
    assert.equal(await cards.append(item, { imageUrls: parts[1].imageUrls, containsNonImage: false }, first, db), false, 'one Discord message cannot be recorded twice');
    assert.equal(await cards.append(item, { imageUrls: parts[1].imageUrls, containsNonImage: false }, second, db), true);
    assert.deepEqual(await cards.finish(item, db), { state: 'pending' });
    const third = { id: '777777777777777777', content: '', embeds: [], components: [], attachments: files(10, 10) };
    assert.equal(await cards.append(item, { imageUrls: parts[2].imageUrls, containsNonImage: false }, third, db), true);
    assert.deepEqual(await cards.finish(item, db), { state: 'complete' });
    assert.equal(item.totalParts, 3); assert.deepEqual(item.imageUrls, images);
});
test('inline quote replacement modifies only its verified embed range even when URLs overlap', () => {
    const first = { attachments: new Map(), embeds: [
        { title: '親', image: { url: image(1) } }, { url: 'https://x.com/parent', image: { url: image(2) } },
        { title: '引用', image: { url: image(1) } }, { url: 'https://x.com/quote', image: { url: image(3) } },
    ] };
    const payload = { id, sharedInline: true, imageUrls: [image(1), image(3)], embedStart: 2, embedEnd: 4 };
    const output = grid._internal.editPayload(first, payload, { data: Buffer.from('image'), filename: 'twitter-grid.jpg' });
    assert.equal(output.embeds[0].image.url, image(1)); assert.equal(output.embeds[1].image.url, image(2));
    assert.equal(output.embeds[2].title, '引用'); assert.match(output.embeds[2].image.url, /^attachment:\/\/tg-/);
    assert.equal(output.embeds.length, 3);
    const parent = { ...payload, imageUrls: [image(1), image(2)], embedStart: 0, embedEnd: 2 };
    const parentOutput = grid._internal.editPayload(first, parent, { data: Buffer.from('image'), filename: 'twitter-grid.jpg' });
    assert.equal(parentOutput.embeds.at(-2).image.url, image(1)); assert.equal(parentOutput.embeds.at(-1).image.url, image(3));
    first.attachments = files(1); assert.deepEqual(grid._internal.editPayload(first, payload, { data: Buffer.from('x'), filename: 'twitter-grid.jpg' }).attachments, [{ id: '0' }]);
});
test('primary attachment replacement retains inline quotes and quote replacement never deletes parent attachments', () => {
    const first = { attachments: files(2), embeds: [{ title: '親' }, { title: '引用', image: { url: image(1) } }, { image: { url: image(2) } }] };
    const parent = { id, sharedInline: true, imageUrls: [image(1), image(2)], partSizes: [2], embedStart: 0, embedEnd: 1 };
    const output = grid._internal.editPayload(first, parent, { data: Buffer.from('image'), filename: 'twitter-grid.jpg' });
    assert.equal(output.embeds[1].image.url, image(1)); assert.equal(output.embeds[2].image.url, image(2));
    const quote = { ...parent, embedStart: 1, embedEnd: 3 };
    assert.deepEqual(grid._internal.editPayload(first, quote, { data: Buffer.from('image'), filename: 'twitter-grid.jpg' }).attachments, [{ id: '0' }, { id: '1' }]);
});
