'use strict';

const fetch = require('node-fetch');
const { ComponentType } = require('discord.js');
const { t } = require('../locales');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');
const { getAttachmentItems, preserveAttachment } = require('./_attachmentPreservation');
const { matchesReference } = require('../discordAttachmentIdentity');

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif']);
const CONTENT_TYPE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
};

function getImageExtensionFromUrl(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return null; }

    const pathMatch = u.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    const pathExt = pathMatch?.[1];
    if (IMAGE_EXTENSIONS.has(pathExt)) return pathExt === 'jpeg' ? 'jpg' : pathExt;

    const queryExt = (u.searchParams.get('format') || u.searchParams.get('fm') || '').toLowerCase();
    if (IMAGE_EXTENSIONS.has(queryExt)) return queryExt === 'jpeg' ? 'jpg' : queryExt;

    return null;
}

function imageUrlHasExtension(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return false; }
    return /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(u.pathname);
}

function getContentTypeHeader(headers) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get('content-type') || '';
    return headers['content-type'] || headers['Content-Type'] || '';
}

function getImageExtensionFromContentType(contentType) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    return CONTENT_TYPE_EXTENSIONS[mime] || null;
}

function getImageExtensionFromMagicBytes(buffer) {
    if (!buffer || buffer.length < 4) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'gif';
    if (
        buffer.length >= 12
        && buffer.toString('ascii', 0, 4) === 'RIFF'
        && buffer.toString('ascii', 8, 12) === 'WEBP'
    ) return 'webp';
    if (
        buffer.length >= 12
        && buffer.toString('ascii', 4, 8) === 'ftyp'
        && ['avif', 'avis'].includes(buffer.toString('ascii', 8, 12))
    ) return 'avif';
    return null;
}

async function fetchImageExtension(rawUrl) {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; comebacktwitterembed/1.0)' };

    try {
        const head = await fetch(rawUrl, { method: 'HEAD', headers, signal: AbortSignal.timeout(4000) });
        const fromHead = head.ok === false ? null : getImageExtensionFromContentType(getContentTypeHeader(head.headers));
        if (fromHead) return fromHead;
    } catch (err) {
        void err;
    }

    try {
        const res = await fetch(rawUrl, { headers: { ...headers, Range: 'bytes=0-15' }, signal: AbortSignal.timeout(4000) });
        try {
            if (!res.ok) return null;
            const fromContentType = getImageExtensionFromContentType(getContentTypeHeader(res.headers));
            if (fromContentType) return fromContentType;
            const chunks = [];
            let size = 0;
            for await (const chunk of res.body) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const part = bytes.subarray(0, 16 - size);
                chunks.push(part);
                size += part.length;
                if (size >= 16) break;
            }
            return getImageExtensionFromMagicBytes(Buffer.concat(chunks, size));
        } finally {
            res.body?.destroy();
        }
    } catch (err) {
        void err;
    }

    return null;
}

async function resolveImageExtension(rawUrl) {
    return getImageExtensionFromUrl(rawUrl) || await fetchImageExtension(rawUrl);
}

async function buildImageFile(url, index) {
    if (imageUrlHasExtension(url)) return url;
    const extension = await resolveImageExtension(url);
    if (!extension) throw new Error('GRID_SOURCE_INCOMPLETE');
    return {
        attachment: url,
        name: `embed-image-${index}.${extension}`,
    };
}

function addFile(files, seen, file) {
    const key = typeof file === 'string' ? file : file.attachment;
    if (!key || seen.has(key)) return;
    seen.add(key);
    files.push(file);
}

async function handle(interaction, { buttons }) {
    const { showAttachmentsAsMediaButton, translateButton, deleteButton } = buttons;

    const files = [], retained = [];
    const seenFiles = new Set();
    const existing = getAttachmentItems(interaction.message.attachments);
    for (const attachment of existing) {
        preserveAttachment(attachment, retained, files);
        if (attachment.url) seenFiles.add(attachment.url);
    }
    const messageObject = {
        components: [
            { type: ComponentType.ActionRow, components: [showAttachmentsAsMediaButton] },
        ],
        files: [],
        embeds: [],
    };
    if (retained.length) messageObject.attachments = retained;
    messageObject.components.push({
        type: ComponentType.ActionRow,
        components: interaction.message.embeds[0]?.title ? [translateButton, deleteButton] : [deleteButton],
    });

    let imageCount = 0;
    for (let index = 0; index < interaction.message.embeds.length; index++) {
        const element = interaction.message.embeds[index];
        if (!element.image) continue;
        imageCount++;
        if (!element.image.url) throw new Error('GRID_SOURCE_INCOMPLETE');
        const alreadyRetained = existing.some(file => /^\d{1,25}$/.test(String(file.id || ''))
            && matchesReference(element.image.url, file, interaction.channelId || interaction.message.channelId, { allowAttachmentScheme: true }));
        if (!alreadyRetained) addFile(files, seenFiles, await buildImageFile(element.image.url, index + 1));
    }
    if (!imageCount) throw new Error('GRID_NO_DISPLAYABLE_IMAGES');
    messageObject.files = files;

    for (const element of interaction.message.embeds) {
        const copy = JSON.parse(JSON.stringify(element));
        delete copy.image;
        if (copy.title || copy.description || copy.fields?.length || copy.author?.name || copy.footer?.text || copy.thumbnail?.url || copy.video?.url)
            messageObject.embeds.push(copy);
    }

    const providerId = detectProviderIdFromMessage(interaction.message);
    messageObject.components = await checkComponentIncludesDisabledButtonAndIfFindDeleteIt(messageObject.components, interaction.guildId, providerId);
    await interaction.message.edit(messageObject);
    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
    setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
}

module.exports = { handle };
module.exports._internal = {
    getImageExtensionFromUrl,
    getImageExtensionFromContentType,
    getImageExtensionFromMagicBytes,
    resolveImageExtension,
};
