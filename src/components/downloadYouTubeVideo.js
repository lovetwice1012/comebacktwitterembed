'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const youtubeProvider = require('../providers/youtube');
const downloadStore = require('../youtubeDownloadStore');

function getYouTubeUrl(interaction) {
    const url = interaction.message?.embeds?.[0]?.url;
    const parsed = /** @type {any} */ (youtubeProvider)._internal.parseYouTubeUrl(url);
    if (!parsed || parsed.type !== 'video') return null;
    return parsed.originalUrl || url;
}

function formatSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    const mib = value / 1024 / 1024;
    if (mib >= 1024) return `${(mib / 1024).toFixed(2)} GiB`;
    return `${mib.toFixed(1)} MiB`;
}

async function handle(interaction) {
    const url = getYouTubeUrl(interaction);
    if (!url) {
        await interaction.editReply({ content: 'No downloadable YouTube video URL was found on this embed.' });
        return;
    }

    await interaction.editReply({ content: 'Preparing the download. This can take a few minutes.' });

    try {
        const record = await downloadStore.downloadYouTubeToCache(url);
        const expiresAt = Math.floor(record.expiresAtMs / 1000);
        const sizeText = formatSize(record.sizeBytes);
        const details = sizeText ? `\nSize: ${sizeText}` : '';
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setURL(record.publicUrl)
                .setLabel('Download video')
        );

        await interaction.editReply({
            content: `Download is ready.${details}\nThis link expires <t:${expiresAt}:R>.`,
            components: [row],
        });
    } catch (err) {
        if (err?.status === 429) {
            const retry = err.retryAfter ? ` Retry after ${err.retryAfter} seconds.` : '';
            await interaction.editReply({ content: `The download service is rate limited.${retry}` });
            return;
        }
        console.warn('[downloadYouTubeVideo] failed:', err?.message || err);
        await interaction.editReply({ content: 'Failed to prepare the download.' });
    }
}

module.exports = {
    handle,
    _internal: {
        formatSize,
        getYouTubeUrl,
    },
};
