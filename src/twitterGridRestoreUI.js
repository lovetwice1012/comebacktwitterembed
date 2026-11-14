'use strict';

const restore = require('./twitterGridRestore');
const { randomBytes } = require('node:crypto');
const MODES = Object.freeze({ rh: 'here', rf: 'first', rr: 'rest', rn: 'new', rc: 'resume' });
const splitConfirmations = new Map(), SPLIT_TTL = 120000, SPLIT_LIMIT = 1000;

function offerSplitConfirmation({ id, owner, packedState, sizes, planDigest, mode = 'first' }, locale, now = Date.now()) {
    if (!/^[a-f0-9]{32}$/.test(id || '') || !/^\d{16,22}$/.test(owner || '') || !/^[0-9a-z.]{1,32}$/.test(packedState || '')
        || !/^[a-f0-9]{64}$/.test(planDigest || '') || !Array.isArray(sizes) || sizes.length < 2 || sizes.length > 10
        || !['first', 'resume'].includes(mode) || sizes.some(size => !Number.isInteger(size) || size < 1 || size > 10)
        || sizes.reduce((sum, size) => sum + size, 0) < 1 || sizes.reduce((sum, size) => sum + size, 0) > 20
        || mode === 'first' && sizes.reduce((sum, size) => sum + size, 0) !== 10)
        throw new Error('GRID_RESTORE_CONFIRM');
    for (const [token, record] of splitConfirmations) if (record.expiresAt <= now) splitConfirmations.delete(token);
    if (splitConfirmations.size >= SPLIT_LIMIT) throw new Error('GRID_RESTORE_BUSY');
    const token = randomBytes(12).toString('hex');
    splitConfirmations.set(token, { id, owner, packedState, planDigest, mode, sizes: [...sizes], expiresAt: now + SPLIT_TTL });
    const ja = String(locale || '').startsWith('ja');
    const total = sizes.reduce((sum, size) => sum + size, 0);
    return { content: ja ? `${mode === 'first' ? '最初の10枚' : `残りの${total}枚`}を ${sizes.join('枚・')}枚の${sizes.length}通に分けて戻します。`
        : `Restore ${mode === 'first' ? 'the first 10 images' : `the remaining ${total} images`} in ${sizes.length} messages (${sizes.join(' + ')}).`,
    components: [{ type: 1, components: [{ type: 2, style: 1, label: ja ? '分けて戻す' : 'Restore in parts',
        custom_id: `tg:${id}:${owner}:r1:${token}` }] }], allowedMentions: { parse: [] } };
}

function consumeSplitConfirmation(token, id, owner, now = Date.now()) {
    if (!/^[a-f0-9]{24}$/.test(token || '')) return null;
    const value = splitConfirmations.get(token);
    if (!value || value.id !== id || value.owner !== owner) return null;
    splitConfirmations.delete(token);
    return value.expiresAt > now ? value : null;
}

function parseSelection(customId, userId, ephemeral) {
    if (!ephemeral || !/^\d{16,22}$/.test(String(userId || '')) || typeof customId !== 'string' || customId.length > 100) return null;
    const match = /^tg:([a-f0-9]{32}):(\d{16,22}):(rh|rf|rr|rn|rc):([0-9a-z.]{1,32})$/.exec(customId);
    return match && match[2] === String(userId) ? { id: match[1], mode: MODES[match[3]], packedState: match[4] } : null;
}

async function restoreMenu(interaction, snapshot, packedState, adapters, separateOnly = false, rootCapacity = 10) {
    if (!snapshot || !snapshot.payload || !snapshot.first || snapshot.first.id !== snapshot.payload.messageIds?.[0]
        || typeof adapters?.authorize !== 'function' || typeof adapters?.latestMessageId !== 'function'
        || !await adapters.authorize(interaction, snapshot)) throw new Error('GRID_RESTORE_DENIED');
    if (!restore.statusFromCombined(snapshot.payload, snapshot.first)) throw new Error('GRID_RESTORE_SOURCE');
    const last = await adapters.latestMessageId(snapshot);
    if (!last) throw new Error('GRID_RESTORE_UNAVAILABLE');
    return restore.restoreView(snapshot.payload.id, String(interaction.user.id), packedState,
        snapshot.payload.imageUrls.length, String(last) === String(snapshot.first.id), interaction.locale, separateOnly, rootCapacity);
}

// Private-owner choice validation is repeated before invoking the operation;
// executeRestore then reacquires the shared lock and fresh authorization.
async function restoreSelection(interaction, adapters) {
    const selection = parseSelection(interaction.customId, interaction.user?.id, interaction.message?.flags?.has?.(64));
    if (!selection) return { status: 'denied' };
    return restore.executeRestore({ id: selection.id, owner: String(interaction.user.id), mode: selection.mode,
        locale: interaction.locale, interaction }, adapters);
}

module.exports = { parseSelection, restoreMenu, restoreSelection, offerSplitConfirmation, consumeSplitConfirmation };
