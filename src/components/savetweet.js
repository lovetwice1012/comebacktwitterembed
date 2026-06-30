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

async function handle(interaction) {
    const userDir = `${SAVES_ROOT}/${interaction.user.id}`;
    await fsp.mkdir(userDir, { recursive: true });

    let tweetUrl = interaction.message.embeds[0].url.split('?')[0];
    tweetUrl = tweetUrl.replace('twitter.com', 'api.vxtwitter.com').replace('x.com', 'api.vxtwitter.com');
    const tweetId = tweetUrl.split('/').pop();
    const tweetDir = `${userDir}/${tweetId}`;
    await fsp.mkdir(tweetDir, { recursive: true });

    const fetchRes = await fetch(tweetUrl);
    const tweetData = await fetchRes.json();

    for (let i = 0; i < tweetData.mediaURLs.length; i++) {
        const cleanUrl = tweetData.mediaURLs[i].split('?')[0];
        const fileName = cleanUrl.split('/').pop();
        await downloadToFile(cleanUrl, `${tweetDir}/${fileName}`);
    }

    tweetData.user_profile_image_url = tweetData.user_profile_image_url.split('?')[0];
    {
        const fileName = tweetData.user_profile_image_url.split('/').pop();
        await downloadToFile(tweetData.user_profile_image_url, `${tweetDir}/${fileName}`);
        tweetData.user_profile_image_url = `${PUBLIC_BASE_URL}${interaction.user.id}/${tweetId}/${fileName}`;
    }

    for (let i = 0; i < tweetData.mediaURLs.length; i++) {
        const fileName = tweetData.mediaURLs[i].split('/').pop();
        tweetData.mediaURLs[i] = `${PUBLIC_BASE_URL}${interaction.user.id}/${tweetId}/${fileName}`;
    }
    await fsp.writeFile(`${tweetDir}/data.json`, JSON.stringify(tweetData, null, 4));

    const quota = await getSaveTweetQuotaOverride(interaction.user.id) ?? DEFAULT_QUOTA_BYTES;
    if (await dirSize(userDir) > quota) {
        await fsp.rm(tweetDir, { recursive: true, force: true });
        await interaction.editReply({
            content: 'あなたが保存したツイートのデータ量が許可された保存容量を超えています。新しくツイートを保存する前に既存のものを削除してください',
            ephemeral: true,
        });
        setTimeout(() => { interaction.deleteReply(); }, 3000);
        return;
    }

    await interaction.editReply({ content: t('finishActionLocales', interaction.locale), ephemeral: true });
}

module.exports = { handle };
