'use strict';

const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType } = require('discord.js');
const gallery = require('../mediaGallery');
const cards = require('../twitterGridCards');
const { getFreshProviderSettings } = require('../providers/_provider_settings');
const { isAllowed } = require('./_permissionCheck');
const { isNsfwChannel } = require('../providers/_sensitive_controls');

const clamp = (value, min, max, fallback) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
const GRID_ERROR_TEXT = Object.freeze({
    IMAGE_GRID_INPUT_SIZE: ['元の画像が大きすぎるため、まとめられませんでした。', 'An original image is too large to combine.'],
    IMAGE_GRID_OUTPUT_SIZE: ['画像のサイズを小さくして、もう一度お試しください。', 'Choose a smaller image size and try again.'],
    IMAGE_GRID_FORMAT: ['対応する形式か、画像が壊れていないか確認してください。', 'Check the image format and whether the file is intact.'],
    IMAGE_GRID_BUSY: ['画像をまとめる処理が混み合っています。少し待ってからお試しください。', 'Image processing is busy. Please try again shortly.'],
    IMAGE_GRID_TIMEOUT: ['画像の処理に時間がかかりました。もう一度お試しください。', 'Image processing timed out. Please try again.'],
    IMAGE_GRID_DOWNLOAD: ['画像を取得できませんでした。元の投稿をご確認ください。', 'Could not retrieve the images. Check the original post.'],
    IMAGE_GRID_URL: ['画像のリンクを確認できませんでした。元の投稿をご確認ください。', 'Could not verify the image links. Check the original post.'],
    IMAGE_GRID_OPTIONS: ['画像の配置や設定を確認してください。', 'Check the image layout and settings.'],
    IMAGE_GRID_COUNT: ['画像の枚数を確認してください。', 'Check the number of images.'],
    IMAGE_GRID_UNAVAILABLE: ['画像をまとめる機能を現在利用できません。', 'Image combining is currently unavailable.'],
    IMAGE_GRID_PROCESS: ['画像をまとめられませんでした。時間をおいて再試行してください。', 'Could not combine the images. Try again later.'],
});
function gridErrorText(cause, locale) {
    const ja = String(locale || '').startsWith('ja');
    let code;
    try { code = cause?.code; } catch { code = undefined; }
    const text = typeof code === 'string' && Object.hasOwn(GRID_ERROR_TEXT, code)
        ? GRID_ERROR_TEXT[code] : GRID_ERROR_TEXT.IMAGE_GRID_PROCESS;
    return text[ja ? 0 : 1];
}
function defaults(settings, count, canReplace = false) {
    const layout = settings.twitter_grid_default_layout;
    return { columns: layout === 'horizontal' ? count : layout === 'vertical' ? 1 : clamp(settings.twitter_grid_columns, 1, 20, 2),
        width: clamp(settings.twitter_grid_cell_size, 128, 2048, 512), height: clamp(settings.twitter_grid_cell_size, 128, 2048, 512),
        gap: clamp(settings.twitter_grid_gap, 0, 64, 4), background: /^#[0-9a-f]{6}$/i.test(settings.twitter_grid_background || '') ? settings.twitter_grid_background.slice(1).toLowerCase() : 'ffffff',
        fit: settings.twitter_grid_fit === 'cover' ? 'c' : 'i', format: 'j', quality: clamp(settings.twitter_grid_quality, 30, 95, 85),
        target: settings.twitter_grid_default_visibility === 'replace' && canReplace ? 'r' : 'p' };
}
function encode(s) { return [s.columns, s.width, s.height, s.gap, s.background, s.fit, s.format, s.quality, s.target || 'p'].join('.'); }
function decode(value) {
    const parts = String(value || '').split('.');
    if (parts.length !== 9 || !/^\d{1,2}$/.test(parts[0]) || !/^\d{1,4}$/.test(parts[1]) || !/^\d{1,4}$/.test(parts[2])
        || !/^\d{1,2}$/.test(parts[3]) || !/^[0-9a-f]{6}$/.test(parts[4]) || !/^[ci]$/.test(parts[5]) || !/^[jpw]$/.test(parts[6]) || !/^\d{2}$/.test(parts[7]) || !/^[pr]$/.test(parts[8])) return null;
    const [columns,width,height,gap,background,fit,format,quality,target] = parts;
    const state = { columns: Number(columns), width: Number(width), height: Number(height), gap: Number(gap), background, fit, format, quality: Number(quality), target };
    return state.columns >= 1 && state.columns <= 20 && state.width >= 128 && state.width <= 2048 && state.height >= 128 && state.height <= 2048
        && state.gap <= 64 && state.quality >= 30 && state.quality <= 95 ? state : null;
}
function custom(id, owner, action, state) { return `tg:${id}:${owner}:${action}${state ? `:${encode(state)}` : ''}`; }
const PENDING_UNCERTAIN_AFTER_MS = 5 * 60 * 1000;
function partsProgress(payload, locale, now = Date.now()) {
    // New records do not know their physical message count until finish().
    // Older complete records have no explicit partsState and remain readable.
    if ((payload.partsState === 'complete' || payload.partsState === undefined)
        && payload.completedParts === payload.totalParts) return null;
    const ja = String(locale || '').startsWith('ja');
    if (payload.partsState === 'failed') return ja ? '一部の画像を送信できませんでした。元のリンクから再度展開してください。' : 'Some images could not be sent. Expand the original link again.';
    if (payload.partsState === 'record_unknown') return ja ? '画像の登録状況を確認できません。Discordの投稿を確認してください。' : 'The image record could not be confirmed. Check the Discord posts.';
    if (payload.partsState === 'delivery_unknown') return ja ? '画像の送信結果を確認できません。Discordの投稿を確認してください。' : 'The image delivery result is unknown. Check the Discord posts.';
    const started = Number(payload.pendingAtMs);
    if (payload.partsState === 'pending' && Number.isSafeInteger(started) && started > 0 && started <= now + 30000 && now - started < PENDING_UNCERTAIN_AFTER_MS)
        return ja ? 'すべての画像を確認しています。' : 'Checking all images.';
    // Missing or stale state may be a server restart or a DB failure. Never
    // describe it as a proven failure and never resend messages implicitly.
    return ja ? '画像の送信状況を確認できません。Discordの投稿を確認してください。' : 'The image delivery status could not be confirmed. Check the Discord posts.';
}
function view(id, owner, state, settings, locale, message, canReplace = false, incomplete = null) {
    const ja = String(locale || '').startsWith('ja');
    const menu = (action, placeholder, options) => ({ type: 1, components: [{ type: 3, custom_id: custom(id, owner, action, state), placeholder, options }] });
    const choice = (label, value, selected) => ({ label, value: String(value), default: selected });
    const rows = [
        menu('layout', ja ? '画像の並べ方' : 'Layout', Array.from({ length: 20 }, (_, i) => choice(i === 0 ? (ja ? '縦一列' : 'Single column') : i === 19 ? (ja ? '横一列' : 'Single row') : `${i + 1}${ja ? '列' : ' columns'}`, i + 1, state.columns === i + 1))),
        menu('fit', ja ? '画像の収め方' : 'Image fit', [choice(ja ? '全体を表示' : 'Fit whole image', 'i', state.fit === 'i'), choice(ja ? '枠いっぱいに切り抜く' : 'Fill and crop', 'c', state.fit === 'c')]),
        menu('format', ja ? '保存形式' : 'Output format', [choice('JPEG', 'j', state.format === 'j'), choice('PNG', 'p', state.format === 'p'), choice('WebP', 'w', state.format === 'w')]),
        menu('target', ja ? '表示先' : 'Visibility', [choice(ja ? '自分にだけ表示' : 'Only me', 'p', state.target === 'p'), ...(canReplace ? [choice(ja ? '公開画像を置換' : 'Replace public images', 'r', state.target === 'r')] : [])]),
        { type: 1, components: [
            { type: 2, style: 1, label: ja ? '画像をまとめる' : 'Combine images', custom_id: custom(id, owner, 'run', state) },
            { type: 2, style: 2, label: ja ? '詳細設定' : 'Fine settings', custom_id: custom(id, owner, 'advanced', state) },
        ] },
    ];
    const summary = ja ? `列数 ${state.columns} · ${state.width}×${state.height}px · 余白 ${state.gap}px · 背景 #${state.background} · 画質 ${state.quality}` : `Columns ${state.columns} · ${state.width}×${state.height}px · gap ${state.gap}px · background #${state.background} · quality ${state.quality}`;
    const restriction = canReplace ? '' : (ja ? '\n公開画像の置換は投稿者・管理者が利用できます。' : '\nPublic replacement is available to the requester or an administrator.');
    const partial = incomplete && incomplete !== message ? `\n${incomplete}` : '';
    return { content: (message || summary + restriction) + partial,
        components: rows, allowedMentions: { parse: [] } };
}
function modal(id, owner, state, locale) {
    const ja = String(locale || '').startsWith('ja');
    const input = (key, label, value) => /** @type {ActionRowBuilder<TextInputBuilder>} */ (new ActionRowBuilder()).addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setValue(String(value)).setRequired(true));
    return new ModalBuilder().setCustomId(custom(id, owner, 'submit', state)).setTitle(ja ? '画像の詳細設定' : 'Image settings').addComponents(
        input('columns', ja ? '列数（1〜20）' : 'Columns (1–20)', state.columns),
        input('size', ja ? '幅×高さ（128〜2048）' : 'Width x height (128–2048)', `${state.width}x${state.height}`),
        input('gap', ja ? '余白（0〜64px）' : 'Gap (0–64px)', state.gap),
        input('background', ja ? '背景色（#RRGGBB）' : 'Background (#RRGGBB)', `#${state.background}`),
        input('quality', ja ? '画質（30〜95）' : 'Quality (30–95)', state.quality));
}
function modalState(interaction, old) {
    const get = name => String(interaction.fields.getTextInputValue(name)).trim();
    const dims = /^(\d{1,4})\s*[x×]\s*(\d{1,4})$/i.exec(get('size'));
    const bg = /^#?([0-9a-f]{6})$/i.exec(get('background'));
    if (!dims || !bg || !/^\d{1,2}$/.test(get('columns')) || !/^\d{1,2}$/.test(get('gap')) || !/^\d{2}$/.test(get('quality'))) return null;
    return decode(encode({ ...old, columns: Number(get('columns')), width: Number(dims[1]), height: Number(dims[2]), gap: Number(get('gap')), background: bg[1].toLowerCase(), quality: Number(get('quality')) }));
}
function sourceId(row) { return String(row?.message_id || ''); }
function sourceIsOwn(message, client) { return message?.author?.id && message.author.id === client?.user?.id; }
function marker(id, name) { return `tg-${id}.${name.split('.').pop()}`; }
function hasMarker(message, id) { return cards.attachmentList(message).some(file => new RegExp(`^tg-${id}\\.(jpg|png|webp)$`).test(file.name || '')); }
function safeContinuation(message, signature, expectedCount) {
    const attachments = cards.attachmentList(message);
    return !message.content && !(message.embeds || []).length && !(message.components || []).length
        && Number.isInteger(expectedCount) && attachments.length === expectedCount && attachments.length > 0
        && attachments.every(file => String(file.contentType || '').startsWith('image/')) && cards.fingerprint(message) === signature;
}
async function sourcesRemainValid(interaction, row, access) {
    const payload = row.payload;
    const channel = access?.channel || interaction.channel;
    if (!Array.isArray(payload.messageIds) || payload.messageIds.length !== payload.completedParts
        || payload.messageIds[0] !== sourceId(row) || !Array.isArray(payload.partSignatures)
        || payload.partSignatures.length !== payload.completedParts) return false;
    let first;
    try { first = await channel.messages.fetch({ message: payload.messageIds[0], force: true }); }
    catch { return false; }
    if (!sourceIsOwn(first, interaction.client)) return false;
    const replaced = hasMarker(first, payload.id) && cards.fingerprint(first, true) === payload.firstStaticSignature;
    if (!replaced && cards.fingerprint(first) !== payload.partSignatures[0]) return false;
    for (let i = 1; i < payload.messageIds.length; i++) {
        let message;
        try { message = await channel.messages.fetch({ message: payload.messageIds[i], force: true }); }
        catch (error) {
            // A successful edit/delete may have been followed by a lost ACK or
            // a DB rollback. The unique Bot-authored marker proves that the
            // complete saved composite is already on the original message.
            if (replaced && Number(error?.code) === 10008) continue;
            return false;
        }
        if (!sourceIsOwn(message, interaction.client) || cards.fingerprint(message) !== payload.partSignatures[i]) return false;
    }
    return true;
}
async function sourceImageUrls(interaction, row, access) {
    if (!await sourcesRemainValid(interaction, row, access)) throw new Error('GRID_SOURCE_CHANGED');
    const payload = row.payload, channel = access?.channel || interaction.channel;
    if (payload.partsState && payload.partsState !== 'complete') throw new Error('GRID_SOURCE_INCOMPLETE');
    if (!Array.isArray(payload.partRefs)) return payload.imageUrls;
    if (payload.partRefs.length !== payload.totalParts || payload.completedParts !== payload.totalParts) throw new Error('GRID_SOURCE_INCOMPLETE');
    const first = await channel.messages.fetch({ message: payload.messageIds[0], force: true });
    const replaced = hasMarker(first, payload.id) && cards.fingerprint(first, true) === payload.firstStaticSignature;
    if (!sourceIsOwn(first, interaction.client) || !replaced && cards.fingerprint(first) !== payload.partSignatures[0]) throw new Error('GRID_SOURCE_CHANGED');
    const all = [];
    for (let i = 0; i < payload.partRefs.length; i++) {
        let message = first;
        if (i > 0) {
            try { message = await channel.messages.fetch({ message: payload.messageIds[i], force: true }); }
            catch (error) { if (!replaced || Number(error?.code) !== 10008) throw error; message = null; }
            if (message && (!sourceIsOwn(message, interaction.client) || cards.fingerprint(message) !== payload.partSignatures[i])) throw new Error('GRID_SOURCE_CHANGED');
        }
        all.push(...cards.resolveReferences(payload.partRefs[i], message, replaced));
    }
    if (all.length !== payload.imageUrls.length) throw new Error('GRID_SOURCE_CHANGED');
    return all;
}
function embedWitnessPosition(message, witness) {
    if (!witness || !Array.isArray(witness.hashes) || !witness.hashes.length || witness.hashes.length > 10
        || witness.hashes.some(value => !/^[a-f0-9]{64}$/.test(value)) || !Array.isArray(witness.attachments) || witness.attachments.length > 10) return null;
    const attachments = cards.attachmentList(message);
    if (new Set(witness.attachments.map(file => file.id)).size !== witness.attachments.length
        || witness.attachments.some(expected => !/^\d{1,25}$/.test(expected.id || '') || !attachments.some(file => String(file.id) === expected.id && file.name === expected.name && String(file.contentType || '').startsWith('image/')))) return null;
    const hashes = (message?.embeds || []).map(cards.embedFingerprint), matches = [];
    for (let i = 0; i + witness.hashes.length <= hashes.length; i++) {
        if (witness.hashes.every((value, offset) => hashes[i + offset] === value)) matches.push(i);
    }
    return matches.length === 1 ? { start: matches[0], end: matches[0] + witness.hashes.length } : null;
}
async function markerRows(query, interaction, payload, message) {
    const markerFiles = cards.attachmentList(message).filter(file => /^tg-[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(file.name || ''));
    if (markerFiles.some(file => !/^image\/(?:jpeg|png|webp)$/i.test(file.contentType || ''))) return null;
    const markerIds = markerFiles.map(file => /^tg-([a-f0-9]{32})\.(?:jpg|png|webp)$/.exec(file.name)[1]);
    if (!markerIds.length) return new Map();
    if (new Set(markerIds).size !== markerIds.length) return null;
    const rows = await query('SELECT gallery_id,message_id,payload_json FROM bot_media_galleries WHERE guild_id=? AND channel_id=? AND message_id=? AND provider_id=? AND expires_at_ms>? FOR UPDATE',
        [interaction.guildId, interaction.channelId, payload.messageIds[0], 'twitter', Date.now()]);
    const markers = new Map();
    for (const row of rows) {
        if (!markerIds.includes(row.gallery_id)) continue;
        let item; try { item = JSON.parse(row.payload_json); } catch { return null; }
        if (item.kind !== 'twitter-image-grid-v1' || item.id !== row.gallery_id || item.lockId !== payload.lockId
            || item.partsState && item.partsState !== 'complete' || item.completedParts !== item.totalParts
            || item.messageIds?.[0] !== payload.messageIds[0] || item.firstStaticSignature !== cards.fingerprint(message, true)) return null;
        markers.set(item.id, item);
    }
    return markers.size === markerIds.length ? markers : null;
}
async function reconcileSibling(interaction, row, deps = {}) {
    const db = deps.db || require('../db'), lockId = row.payload.lockId;
    if (!/^[a-f0-9]{32}$/.test(lockId || '') || !row.payload.sharedInline) return null;
    return db.withDatabaseTransaction(async query => {
        const roots = await query('SELECT message_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [lockId, interaction.guildId, interaction.channelId, Date.now()]);
        if (!roots[0] || String(roots[0].message_id) !== sourceId(row)) return null;
        const rows = await query('SELECT * FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [row.payload.id, interaction.guildId, interaction.channelId, Date.now()]);
        if (!rows[0]) return null;
        const payload = JSON.parse(rows[0].payload_json);
        if (payload.kind !== 'twitter-image-grid-v1' || payload.id !== row.payload.id || payload.lockId !== lockId || !payload.sharedInline
            || payload.partsState && payload.partsState !== 'complete' || payload.completedParts !== payload.totalParts
            || !Array.isArray(payload.messageIds) || payload.messageIds[0] !== String(rows[0].message_id)
            || !Array.isArray(payload.partSignatures) || payload.partSignatures.length !== payload.messageIds.length) return null;
        const settings = await (deps.getSettings || getFreshProviderSettings)({ id: 'twitter' }, interaction.guildId);
        const access = await (deps.freshAccess || freshAccess)(interaction);
        if (!access || settings.enabled !== true || cards.safetyHash(settings) !== payload.settingsHash || payload.nsfw && !currentNsfw(access, interaction)
            || !currentButtonAccess(interaction, settings, access.member)) return null;
        const channel = access.channel || interaction.channel;
        let first; try { first = await channel.messages.fetch({ message: payload.messageIds[0], force: true }); } catch { return null; }
        if (!sourceIsOwn(first, interaction.client) || cards.fingerprint(first, true) !== payload.firstStaticSignature) return null;
        const markers = await markerRows(query, interaction, payload, first);
        if (!markers || ![...markers.keys()].some(id => id !== payload.id)) return null;
        const position = embedWitnessPosition(first, payload.embedWitness);
        if (!position) return null;
        for (let i = 1; i < payload.messageIds.length; i++) {
            let other; try { other = await channel.messages.fetch({ message: payload.messageIds[i], force: true }); } catch { return null; }
            if (!sourceIsOwn(other, interaction.client) || cards.fingerprint(other) !== payload.partSignatures[i]) return null;
        }
        const next = { ...payload, embedStart: position.start, embedEnd: position.end,
            partSignatures: [cards.fingerprint(first), ...payload.partSignatures.slice(1)], firstStaticSignature: cards.fingerprint(first, true) };
        const result = await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=? AND message_id=? AND BINARY payload_json=BINARY ?',
            [JSON.stringify(next), payload.id, payload.messageIds[0], rows[0].payload_json]);
        return Number(result?.affectedRows) === 1 ? { ...row, payload: next } : null;
    });
}
function mayReplace(interaction, payload, settings, permissions = interaction.memberPermissions, ownerId) {
    return settings.twitter_grid_replace_permission === 'everyone' || payload.requesterId === interaction.user.id
        || ownerId === interaction.user.id || permissions?.has?.('Administrator') === true;
}
async function freshAccess(interaction) {
    try {
        const guild = await interaction.client.guilds.fetch({ guild: interaction.guildId, force: true });
        const channel = await interaction.client.channels.fetch(interaction.channelId, { force: true });
        if (!guild || guild.id !== interaction.guildId || !channel || channel.id !== interaction.channelId || channel.guildId !== interaction.guildId) return null;
        const member = await guild.members.fetch({ user: interaction.user.id, force: true });
        // GuildMember.roles.cache drops role IDs not yet in the guild cache.
        // Fetch the authoritative role list and verify every ID before using
        // it for channel permissions or prohibited-role checks.
        const roleList = await guild.roles.fetch();
        if (!roleList?.has?.(guild.id) || !Array.isArray(member?._roles)
            || member._roles.some(id => typeof id !== 'string' || !roleList.has(id))) return null;
        let parent = null;
        if (channel.isThread?.()) {
            parent = await interaction.client.channels.fetch(channel.parentId, { force: true });
            if (!parent || parent.id !== channel.parentId || parent.guildId !== interaction.guildId) return null;
        }
        const permissions = (parent || channel).permissionsFor(member);
        if (!permissions?.has?.(['ViewChannel', 'ReadMessageHistory'])) return null;
        if (channel.isThread?.()) {
            if (channel.type === ChannelType.PrivateThread) {
                if (!permissions.has('ManageThreads')) {
                    const threadMember = await channel.members.fetch({ member: interaction.user.id, force: true });
                    if (threadMember?.id !== interaction.user.id) return null;
                }
            } else if (![ChannelType.PublicThread, ChannelType.AnnouncementThread].includes(channel.type)) return null;
        }
        return { permissions, member, channel, parent, guild };
    } catch { return null; }
}
function currentNsfw(access, interaction) {
    if (!access?.channel) return isNsfwChannel(interaction);
    return access.channel.nsfw === true || access.parent?.nsfw === true;
}
function currentButtonAccess(interaction, settings, member) {
    const disabled = settings.button_disabled || {};
    const users = Array.isArray(disabled.user) ? disabled.user : [];
    const channels = Array.isArray(disabled.channel) ? disabled.channel : [];
    const roles = Array.isArray(disabled.role) ? disabled.role : [];
    if (users.includes(interaction.user.id) || channels.includes(interaction.channelId)) return false;
    if (Array.isArray(member?._roles)) return !roles.some(role => member._roles.includes(role));
    const memberRoles = member?.roles;
    if (roles.length && !Array.isArray(memberRoles) && typeof memberRoles?.cache?.has !== 'function') return false;
    const hasRole = role => Array.isArray(memberRoles) ? memberRoles.includes(role) : !!memberRoles?.cache?.has?.(role);
    return !roles.some(hasRole);
}
function withoutImages(embed, images) {
    const output = cards.cleanEmbed(embed);
    if (output.image?.url && images.includes(output.image.url)) delete output.image;
    return output;
}
function editPayload(first, payload, composed, markers = new Map()) {
    let embeds;
    let destination = 0;
    const attachments = cards.attachmentList(first), keptAttachments = [];
    if (new Set(attachments.map(file => String(file.id || ''))).size !== attachments.length) throw new Error('GRID_SOURCE_CHANGED');
    const originalAttachments = [];
    for (const file of attachments) {
        if (!/^\d{1,25}$/.test(String(file.id || ''))) throw new Error('GRID_SOURCE_CHANGED');
        const match = /^tg-([a-f0-9]{32})\.(?:jpg|png|webp)$/.exec(file.name || '');
        if (match) {
            if (!markers.has(match[1])) throw new Error('GRID_SOURCE_CHANGED');
            if (match[1] !== payload.id) keptAttachments.push({ id: String(file.id) });
        } else originalAttachments.push(file);
    }
    if (payload.sharedInline) {
        embeds = (first.embeds || []).map(cards.cleanEmbed);
        const existing = hasMarker(first, payload.id);
        if (existing) {
            const matching = embeds.flatMap((embed, index) => {
                const url = String(embed.image?.url || '');
                return new RegExp(`(?:/|^)tg-${payload.id}\\.(jpg|png|webp)(?:\\?|$)`).test(url) ? [index] : [];
            });
            if (matching.length !== 1) throw new Error('GRID_SOURCE_CHANGED');
            destination = matching[0];
            keptAttachments.push(...originalAttachments.map(file => ({ id: String(file.id) })));
        } else {
            const start = payload.embedStart, end = payload.embedEnd;
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > embeds.length) throw new Error('GRID_SOURCE_CHANGED');
            const found = [];
            for (let i = start; i < end; i++) if (payload.imageUrls.includes(embeds[i]?.image?.url)) found.push(i);
            if (!found.length && originalAttachments.length) {
                // Only the primary group can own source attachments. Keep
                // already combined siblings while replacing its originals.
                if (start !== 0 || originalAttachments.length !== payload.partSizes?.[0]
                    || originalAttachments.some(file => !String(file.contentType || '').startsWith('image/'))) throw new Error('GRID_SOURCE_CHANGED');
                destination = start;
            } else {
                if (found.length !== payload.imageUrls.length
                    || JSON.stringify(found.map(i => embeds[i].image.url).sort()) !== JSON.stringify([...payload.imageUrls].sort())) throw new Error('GRID_SOURCE_CHANGED');
                destination = found[0];
                // Embed-only quote: every original attachment belongs to a
                // different group and must be retained exactly as it was.
                keptAttachments.push(...originalAttachments.map(file => ({ id: String(file.id) })));
            }
            for (const i of found) delete embeds[i].image;
        }
    } else embeds = (first.embeds || []).map(embed => withoutImages(embed, payload.imageUrls));
    if (!embeds.length && !payload.sharedInline) {
        if (hasMarker(first, payload.id)) keptAttachments.push(...originalAttachments.map(file => ({ id: String(file.id) })));
        return { embeds: [], attachments: keptAttachments, files: [{ attachment: composed.data, name: marker(payload.id, composed.filename) }], allowedMentions: { parse: [], repliedUser: false } };
    }
    if (!embeds.length) throw new Error('GRID_SOURCE_CHANGED');
    const originalFirstImage = embeds[destination]?.image?.url;
    if (originalFirstImage && !hasMarker(first, payload.id)) throw new Error('GRID_SOURCE_CHANGED');
    const filename = marker(payload.id, composed.filename);
    embeds[destination].image = { url: `attachment://${filename}` };
    const kept = embeds.filter((embed, i) => i === destination || Object.keys(embed).some(key => !['url', 'type', 'color'].includes(key)));
    if (!payload.sharedInline && hasMarker(first, payload.id)) keptAttachments.push(...originalAttachments.map(file => ({ id: String(file.id) })));
    return { embeds: kept, attachments: keptAttachments, files: [{ attachment: composed.data, name: filename }], allowedMentions: { parse: [], repliedUser: false } };
}

// The row lock serializes public edits across workers. Discord and SQL cannot
// commit atomically, so the deterministic marker permits recovery if the Bot
// stops after the first edit or the continuation delete succeeds ambiguously.
async function replacePublic(interaction, row, composed, deps) {
    const database = deps.db || require('../db');
    return database.withDatabaseTransaction(async query => {
        const lockId = row.payload.lockId;
        if (!/^[a-f0-9]{32}$/.test(lockId || '')) return 'unavailable';
        const locks = await query('SELECT gallery_id,message_id FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [lockId, interaction.guildId, interaction.channelId, Date.now()]);
        if (!locks[0] || String(locks[0].message_id) !== sourceId(row)) return 'unavailable';
        const rows = await query('SELECT * FROM bot_media_galleries WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? FOR UPDATE',
            [row.payload.id, interaction.guildId, interaction.channelId, Date.now()]);
        if (!rows[0]) return 'unavailable';
        const payload = JSON.parse(rows[0].payload_json);
        if (payload.kind !== 'twitter-image-grid-v1' || payload.lockId !== lockId || payload.completedParts !== payload.totalParts
            || payload.partsState && payload.partsState !== 'complete' || !Array.isArray(payload.messageIds)
            || payload.totalParts < 1 || payload.totalParts > 20 || payload.messageIds.length !== payload.totalParts
            || new Set(payload.messageIds).size !== payload.messageIds.length || payload.messageIds[0] !== String(rows[0].message_id)
            || !Array.isArray(payload.partSizes) || payload.partSizes.length !== payload.totalParts
            || !Array.isArray(payload.partSignatures) || payload.partSignatures.length !== payload.totalParts) return 'incomplete';
        // Never erase non-image files from any post, even if their filenames
        // resemble an image. Legacy records use the same MIME/count checks.
        if (Array.isArray(payload.partContainsNonImage) && (payload.partContainsNonImage.length !== payload.totalParts
            || payload.partContainsNonImage.some(Boolean))) return 'changed';
        const settings = await (deps.getSettings || getFreshProviderSettings)({ id: 'twitter' }, interaction.guildId);
        const access = await (deps.freshAccess || freshAccess)(interaction);
        if (!access || settings.enabled !== true || cards.safetyHash(settings) !== payload.settingsHash || payload.nsfw && !currentNsfw(access, interaction)
            || !currentButtonAccess(interaction, settings, access.member) || !mayReplace(interaction, payload, settings, access.permissions || access, access.guild?.ownerId)) return 'denied';
        let first;
        const channel = access.channel || interaction.channel;
        try { first = await channel.messages.fetch({ message: payload.messageIds[0], force: true }); } catch { return 'unavailable'; }
        if (!sourceIsOwn(first, interaction.client) || cards.fingerprint(first, true) !== payload.firstStaticSignature) return 'changed';
        const already = hasMarker(first, payload.id);
        const markers = await markerRows(query, interaction, payload, first);
        if (!markers || already && !markers.has(payload.id)) return 'changed';
        if (!already && cards.fingerprint(first) !== payload.partSignatures?.[0]) return 'changed';
        const continuations = [];
        for (let index = 1; index < payload.totalParts; index++) {
            let current;
            try { current = await channel.messages.fetch({ message: payload.messageIds[index], force: true }); }
            catch (error) { if (!already || Number(error?.code) !== 10008) return 'changed'; }
            if (current && (!sourceIsOwn(current, interaction.client) || !safeContinuation(current, payload.partSignatures[index], payload.partSizes[index]))) return 'changed';
            continuations.push({ index, current });
        }
        if (!already) {
            const attachments = cards.attachmentList(first);
            if (!payload.sharedInline && attachments.length && (attachments.length !== payload.partSizes?.[0] || attachments.some(file => !String(file.contentType || '').startsWith('image/')))) return 'changed';
        }
        const update = async phase => {
            payload.replacePhase = phase;
            await query('UPDATE bot_media_galleries SET payload_json=? WHERE gallery_id=?', [JSON.stringify(payload), payload.id]);
        };
        // When the deterministic marker is already present and replacement
        // did not finish, resume deletion without repeating an ambiguous edit.
        let retainedIds = cards.attachmentList(first).filter(file => !new RegExp(`^tg-${payload.id}\\.(jpg|png|webp)$`).test(file.name || '')).map(file => String(file.id || ''));
        const resumePrior = already && payload.replacePhase !== 'done';
        if (resumePrior) {
            let nextEdit;
            try { nextEdit = editPayload(first, payload, composed, markers); } catch { return 'changed'; }
            if ((nextEdit.attachments || []).length + (nextEdit.files || []).length > 10) return 'attachment_limit';
        }
        if (!already || payload.replacePhase === 'done') {
            let edited;
            try { edited = editPayload(first, payload, composed, markers); } catch { return 'changed'; }
            if ((edited.attachments || []).length + (edited.files || []).length > 10) return 'attachment_limit';
            retainedIds = (edited.attachments || []).map(file => String(file.id));
            try { await first.edit(edited); }
            catch { await update('unknown'); return 'unknown'; }
            await update('edited');
        }
        // A confirmed edit alone is not proof that the combined message is
        // still present. Refresh it before considering any deletion, then
        // require the exact same content and marker for each subsequent part.
        let combined;
        try { combined = await channel.messages.fetch({ message: payload.messageIds[0], force: true }); }
        catch { await update('partial'); return 'partial'; }
        const combinedAttachments = cards.attachmentList(combined), combinedIds = combinedAttachments.map(file => String(file.id || ''));
        if (!sourceIsOwn(combined, interaction.client) || !hasMarker(combined, payload.id)
            || combinedAttachments.length !== retainedIds.length + 1 || retainedIds.some(id => !combinedIds.includes(id))
            || cards.fingerprint(combined, true) !== payload.firstStaticSignature) {
            await update('partial'); return 'partial';
        }
        const combinedFingerprint = cards.fingerprint(combined);
        for (const item of continuations) {
            if (!item.current) continue;
            // Access or source data may change while an earlier API call is
            // in flight. Recheck before every irreversible deletion.
            const currentSettings = await (deps.getSettings || getFreshProviderSettings)({ id: 'twitter' }, interaction.guildId);
            const currentAccess = await (deps.freshAccess || freshAccess)(interaction);
            if (!currentAccess || currentSettings.enabled !== true || cards.safetyHash(currentSettings) !== payload.settingsHash
                || payload.nsfw && !currentNsfw(currentAccess, interaction)
                || !currentButtonAccess(interaction, currentSettings, currentAccess.member)
                || !mayReplace(interaction, payload, currentSettings, currentAccess.permissions || currentAccess, currentAccess.guild?.ownerId)) {
                await update('partial'); return 'partial';
            }
            const currentChannel = currentAccess.channel || channel;
            let currentCombined;
            try { currentCombined = await currentChannel.messages.fetch({ message: payload.messageIds[0], force: true }); }
            catch { await update('partial'); return 'partial'; }
            if (!sourceIsOwn(currentCombined, interaction.client) || !hasMarker(currentCombined, payload.id)
                || cards.attachmentList(currentCombined).length !== combinedAttachments.length || cards.fingerprint(currentCombined) !== combinedFingerprint) {
                await update('partial'); return 'partial';
            }
            let current;
            try { current = await currentChannel.messages.fetch({ message: payload.messageIds[item.index], force: true }); }
            catch (error) { if (Number(error?.code) === 10008) continue; await update('partial'); return 'partial'; }
            if (!sourceIsOwn(current, interaction.client) || !safeContinuation(current, payload.partSignatures[item.index], payload.partSizes[item.index])) {
                await update('partial'); return 'partial';
            }
            try { await current.delete(); }
            catch { await update('partial'); return 'partial'; }
        }
        if (resumePrior) {
            // Finish the previously interrupted operation first, then apply
            // the layout selected for this new, explicitly confirmed action.
            const latestSettings = await (deps.getSettings || getFreshProviderSettings)({ id: 'twitter' }, interaction.guildId);
            const latestAccess = await (deps.freshAccess || freshAccess)(interaction);
            if (!latestAccess || latestSettings.enabled !== true || cards.safetyHash(latestSettings) !== payload.settingsHash
                || payload.nsfw && !currentNsfw(latestAccess, interaction) || !currentButtonAccess(interaction, latestSettings, latestAccess.member)
                || !mayReplace(interaction, payload, latestSettings, latestAccess.permissions || latestAccess, latestAccess.guild?.ownerId)) {
                await update('partial'); return 'partial';
            }
            const latestChannel = latestAccess.channel || channel;
            let latest;
            try { latest = await latestChannel.messages.fetch({ message: payload.messageIds[0], force: true }); }
            catch { await update('partial'); return 'partial'; }
            if (!sourceIsOwn(latest, interaction.client) || cards.fingerprint(latest) !== combinedFingerprint || !hasMarker(latest, payload.id)) {
                await update('partial'); return 'partial';
            }
            const latestMarkers = await markerRows(query, interaction, payload, latest);
            if (!latestMarkers || !latestMarkers.has(payload.id)) { await update('partial'); return 'partial'; }
            let replacement;
            try { replacement = editPayload(latest, payload, composed, latestMarkers); }
            catch { await update('partial'); return 'partial'; }
            try { await latest.edit(replacement); }
            catch { await update('unknown'); return 'unknown'; }
            let confirmed;
            try { confirmed = await latestChannel.messages.fetch({ message: payload.messageIds[0], force: true }); }
            catch { await update('unknown'); return 'unknown'; }
            const retained = (replacement.attachments || []).map(file => String(file.id)), actual = cards.attachmentList(confirmed);
            if (!sourceIsOwn(confirmed, interaction.client) || !hasMarker(confirmed, payload.id)
                || actual.length !== retained.length + 1 || retained.some(id => !actual.some(file => String(file.id) === id))
                || cards.fingerprint(confirmed, true) !== payload.firstStaticSignature) { await update('unknown'); return 'unknown'; }
        }
        await update('done'); return 'done';
    });
}
async function handle(interaction, deps = {}) {
    const ja = String(interaction.locale || '').startsWith('ja');
    const match = /^tg:([a-f0-9]{32}):(0|\d{16,22}):(open|layout|fit|format|target|run|preview|advanced|submit|replace|confirm|back)(?::([0-9a-z.]+))?$/.exec(interaction.customId || '');
    if (!match || !interaction.guildId || !interaction.user?.id || !sourceIsOwn(interaction.message, interaction.client)) return;
    const [, id, owner, action, packed] = match;
    if (owner !== '0' && owner !== interaction.user.id) { await interaction.reply({ content: ja ? 'この画面は開いた本人だけが操作できます。' : 'Only the person who opened this view can use it.', ephemeral: true }); return; }
    let state = packed ? decode(packed) : null;
    if (action !== 'open' && (!state || owner === '0')) return;
    if (owner !== '0' && !interaction.message.flags?.has?.(64)) return;
    if (action === 'advanced') { await interaction.showModal(modal(id, owner, state, interaction.locale)); return; }
    if (action === 'open') await interaction.deferReply({ ephemeral: true });
    else if (action === 'submit') await interaction.deferUpdate();
    else await interaction.deferUpdate();
    const fail = text => interaction.editReply({ content: text || (ja ? '画像を表示できません。元の投稿と設定を確認してください。' : 'Images are unavailable. Check the original post and settings.'), components: [], embeds: [], attachments: [] });
    if (!interaction.memberPermissions?.has?.(['ViewChannel', 'ReadMessageHistory'])) return fail();
    const storage = deps.storage || gallery.store();
    let row = await storage.get(id, interaction.guildId, interaction.channelId);
    if (!row || row.provider_id !== 'twitter' || !sourceId(row) || row.payload.kind !== 'twitter-image-grid-v1' || row.payload.id !== id
        || action === 'open' && sourceId(row) !== interaction.message.id || !Array.isArray(row.payload.imageUrls) || row.payload.imageUrls.length > 20
        || row.payload.imageUrls.length < 2 && !partsProgress(row.payload, interaction.locale)) return fail();
    if (interaction.channel?.isThread?.() && row.payload.nsfwContextVersion !== 1 && row.payload.nsfw !== true) return fail();
    const settings = await (deps.getSettings || getFreshProviderSettings)({ id: 'twitter' }, interaction.guildId);
    if (settings.enabled !== true || cards.safetyHash(settings) !== row.payload.settingsHash) return fail();
    if (!await (deps.isAllowed || isAllowed)(interaction, { providerId: 'twitter' })) return;
    const initialAccess = await (deps.freshAccess || freshAccess)(interaction);
    if (!initialAccess || row.payload.nsfw && !currentNsfw(initialAccess, interaction) || !currentButtonAccess(interaction, settings, initialAccess.member)) return fail();
    if (!await sourcesRemainValid(interaction, row, initialAccess)) {
        row = await reconcileSibling(interaction, row, deps).catch(() => null);
        if (!row || !await sourcesRemainValid(interaction, row, initialAccess)) return fail();
    }
    const canReplace = mayReplace(interaction, row.payload, settings, initialAccess.permissions || initialAccess, initialAccess.guild?.ownerId);
    const incomplete = partsProgress(row.payload, interaction.locale);
    if (action === 'open') {
        const expected = Array.isArray(row.payload.expectedImageUrls) && row.payload.expectedImageUrls.length >= 2 && row.payload.expectedImageUrls.length <= 20
            ? row.payload.expectedImageUrls.length : row.payload.imageUrls.length;
        state = defaults(settings, Math.max(1, expected), canReplace);
    }
    if (!canReplace) state.target = 'p';
    if (action === 'layout' || action === 'fit' || action === 'format' || action === 'target') {
        const value = interaction.values?.[0];
        if (action === 'layout' && /^\d{1,2}$/.test(value || '') && Number(value) >= 1 && Number(value) <= 20) state.columns = Number(value);
        else if (action === 'fit' && ['c','i'].includes(value)) state.fit = value;
        else if (action === 'format' && ['j','p','w'].includes(value)) state.format = value;
        else if (action === 'target' && (value === 'p' || value === 'r' && canReplace)) state.target = value;
        else return fail();
    }
    if (action === 'submit') {
        const next = modalState(interaction, state);
        if (!next) return interaction.editReply({ ...view(id, owner, state, settings, interaction.locale, ja ? '入力した値を確認してください。' : 'Check the values and try again.', canReplace, incomplete), embeds: [], attachments: [] });
        state = next;
    }
    if (incomplete && ['preview', 'run', 'replace', 'confirm'].includes(action)) return interaction.editReply({ ...view(id, owner, state, settings, interaction.locale, incomplete, canReplace), embeds: [], attachments: [] });
    if (action === 'replace' || action === 'run' && state.target === 'r') {
        if (!canReplace) return interaction.editReply({ ...view(id, owner, state, settings, interaction.locale, ja ? '公開画像の置換は投稿者または管理者が操作できます。' : 'Only the requester or an administrator can replace the public images.', false, incomplete), embeds: [], attachments: [] });
        return interaction.editReply({ content: ja ? 'このチャンネルの画像を置き換えます。' : 'Replace the images in this channel?', embeds: [], attachments: [], components: [{ type: 1, components: [
            { type: 2, style: 4, label: ja ? '置き換える' : 'Replace', custom_id: custom(id, owner, 'confirm', state) },
            { type: 2, style: 2, label: ja ? '戻る' : 'Back', custom_id: custom(id, owner, 'back', state) },
        ] }] });
    }
    if (action !== 'preview' && action !== 'confirm' && action !== 'run') return interaction.editReply({ ...view(id, owner === '0' ? interaction.user.id : owner, state, settings, interaction.locale, undefined, canReplace, incomplete), embeds: [], attachments: [] });
    if (action === 'confirm' && !canReplace) return fail(ja ? '公開画像の置換は投稿者・管理者が利用できます。' : 'Only the requester or an administrator can replace the public images.');
    try {
        const imageUrls = await sourceImageUrls(interaction, row, initialAccess);
        const composed = await (deps.compose || require('./twitter-image-grid').composeTwitterImageGrid)(imageUrls, { columns: state.columns, cellWidth: state.width, cellHeight: state.height,
            gap: state.gap, fit: state.fit === 'c' ? 'cover' : 'contain', background: `#${state.background}`, format: {j:'jpeg',p:'png',w:'webp'}[state.format], quality: state.quality });
        if (action === 'confirm') {
            const result = await replacePublic(interaction, row, composed, deps);
            const labels = { done: ja ? '公開画像を置き換えました。' : 'Public images replaced.', partial: ja ? 'まとめ画像を表示しました。後続の画像は残っています。もう一度操作できます。' : 'The combined image is visible; the later images remain. You can retry.',
                attachment_limit: ja ? '添付がいっぱいです。先に親投稿の画像をまとめてから、もう一度お試しください。' : 'The message has no attachment space. Combine the parent images first, then try again.',
                unknown: ja ? '置換結果を確認できませんでした。公開画像を確認してから再操作してください。' : 'The result is unknown. Check the public message before retrying.' };
            return interaction.editReply({ ...view(id, owner, state, settings, interaction.locale, labels[result] || (ja ? '公開画像が変更されたか、置換できませんでした。' : 'The public images changed or could not be replaced.'), canReplace, incomplete), embeds: [], attachments: [] });
        }
        const access = await (deps.freshAccess || freshAccess)(interaction);
        const current = await (deps.getSettings || getFreshProviderSettings)({ id: 'twitter' }, interaction.guildId);
        if (!access || current.enabled !== true || cards.safetyHash(current) !== row.payload.settingsHash || row.payload.nsfw && !currentNsfw(access, interaction)
            || !currentButtonAccess(interaction, current, access.member)) return fail();
        if (!await sourcesRemainValid(interaction, row, access)) return fail();
        return interaction.editReply({ ...view(id, owner, state, current, interaction.locale, composed.adapted ? (ja ? '表示できるよう画像サイズを調整しました。' : 'The image size was adjusted to fit.') : undefined, mayReplace(interaction, row.payload, current, access.permissions || access, access.guild?.ownerId), incomplete), attachments: [], files: [{ attachment: composed.data, name: composed.filename }] });
    } catch (cause) { return interaction.editReply({ ...view(id, owner, state, settings, interaction.locale, gridErrorText(cause, interaction.locale), canReplace, incomplete), embeds: [], attachments: [] }); }
}
module.exports = { handle, _internal: { defaults, encode, decode, modalState, mayReplace, freshAccess, currentButtonAccess, sourcesRemainValid, sourceImageUrls, reconcileSibling, embedWitnessPosition, markerRows, partsProgress, gridErrorText, fingerprint: cards.fingerprint, safeContinuation, editPayload, replacePublic, custom, view } };
