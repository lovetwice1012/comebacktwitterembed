'use strict';

// A private, one-use confirmation of the exact current message. The map never
// contains post content and a restart safely invalidates outstanding tokens.
const { randomBytes } = require('node:crypto');
const cards = require('../twitterGridCards');
const { isResponseButtonHidden } = require('../utils');
const twitterProvider = require('../providers/twitter');
const allowedActions = new Set(['showMediaAsAttachments', 'showAttachmentsAsEmbedsImage', 'translate', 'delete']);
const tokens = new Map();
const TTL = 2 * 60 * 1000, MAX_PENDING = 1000;

function buttonExists(message, customId) {
    return (message?.components || []).some(row => (row.components || []).some(component => {
        const id = component.customId || component.custom_id || component.data?.custom_id;
        return id === customId && !(component.disabled ?? component.data?.disabled);
    }));
}
function activeRecord(row, id, sourceId) {
    const p = row?.payload;
    return !!p && row.provider_id === 'twitter' && String(row.message_id || '') === sourceId && p.id === id
        && p.kind === 'twitter-image-grid-v1' && /^[a-f0-9]{32}$/.test(p.lockId || '')
        && (!p.partsState || p.partsState === 'complete') && (!p.replacePhase || p.replacePhase === 'done')
        && Number.isInteger(p.totalParts) && p.totalParts >= 1 && p.totalParts <= 20 && p.completedParts === p.totalParts
        && Array.isArray(p.messageIds) && p.messageIds.length === p.totalParts && p.messageIds[0] === sourceId
        && new Set(p.messageIds).size === p.messageIds.length;
}
async function fresh(interaction, record, deps) {
    const grid = require('./twitterGrid')._internal;
    const access = await (deps.freshAccess || grid.freshAccess)(interaction);
    if (!access?.channel || !access?.member || !access?.permissions) return null;
    const settings = await (deps.getSettings || require('../providers/_provider_settings').getFreshProviderSettings)(twitterProvider, interaction.guildId);
    if (!settings || settings.enabled !== true || !grid.currentButtonAccess(interaction, settings, access.member)
        || isResponseButtonHidden(settings.button_invisible || {}, record.actionId)) return null;
    return { access, settings };
}
async function getSource(interaction, record, access, deps) {
    const storage = deps.storage || require('../mediaGallery').store();
    const row = await storage.get(record.galleryId, interaction.guildId, interaction.channelId);
    if (!activeRecord(row, record.galleryId, record.messageId)) return null;
    let message;
    try { message = await access.channel.messages.fetch({ message: record.messageId, force: true }); } catch { return null; }
    if (!message || String(message.id) !== record.messageId || message.author?.id !== interaction.client?.user?.id
        || message.channelId && String(message.channelId) !== String(interaction.channelId)
        || message.guildId && String(message.guildId) !== String(interaction.guildId)
        || (cards.gridIdFromMessage(message) !== record.galleryId && row.payload.headless !== true)
        || !buttonExists(message, record.actionId)) return null;
    return { message, row };
}
async function groupSnapshot(source, row, channel, client) {
    const payload = row.payload, parts = [];
    const combined = payload.replacePhase === 'done' && cards.attachmentList(source).some(file =>
        new RegExp(`^tg-${payload.id}\\.(jpg|png|webp)$`).test(file.name || '') && /^image\/(jpeg|png|webp)$/i.test(file.contentType || ''));
    for (let index = 0; index < payload.messageIds.length; index++) {
        const id = String(payload.messageIds[index]); let message = source;
        if (index) {
            try { message = await channel.messages.fetch({ message: id, force: true }); }
            catch (error) { if (combined && Number(error?.code) === 10008) { parts.push({ id, fingerprint: null }); continue; } return null; }
        }
        if (!message || String(message.id) !== id || message.author?.id !== client?.user?.id
            || message.channelId && String(message.channelId) !== String(channel.id)
            || message.guildId && String(message.guildId) !== String(channel.guildId)) return null;
        parts.push({ id, fingerprint: cards.fingerprint(message) });
    }
    return parts;
}
function preview(message, locale, record) {
    const embeds = (message.embeds || []).map(cards.cleanEmbed), ja = String(locale || '').startsWith('ja');
    const excerpt = [message.content, ...embeds.flatMap(embed => [embed.title, embed.description])].filter(value => typeof value === 'string' && value.trim()).join('\n').slice(0, 1400);
    const link = `https://discord.com/channels/${record.guildId}/${record.channelId}/${record.messageId}`;
    return { content: ja ? '現在の投稿を確認してください。リンクから画像や続きも確認できます。' : 'Review the current post. The link includes its images and continuation.',
        embeds: [{ description: excerpt || (ja ? '画像・添付ファイル' : 'Images or attachments'), url: link, title: ja ? '投稿を開く' : 'Open post' }],
        allowedMentions: { parse: [], repliedUser: false } };
}
function prune(now) { for (const [key, value] of tokens) if (value.expiresAt <= now) tokens.delete(key); }
async function offer(interaction, deps = {}) {
    // Never copy a post into a public response, even if a future caller uses
    // this module without the usual ephemeral defer in the event handler.
    if (interaction.deferred !== true || interaction.ephemeral !== true) throw new Error('GRID_SOURCE_CHANGED');
    const galleryId = deps.galleryId || cards.gridIdFromMessage(interaction.message), actionId = interaction.customId;
    if (!galleryId || typeof actionId !== 'string' || !allowedActions.has(actionId.split(':')[0])) throw new Error('GRID_SOURCE_CHANGED');
    const record = { galleryId, actionId, messageId: String(interaction.message?.id || ''),
        guildId: String(interaction.guildId || ''), channelId: String(interaction.channelId || ''), userId: String(interaction.user?.id || '') };
    if (!record.messageId || !record.guildId || !record.channelId || !record.userId) throw new Error('GRID_SOURCE_CHANGED');
    const valid = await fresh(interaction, record, deps);
    if (!valid) throw new Error('GRID_SOURCE_CHANGED');
    const fetched = await getSource(interaction, record, valid.access, deps);
    if (!fetched) throw new Error('GRID_SOURCE_CHANGED');
    const parts = await groupSnapshot(fetched.message, fetched.row, valid.access.channel, interaction.client);
    if (!parts) throw new Error('GRID_SOURCE_CHANGED');
    record.parts = parts; record.fingerprint = parts[0].fingerprint;
    const now = (deps.now || Date.now)(); prune(now);
    if (tokens.size >= MAX_PENDING) throw new Error('GRID_SOURCE_CHANGED');
    const token = randomBytes(16).toString('hex'); record.expiresAt = now + TTL; tokens.set(token, record);
    const ja = String(interaction.locale || '').startsWith('ja');
    const view = preview(fetched.message, interaction.locale, record);
    const labels = {
        delete: ja ? 'この投稿を削除' : 'Delete this post',
        translate: ja ? 'この投稿を翻訳' : 'Translate this post',
        showMediaAsAttachments: ja ? '画像を添付で表示' : 'Show attachments',
        showAttachmentsAsEmbedsImage: ja ? '画像を埋め込みで表示' : 'Show embedded images',
    };
    view.components = [{ type: 1, components: [{ type: 2, style: actionId.split(':')[0] === 'delete' ? 4 : 1,
        label: labels[actionId.split(':')[0]],
        custom_id: `gcf:${token}` }] }];
    try { await interaction.editReply(view); } catch (error) { tokens.delete(token); throw error; }
}
async function confirm(interaction, deps = {}) {
    const match = /^gcf:([a-f0-9]{32})$/.exec(interaction.customId || '');
    const now = (deps.now || Date.now)(); prune(now);
    const record = match && tokens.get(match[1]);
    if (!record || record.userId !== String(interaction.user?.id || '') || record.guildId !== String(interaction.guildId || '')
        || record.channelId !== String(interaction.channelId || '') || record.expiresAt <= now) throw new Error('GRID_SOURCE_CHANGED');
    // Do not consume another user's token, but make a valid confirmation one-use.
    tokens.delete(match[1]);
    await interaction.deferReply({ ephemeral: true });
    if (interaction.deferred !== true || interaction.ephemeral !== true) throw new Error('GRID_SOURCE_CHANGED');
    const valid = await fresh(interaction, record, deps);
    if (!valid) throw new Error('GRID_SOURCE_CHANGED');
    const fetched = await getSource(interaction, record, valid.access, deps);
    if (!fetched) throw new Error('GRID_SOURCE_CHANGED');
    const parts = await groupSnapshot(fetched.message, fetched.row, valid.access.channel, interaction.client);
    if (!parts || JSON.stringify(parts) !== JSON.stringify(record.parts)) throw new Error('GRID_SOURCE_CHANGED');
    const action = record.actionId.split(':')[0], handler = (deps.handlers || {})[action];
    if (!allowedActions.has(action) || !handler) throw new Error('GRID_SOURCE_CHANGED');
    interaction.message = fetched.message; interaction.member = valid.access.member; interaction.memberPermissions = valid.access.permissions;
    const buildButtons = deps.buildButtons || require('./_buttons').buildButtons;
    const confirmation = { expectedFingerprint: record.fingerprint, actionId: record.actionId, galleryId: record.galleryId,
        channel: valid.access.channel, action, buttons: buildButtons(interaction), freshAccess: deps.freshAccess, getSettings: deps.getSettings,
        expiresAt: record.expiresAt, now: deps.now || Date.now };
    confirmation.revalidate = async () => {
        if ((deps.now || Date.now)() >= record.expiresAt) throw new Error('GRID_SOURCE_CHANGED');
        const latest = await fresh(interaction, record, deps);
        if (!latest) throw new Error('GRID_SOURCE_CHANGED');
        const group = await getSource(interaction, record, latest.access, deps);
        if (!group || JSON.stringify(await groupSnapshot(group.message, group.row, latest.access.channel, interaction.client)) !== JSON.stringify(record.parts))
            throw new Error('GRID_SOURCE_CHANGED');
        confirmation.channel = latest.access.channel;
        interaction.member = latest.access.member; interaction.memberPermissions = latest.access.permissions;
    };
    await cards.withMessageLock(interaction, group => handler.handle(interaction, { client: interaction.client, buttons: confirmation.buttons, ...group }), deps.db, confirmation);
}
module.exports = { offer, confirm, _internal: { activeRecord, buttonExists, preview, tokens, TTL } };
