'use strict';

const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_COUNT_LIMIT = 25;
const SAFE_DESCRIPTION_LIMIT = 3900;
const SAFE_FIELD_VALUE_LIMIT = 1000;

function truncateText(value, maxLength) {
    const text = String(value ?? '');
    if (text.length <= maxLength) return text;
    if (maxLength <= 3) return text.slice(0, maxLength);
    return text.slice(0, maxLength - 3) + '...';
}

function splitLongLine(line, maxLength) {
    const chunks = [];
    let rest = line;
    while (rest.length > maxLength) {
        chunks.push(rest.slice(0, maxLength));
        rest = rest.slice(maxLength);
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks;
}

function splitTextByLimit(value, maxLength = SAFE_DESCRIPTION_LIMIT) {
    const text = String(value ?? '');
    if (text.length === 0) return [];

    const chunks = [];
    let current = '';
    for (const rawLine of text.split('\n')) {
        const line = rawLine + '\n';
        if (line.length > maxLength) {
            if (current) {
                chunks.push(current.trimEnd());
                current = '';
            }
            chunks.push(...splitLongLine(line, maxLength).map(chunk => chunk.trimEnd()).filter(Boolean));
            continue;
        }

        if (current && current.length + line.length > maxLength) {
            chunks.push(current.trimEnd());
            current = line;
        } else {
            current += line;
        }
    }

    if (current.trimEnd()) chunks.push(current.trimEnd());
    return chunks;
}

function splitLinesByLimit(lines, maxLength = SAFE_DESCRIPTION_LIMIT) {
    return splitTextByLimit((lines || []).join('\n'), maxLength);
}

function pageTitle(title, index, total) {
    return total > 1 ? `${title} (${index + 1}/${total})` : title;
}

async function sendEmbedPages(interaction, options) {
    const {
        title,
        description,
        lines,
        emptyDescription = 'No entries.',
        color = 0x1DA1F2,
        ephemeralFollowUps = false,
    } = options;
    const pages = lines
        ? splitLinesByLimit(lines, SAFE_DESCRIPTION_LIMIT)
        : splitTextByLimit(description, SAFE_DESCRIPTION_LIMIT);
    if (pages.length === 0) pages.push(emptyDescription);

    for (let i = 0; i < pages.length; i++) {
        const payload = {
            embeds: [{
                title: truncateText(pageTitle(title, i, pages.length), 256),
                description: truncateText(pages[i], EMBED_DESCRIPTION_LIMIT),
                color,
            }],
        };
        if (i === 0) await interaction.editReply(payload);
        else await interaction.followUp({ ...payload, ephemeral: ephemeralFollowUps });
    }
}

function normalizeFieldName(name, index, total) {
    const suffix = total > 1 ? ` (${index + 1}/${total})` : '';
    return truncateText(String(name || '\u200b') + suffix, EMBED_FIELD_NAME_LIMIT);
}

function splitEmbedField(field) {
    const values = splitTextByLimit(field.value || '\u200b', SAFE_FIELD_VALUE_LIMIT);
    const parts = values.length > 0 ? values : ['\u200b'];
    return parts.map((value, index) => ({
        name: normalizeFieldName(field.name, index, parts.length),
        value: truncateText(value, EMBED_FIELD_VALUE_LIMIT),
        inline: field.inline === true,
    }));
}

function normalizeEmbedFields(fields) {
    return (fields || []).flatMap(splitEmbedField);
}

function normalizeEmbed(embed) {
    if (!embed || typeof embed !== 'object') return embed;
    const next = { ...embed };
    if (next.title !== undefined) next.title = truncateText(next.title, 256);
    if (next.description !== undefined) next.description = truncateText(next.description, EMBED_DESCRIPTION_LIMIT);
    if (Array.isArray(next.fields)) {
        next.fields = normalizeEmbedFields(next.fields).slice(0, EMBED_FIELD_COUNT_LIMIT);
    }
    if (next.footer?.text) next.footer = { ...next.footer, text: truncateText(next.footer.text, 2048) };
    if (next.author?.name) next.author = { ...next.author, name: truncateText(next.author.name, 256) };
    return next;
}

async function sendFieldEmbeds(interaction, options) {
    const {
        title,
        fields,
        color = 0x1DA1F2,
        description,
        ephemeralFollowUps = false,
    } = options;
    const normalizedFields = normalizeEmbedFields(fields);
    const pages = [];
    for (let i = 0; i < normalizedFields.length; i += EMBED_FIELD_COUNT_LIMIT) {
        pages.push(normalizedFields.slice(i, i + EMBED_FIELD_COUNT_LIMIT));
    }
    if (pages.length === 0) pages.push([]);

    for (let i = 0; i < pages.length; i++) {
        const embed = {
            title: truncateText(pageTitle(title, i, pages.length), 256),
            color,
            fields: pages[i],
        };
        if (description && i === 0) {
            embed.description = truncateText(description, EMBED_DESCRIPTION_LIMIT);
        }
        const payload = { embeds: [embed] };
        if (i === 0) await interaction.editReply(payload);
        else await interaction.followUp({ ...payload, ephemeral: ephemeralFollowUps });
    }
}

module.exports = {
    splitTextByLimit,
    splitLinesByLimit,
    sendEmbedPages,
    normalizeEmbedFields,
    normalizeEmbed,
    sendFieldEmbeds,
    truncateText,
};
