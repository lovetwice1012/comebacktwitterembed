'use strict';

const fetch = require('node-fetch');
const { ComponentType } = require('discord.js');
const { t } = require('../locales');
const { checkComponentIncludesDisabledButtonAndIfFindDeleteIt, detectProviderIdFromMessage } = require('../settings');

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif']);
const CONTENT_TYPE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
};

function getAttachmentUrls(attachments) {
    if (!attachments) return [];
    if (typeof attachments.map === 'function') return attachments.map(a => a.url).filter(Boolean);
    return Array.from(attachments).map(a => (Array.isArray(a) ? a[1]?.url : a?.url)).filter(Boolean);
}

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
        const head = await fetch(rawUrl, { method: 'HEAD', headers });
        const fromHead = getImageExtensionFromContentType(getContentTypeHeader(head.headers));
        if (fromHead) return fromHead;
    } catch (err) {
        void err;
    }

    try {
        const res = await fetch(rawUrl, { headers: { ...headers, Range: 'bytes=0-15' } });
        const fromContentType = getImageExtensionFromContentType(getContentTypeHeader(res.headers));
        if (fromContentType) return fromContentType;
        if (typeof res.buffer === 'function') {
            const bytes = await res.buffer();
            const fromBytes = getImageExtensionFromMagicBytes(bytes);
            if (fromBytes) return fromBytes;
        }
    } catch (err) {
        void err;
    }

    return 'jpg';
}

async function resolveImageExtension(rawUrl) {
    return getImageExtensionFromUrl(rawUrl) || await fetchImageExtension(rawUrl);
}

async function buildImageFile(url, index) {
    if (imageUrlHasExtension(url)) return url;
    const extension = await resolveImageExtension(url);
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

    const files = [];
    const seenFiles = new Set();
    getAttachmentUrls(interaction.message.attachments).forEach(url => addFile(files, seenFiles, url));
    const messageObject = {
        components: [
            { type: ComponentType.ActionRow, components: [showAttachmentsAsMediaButton] },
        ],
        files: [],
        embeds: [],
    };
    messageObject.components.push({
        type: ComponentType.ActionRow,
        components: interaction.message.embeds[0].title ? [translateButton, deleteButton] : [deleteButton],
    });

    for (let index = 0; index < interaction.message.embeds.length; index++) {
        const element = interaction.message.embeds[index];
        if (element.image) addFile(files, seenFiles, await buildImageFile(element.image.url, index + 1));
    }
    messageObject.files = files;

    const deepCopyEmbed0 = JSON.parse(JSON.stringify(interaction.message.embeds[0]));
    delete deepCopyEmbed0.image;
    messageObject.embeds.push(deepCopyEmbed0);

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
