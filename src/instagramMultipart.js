'use strict';

const { randomBytes } = require('node:crypto');
const gallery = require('./mediaGallery');
const cards = require('./twitterGridCards');
const { isExpected } = require('./discordMessageIdentity');

function rewriteDelete(step, id) {
    let found = 0;
    const components = (step.components || []).map(row => {
        const plain = row?.toJSON ? row.toJSON() : { ...row };
        return { ...plain, components: (plain.components || []).flatMap(button => {
            const value = button?.toJSON ? button.toJSON() : { ...button };
            const customId = value.custom_id || value.customId;
            if (customId !== 'delete:instagram') return [value];
            found++;
            if (!id) return [];
            delete value.customId;
            return [{ ...value, custom_id: `delete:ig1:${id}` }];
        }) };
    }).filter(row => row.components.length);
    return { step: { ...step, components }, found };
}

async function prepare(step, message, context, storage = gallery.store()) {
    if (context.providerId !== 'instagram' || !Number.isInteger(step.instagramGalleryParts) || step.instagramGalleryParts < 2
        || step.instagramGalleryParts > 20 || !(message.guildId || message.guild?.id)) return { step };
    const original = rewriteDelete(step, null);
    if (!original.found) return { step };
    const requesterId = String(message.author?.id || message.user?.id || '');
    if (original.found !== 1 || !/^\d{16,22}$/.test(requesterId)) return { step: original.step, unavailable: true };
    const id = randomBytes(16).toString('hex');
    const payload = { id, kind: 'instagram-multipart-v1', requesterId, expectedParts: step.instagramGalleryParts,
        messageIds: [], partSignatures: [], partsState: 'pending' };
    try {
        await storage.save(payload, message, 'instagram');
        return { step: rewriteDelete(step, id).step, group: payload };
    } catch (error) {
        gallery.report(error);
        return { step: original.step, unavailable: true };
    }
}

function validReceipt(step, sent, scope) {
    const attachments = sent?.attachments;
    const files = Array.isArray(attachments) ? attachments : typeof attachments?.values === 'function' ? [...attachments.values()] : null;
    return isExpected(sent, scope, null) && Array.isArray(step?.files) && step.files.length > 0 && step.files.length <= 10
        && Array.isArray(files) && files.length === step.files.length
        && files.every(file => /^\d{1,25}$/.test(String(file?.id || '')))
        && new Set(files.map(file => String(file.id))).size === files.length;
}

// Translations may change only the first embed's description. All attachment
// identities, other embed fields, message content and buttons must match.
function rootSignature(message) {
    const embeds = (message?.embeds || []).map(cards.cleanEmbed);
    if (embeds[0]) delete embeds[0].description;
    return cards.fingerprint({ channelId: message?.channelId, content: message?.content,
        attachments: message?.attachments, components: message?.components, embeds });
}

async function record(group, step, sent, scope, storage = gallery.store(), db = require('./db')) {
    if (!group || group.kind !== 'instagram-multipart-v1' || group.partsState !== 'pending' || !validReceipt(step, sent, scope)
        || group.messageIds.includes(sent.id) || group.messageIds.length >= group.expectedParts
        || group.messageIds.length > 0 && (sent.content || sent.embeds?.length || sent.components?.length)) return false;
    if (!group.messageIds.length) await storage.bind(group.id, sent.id, true);
    const ids = [...group.messageIds, sent.id], next = { ...group, messageIds: ids,
        ...(!group.messageIds.length ? { rootSignature: rootSignature(sent) } : {}),
        partSignatures: [...group.partSignatures, cards.fingerprint(sent)], partsState: ids.length === group.expectedParts ? 'complete' : 'pending' };
    const result = await db.queryDatabase('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
        [JSON.stringify(next), group.id, ids[0], JSON.stringify(group)]);
    if (Number(result?.affectedRows) !== 1) return false;
    Object.assign(group, next); return true;
}

async function remove(interaction, dependencies = {}) {
    const match = /^delete:ig1:([a-f0-9]{32})$/.exec(interaction.customId || '');
    if (!match || !interaction.guildId || !interaction.channelId || !interaction.message?.id) throw new Error('GRID_LOCK_UNAVAILABLE');
    const id = match[1], db = dependencies.db || require('./db');
    const grid = dependencies.grid || require('./components/twitterGrid')._internal;
    const getSettings = dependencies.getSettings || require('./providers/_provider_settings').getFreshProviderSettings;
    const provider = require('./providers/instagram');
    const deadline = Date.now() + 90000;
    const checkTime = () => { if (Date.now() >= deadline) throw new Error('GRID_OPERATION_TIME'); };
    await db.withDatabaseTransaction(async query => {
        const rows = await query('SELECT message_id,payload_json,provider_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [id, interaction.guildId, interaction.channelId, Date.now()]);
        if (rows.length !== 1 || rows[0].provider_id !== 'instagram' || String(rows[0].message_id) !== String(interaction.message.id)) throw new Error('GRID_LOCK_UNAVAILABLE');
        let payload; try { payload = JSON.parse(rows[0].payload_json); } catch { throw new Error('GRID_LOCK_UNAVAILABLE'); }
        if (payload.kind !== 'instagram-multipart-v1' || payload.id !== id || payload.partsState !== 'complete'
            || !/^\d{16,22}$/.test(payload.requesterId || '') || !Number.isInteger(payload.expectedParts)
            || payload.expectedParts < 2 || payload.expectedParts > 20 || !Array.isArray(payload.messageIds)
            || payload.messageIds.length !== payload.expectedParts || payload.messageIds[0] !== String(interaction.message.id)
            || payload.messageIds.some(value => !/^\d{1,25}$/.test(String(value))) || new Set(payload.messageIds).size !== payload.messageIds.length
            || !Array.isArray(payload.partSignatures) || payload.partSignatures.length !== payload.expectedParts
            || payload.partSignatures.some(value => !/^[a-f0-9]{64}$/.test(value || '')) || !/^[a-f0-9]{64}$/.test(payload.rootSignature || ''))
            throw new Error('GRID_SOURCE_INCOMPLETE');
        const authorize = async () => {
            checkTime();
            const access = await (dependencies.freshAccess || grid.freshAccess)(interaction);
            const settings = await getSettings(provider, interaction.guildId);
            if (!access || !settings || !grid.currentButtonAccess(interaction, settings, access.member)
                || payload.requesterId !== interaction.user.id && !access.permissions?.has?.('ManageMessages')) throw new Error('GRID_PERMISSION_CHANGED');
            return access.channel || interaction.channel;
        };
        const currentRoot = async channel => {
            const root = await channel.messages.fetch({ message: payload.messageIds[0], force: true });
            if (!isExpected(root, interaction, payload.messageIds[0]) || rootSignature(root) !== payload.rootSignature)
                throw new Error('GRID_SOURCE_CHANGED');
            return root;
        };
        for (let index = payload.messageIds.length - 1; index >= 1; index--) {
            const channel = await authorize();
            await currentRoot(channel);
            let part;
            try { part = await channel.messages.fetch({ message: payload.messageIds[index], force: true }); }
            catch (error) { if (Number(error?.code) === 10008) continue; throw error; }
            if (!isExpected(part, interaction, payload.messageIds[index]) || !cards.matchesFingerprint(part, payload.partSignatures[index]))
                throw new Error('GRID_SOURCE_CHANGED');
            const finalChannel = await authorize();
            await currentRoot(finalChannel);
            const verified = await finalChannel.messages.fetch({ message: payload.messageIds[index], force: true });
            if (!isExpected(verified, interaction, payload.messageIds[index]) || !cards.matchesFingerprint(verified, payload.partSignatures[index]))
                throw new Error('GRID_SOURCE_CHANGED');
            try { await verified.delete(); }
            catch (error) {
                try { await finalChannel.messages.fetch({ message: payload.messageIds[index], force: true }); }
                catch (check) { if (Number(check?.code) === 10008) continue; }
                throw error;
            }
        }
        const channel = await authorize(), root = await currentRoot(channel);
        checkTime();
        try { await root.delete(); }
        catch (error) {
            try { await channel.messages.fetch({ message: payload.messageIds[0], force: true }); }
            catch (check) { if (Number(check?.code) === 10008) { await query('UPDATE bot_media_galleries SET expires_at_ms=? WHERE gallery_id=? AND message_id=?',
                [Date.now() + gallery.RETENTION_MS, id, payload.messageIds[0]]); return; } }
            throw error;
        }
        await query('UPDATE bot_media_galleries SET expires_at_ms=? WHERE gallery_id=? AND message_id=?',
            [Date.now() + gallery.RETENTION_MS, id, payload.messageIds[0]]);
    });
    await interaction.editReply({ content: require('./locales').t('finishActionLocales', interaction.locale), ephemeral: true });
}

module.exports = { prepare, record, remove, _internal: { rewriteDelete, validReceipt, rootSignature } };
