'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const fetch = require('node-fetch');
const { t } = require('../locales');
const { getSaveTweetQuotaOverride } = require('../providers/_provider_settings');

const SAVES_ROOT = './saves';
const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB
const PUBLIC_BASE_URL = 'https://twidata.sprink.cloud/data/';

function stripDiscordUrlMarkup(value) {
    return String(value || '').trim().replace(/^<(.+)>$/, '$1').replace(/^\|\|(.+)\|\|$/, '$1');
}

function tweetIdFromUrl(tweetUrl) {
    const match = String(tweetUrl || '').match(/\/status\/(\d+)/);
    return match ? match[1] : '';
}

function tweetApiUrl(tweetUrl) {
    const cleanUrl = stripDiscordUrlMarkup(tweetUrl).split('?')[0];
    return cleanUrl.replace(/twitter\.com|x\.com/g, 'api.vxtwitter.com');
}

function downloadToFile(url, destPath) {
    return new Promise(resolve => {
        https.get(url, res => {
            const stream = fs.createWriteStream(destPath);
            res.pipe(/** @type {any} */ (stream));
            stream.on('finish', () => { stream.close(); resolve(); });
        });
    });
}

async function dirSize(dirPath) {
    let total = 0;
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childDir = `${dirPath}/${entry.name}`;
        const files = await fsp.readdir(childDir, { withFileTypes: true });
        for (const file of files) {
            if (!file.isFile()) continue;
            total += (await fsp.stat(`${childDir}/${file.name}`)).size;
        }
    }
    return total;
}

async function saveTweetByUrl(userId, tweetUrl) {
    const userDir = `${SAVES_ROOT}/${userId}`;
    await fsp.mkdir(userDir, { recursive: true });

    const apiUrl = tweetApiUrl(tweetUrl);
    const tweetId = tweetIdFromUrl(apiUrl);
    if (!tweetId) throw new Error('Could not determine tweet id for saving.');

    const tweetDir = `${userDir}/${tweetId}`;
    await fsp.mkdir(tweetDir, { recursive: true });

    const fetchRes = await fetch(apiUrl);
    const tweetData = await fetchRes.json();
    if (!Array.isArray(tweetData.mediaURLs)) tweetData.mediaURLs = [];

    for (let i = 0; i < tweetData.mediaURLs.length; i++) {
        const cleanUrl = tweetData.mediaURLs[i].split('?')[0];
        const fileName = cleanUrl.split('/').pop();
        await downloadToFile(cleanUrl, `${tweetDir}/${fileName}`);
    }

    if (typeof tweetData.user_profile_image_url === 'string' && tweetData.user_profile_image_url) {
        tweetData.user_profile_image_url = tweetData.user_profile_image_url.split('?')[0];
        const fileName = tweetData.user_profile_image_url.split('/').pop();
        await downloadToFile(tweetData.user_profile_image_url, `${tweetDir}/${fileName}`);
        tweetData.user_profile_image_url = `${PUBLIC_BASE_URL}${userId}/${tweetId}/${fileName}`;
    }

    for (let i = 0; i < tweetData.mediaURLs.length; i++) {
        const fileName = tweetData.mediaURLs[i].split('/').pop();
        tweetData.mediaURLs[i] = `${PUBLIC_BASE_URL}${userId}/${tweetId}/${fileName}`;
    }
    await fsp.writeFile(`${tweetDir}/data.json`, JSON.stringify(tweetData, null, 4));

    const quota = await getSaveTweetQuotaOverride(userId) ?? DEFAULT_QUOTA_BYTES;
    if (await dirSize(userDir) > quota) {
        await fsp.rm(tweetDir, { recursive: true, force: true });
        return { saved: false, reason: 'quota', tweetId };
    }

    return { saved: true, tweetId };
}

async function handle(interaction) {
    const tweetUrl = interaction.message.embeds[0].url;
    const result = await saveTweetByUrl(interaction.user.id, tweetUrl);
    if (!result.saved && result.reason === 'quota') {
        await interaction.editReply({
            content: 'Saved tweet quota exceeded. Delete old saved tweets before saving a new one.',
            ephemeral: true,
        });
        setTimeout(() => { interaction.deleteReply(); }, 3000);
        return;
    }

    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
}

module.exports = {
    handle,
    saveTweetByUrl,
    _internal: {
        tweetApiUrl,
        tweetIdFromUrl,
    },
};
