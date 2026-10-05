'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { isNsfwChannel } = require('./providers/_sensitive_controls');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PROVIDERS = new Set(['pixiv', 'instagram']);
const SWITCHES = new Set(['showMediaAsAttachments', 'showAttachmentsAsEmbedsImage']);

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function settingsHash(settings) {
    const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    return createHash('sha256').update(JSON.stringify(ordered(settings || {}))).digest('hex');
}

// Work exclusively with the provider's final, policy-filtered output. Hidden
// media is never recovered from analytics or fetched again by the viewer.
function pagesFor(step, settings) {
    if (settings?.gallery_display_mode !== 'gallery' || step.outputRole === 'failure_notice'
        || ['thumbnail_only', 'link_only'].includes(settings.media_display_mode)) return null;
    const embeds = plain(step.embeds || []);
    if (!embeds.length || embeds.slice(1).some(e => e.title || e.description || e.fields?.length || e.author)) return null;
    const files = step.files || [];
    if (files.some(file => !/^https?:\/\//.test(typeof file === 'string' ? file : file?.attachment || ''))) return null;
    const base = { ...embeds[0] };
    delete base.image;
    const pages = [];
    const used = new Set();
    for (const embed of embeds) {
        const url = embed.image?.url;
        if (!url || used.has(url)) continue;
        used.add(url);
        if (url.startsWith('attachment://')) {
            const file = files.find(f => typeof f === 'object' && f.name === url.slice(13));
            if (!file) return null;
            used.add(file);
            pages.push({ embeds: [file.name?.startsWith('SPOILER_') ? { ...base } : { ...base, image: { url } }], files: [plain(file)] });
        } else {
            const attached = files.find(f => (typeof f === 'string' ? f : f.attachment) === url);
            if (attached) used.add(attached);
            if (typeof attached === 'object' && attached.name?.startsWith('SPOILER_')) {
                pages.push({ embeds: [{ ...base }], files: [plain(attached)] });
            } else {
                pages.push({ embeds: [{ ...base, image: { url } }], files: [] });
            }
        }
    }
    for (const file of files) {
        if (!used.has(file)) pages.push({ embeds: [{ ...base }], files: [plain(file)] });
    }
    return pages.length > 1 && pages.length <= 100 ? pages : null;
}

function controls(id, index, total, owner, language) {
    const ja = String(language || 'ja').startsWith('ja');
    const button = (label, page, disabled = false) => ({ type: 2, style: 2, label,
        custom_id: `gallery:${id}:${page}:${owner}`, disabled });
    return { type: 1, components: [
        button(ja ? '前へ' : 'Previous', Math.max(0, index - 1), index === 0),
        button(`${index + 1} / ${total}`, index, true),
        button(ja ? '次へ' : 'Next', Math.min(total - 1, index + 1), index === total - 1),
        ...(owner === '0' ? [{ type: 2, style: 1, label: ja ? '自分用に開く' : 'Open for me', custom_id: `gallery:${id}:${index}:0` }] : []),
    ] };
}

function render(gallery, index, owner = '0', locale = gallery.language) {
    const page = gallery.pages[index];
    if (!page) throw new Error('Invalid gallery page');
    return { ...plain(page), content: gallery.content || '', attachments: [],
        allowedMentions: { parse: [], repliedUser: false },
        components: [controls(gallery.id, index, gallery.pages.length, owner, locale)] };
}

function createStore(db = require('./db')) {
    let lastCleanup = 0;
    return {
        async save(gallery, message, providerId) {
            await db.queryDatabase(`INSERT INTO bot_media_galleries
                (gallery_id,guild_id,channel_id,provider_id,payload_json,expires_at_ms) VALUES (?,?,?,?,?,?)`,
            [gallery.id, message.guildId || message.guild.id, message.channelId || message.channel.id,
                providerId, JSON.stringify(gallery), Date.now() + RETENTION_MS]);
            if (Date.now() - lastCleanup > 60000) {
                lastCleanup = Date.now();
                await db.queryDatabase('DELETE FROM bot_media_galleries WHERE expires_at_ms<? LIMIT 500', [Date.now()]);
            }
        },
        async bind(id, messageId) {
            await db.queryDatabase('UPDATE bot_media_galleries SET message_id=? WHERE gallery_id=?', [messageId, id]);
        },
        async get(id, guildId, channelId) {
            const rows = await db.queryDatabase(`SELECT * FROM bot_media_galleries
                WHERE gallery_id=? AND guild_id=? AND channel_id=? AND expires_at_ms>? LIMIT 1`,
            [id, guildId, channelId, Date.now()]);
            if (!rows[0]) return null;
            return { ...rows[0], payload: JSON.parse(rows[0].payload_json) };
        },
    };
}

let defaultStore;
function store() { return defaultStore ||= createStore(); }
async function prepare(step, message, context, storage = store()) {
    if (!PROVIDERS.has(context.providerId) || !(message.guildId || message.guild?.id)) return { step };
    const settings = context.presentationSettings;
    if (settings?.button_invisible?.all || settings?.button_invisible?.gallery) return { step };
    const pages = pagesFor(step, settings);
    if (!pages) return { step };
    const gallery = { id: randomBytes(16).toString('hex'), pages, content: step.content,
        language: settings.defaultLanguage, settingsHash: settingsHash(settings), nsfw: isNsfwChannel(message), nsfwContextVersion: 1 };
    if (Buffer.byteLength(JSON.stringify(gallery)) > 1024 * 1024) return { step };
    try {
        await storage.save(gallery, message, context.providerId);
        const output = render(gallery, 0);
        // Keep actions on the public card; private viewers only navigate pages.
        const rows = plain(step.components || []).map(row => ({ ...row,
            components: row.components.filter(button => !SWITCHES.has((button.custom_id || '').split(':')[0])),
        })).filter(row => row.components.length);
        if (rows.length >= 5) return { step };
        return { step: { ...step, embeds: output.embeds, files: output.files,
            components: [...rows, ...output.components] }, galleryId: gallery.id };
    } catch (error) {
        report(error);
        return { step }; // A storage outage must not discard any media.
    }
}

function report(error) {
    require('./errorTracking').recordError(error, { source: 'mediaGallery', fallbackType: 'media_gallery_failed' });
}

module.exports = { pagesFor, settingsHash, controls, render, createStore, store, prepare, report };
