'use strict';

const fs = require('fs');
const https = require('https');
const fetch = require('node-fetch');
const { t } = require('../locales');
const { settings } = require('../settings');

const SAVES_ROOT = './saves';
const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB
const PUBLIC_BASE_URL = 'https://twidata.sprink.cloud/data/';

function downloadToFile(url, destPath) {
    return new Promise(resolve => {
        https.get(url, res => {
            const stream = fs.createWriteStream(destPath);
            res.pipe(stream);
            stream.on('finish', () => { stream.close(); resolve(); });
        });
    });
}

function dirSize(dirPath) {
    let total = 0;
    for (const entry of fs.readdirSync(dirPath)) {
        for (const file of fs.readdirSync(`${dirPath}/${entry}`)) {
            total += fs.statSync(`${dirPath}/${entry}/${file}`).size;
        }
    }
    return total;
}

async function handle(interaction) {
    if (!fs.existsSync(SAVES_ROOT)) fs.mkdirSync(SAVES_ROOT);
    const userDir = `${SAVES_ROOT}/${interaction.user.id}`;
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir);

    let tweetUrl = interaction.message.embeds[0].url.split('?')[0];
    tweetUrl = tweetUrl.replace('twitter.com', 'api.vxtwitter.com').replace('x.com', 'api.vxtwitter.com');
    const tweetId = tweetUrl.split('/').pop();
    const tweetDir = `${userDir}/${tweetId}`;
    if (!fs.existsSync(tweetDir)) fs.mkdirSync(tweetDir);

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
    fs.writeFileSync(`${tweetDir}/data.json`, JSON.stringify(tweetData, null, 4));

    const quota = settings.save_tweet_quota_override[interaction.user.id] ?? DEFAULT_QUOTA_BYTES;
    if (dirSize(userDir) > quota) {
        fs.rmSync(tweetDir, { recursive: true });
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
