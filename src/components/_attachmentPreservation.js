'use strict';

function getAttachmentItems(attachments) {
    if (!attachments) return [];
    const normalize = value => ({ id: value?.id, url: value?.url, name: value?.name,
        contentType: value?.contentType || value?.content_type, description: value?.description,
        spoiler: value?.spoiler, flags: value?.flags });
    if (typeof attachments.map === 'function') return attachments.map(normalize);
    return Array.from(attachments).map(value => normalize(Array.isArray(value) ? value[1] : value));
}

function isSpoiler(attachment) {
    try {
        if (attachment?.spoiler === true || /^SPOILER_/i.test(String(attachment?.name || ''))) return true;
        if (typeof attachment?.flags?.has === 'function') return attachment.flags.has(8);
        return Number.isSafeInteger(attachment?.flags) && (attachment.flags & 8) !== 0;
    } catch { return true; }
}

function preserveAttachment(attachment, retained, files) {
    if (/^\d{1,25}$/.test(String(attachment.id || ''))) {
        retained.push({ id: String(attachment.id), ...(typeof attachment.description === 'string' ? { description: attachment.description } : {}) });
    } else if (attachment.url && (!isSpoiler(attachment) || /^SPOILER_/.test(String(attachment.name || '')))) {
        files.push(attachment.name ? { attachment: attachment.url, name: attachment.name } : attachment.url);
    } else throw new Error('GRID_SOURCE_INCOMPLETE');
}

module.exports = { getAttachmentItems, isSpoiler, preserveAttachment };
