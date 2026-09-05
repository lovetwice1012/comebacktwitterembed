'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const fetch = require('../providerFetch').withDeadline(require('node-fetch'));
const { t } = require('../locales');
const { getSaveTweetQuotaOverride } = require('../providers/_provider_settings');

const SAVES_ROOT = process.env.SAVES_DIR || require('path').join(process.env.ADMIN_SUPPORT_DATA_DIR || '.', 'saves');
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

function safeMediaFileName(url) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Saved media requires a plain HTTP(S) URL.');
    const rawPath = String(url).split('?')[0].split('#')[0];
    if (rawPath.includes('\\')) throw new Error('Backslashes are not allowed in saved media URLs.');
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    if (!name || name === '.' || name === '..' || /[<>:"/\\|?*]/.test(name) || Array.from(name).some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(name)
        || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name)) throw new Error('Unsafe saved media filename.');
    return name;
}
async function assertPlainDirectory(directory) {
    const stat = await fsp.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat?.isSymbolicLink() || stat && !stat.isDirectory()) throw new Error('Saved-data directories must not be symbolic links or files.');
    if (!stat) await fsp.mkdir(directory, { recursive: true });
}
async function downloadToFile(url, destPath) {
    const response = await fetch(url, { timeout: 30000, size: 25 * 1024 * 1024 });
    if (!response.ok) throw new Error(`Saved media HTTP ${response.status}`);
    const bytes = await response.buffer();
    const handle = await fsp.open(destPath, 'wx', 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function treeSize(directory) {
    let total = 0;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error('Saved-data symbolic links are not permitted.');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) total += await treeSize(file);
        else if (entry.isFile()) total += (await fsp.stat(file)).size;
    }
    return total;
}
async function pathExists(file) { return fsp.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
async function userSavedSize(directory) {
    let total = 0;
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Saved-data symbolic links are not permitted.');
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) total += await treeSize(path.join(directory, entry.name));
    }
    return total;
}
async function saveTweetByUrl(userId, tweetUrl) {
    if (typeof userId !== 'string' || !/^\d{16,22}$/.test(userId)) throw new Error('Invalid user ID.');
    const source = new URL(stripDiscordUrlMarkup(tweetUrl));
    if (!['twitter.com', 'x.com'].includes(source.hostname) || !['http:', 'https:'].includes(source.protocol) || source.username || source.password) throw new Error('A Twitter or X status URL is required for saving.');
    const apiUrl = tweetApiUrl(tweetUrl);
    const tweetId = tweetIdFromUrl(apiUrl);
    if (!/^\d{1,22}$/.test(tweetId)) throw new Error('Could not determine tweet id for saving.');
    const root = path.resolve(SAVES_ROOT), userDir = path.join(root, userId), tweetDir = path.join(userDir, tweetId);
    await assertPlainDirectory(root); await assertPlainDirectory(userDir);
    const lockPath = path.join(userDir, '.admin-save.lock');
    let lock;
    try { lock = await fsp.open(lockPath, 'wx', 0o600); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
        let alive = true;
        try { process.kill(previous.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
        if (alive) throw Object.assign(new Error('Another save is in progress for this user.'), { code: 'SAVE_BUSY' });
        await fsp.unlink(lockPath); lock = await fsp.open(lockPath, 'wx', 0o600);
    }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, tweetId })); }
    catch (error) { await lock.close(); await fsp.unlink(lockPath).catch(() => {}); throw error; }
    const stageRoot = path.join(root, '.admin-staging'), trashRoot = path.join(root, '.admin-trash');
    const journal = path.join(userDir, '.admin-save-journal.json');
    const receipt = `${userId}-${tweetId}-${crypto.randomUUID()}`;
    const stage = path.join(stageRoot, receipt), backup = path.join(trashRoot, receipt);
    let installed = false;
    try {
        await assertPlainDirectory(stageRoot); await assertPlainDirectory(trashRoot);
        // Recover a process interruption between the two directory renames.
        if (await pathExists(journal)) {
            const old = JSON.parse(await fsp.readFile(journal, 'utf8'));
            const oldTarget = path.resolve(old.target || ''), oldBackup = path.resolve(old.backup || ''), oldStage = path.resolve(old.stage || '');
            if (path.dirname(oldTarget) !== userDir || !/^\d{1,22}$/.test(path.basename(oldTarget))
                || path.dirname(oldBackup) !== trashRoot || path.dirname(oldStage) !== stageRoot
                || !path.basename(oldBackup).startsWith(`${userId}-`) || !path.basename(oldStage).startsWith(`${userId}-`)) throw new Error('Invalid saved-data recovery journal.');
            if (!await pathExists(oldTarget) && await pathExists(oldBackup)) await fsp.rename(oldBackup, oldTarget);
            await fsp.rm(oldStage, { recursive: true, force: true });
            await fsp.unlink(journal);
        }
        const existing = await fsp.lstat(tweetDir).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing?.isSymbolicLink() || existing && !existing.isDirectory()) throw new Error('Existing saved tweet is not a plain directory.');
        const quota = await getSaveTweetQuotaOverride(userId) ?? DEFAULT_QUOTA_BYTES;
        const retainedBytes = await userSavedSize(userDir) - await treeSize(tweetDir);
        if (retainedBytes >= quota) return { saved: false, reason: 'quota', tweetId };
        await fsp.mkdir(stage);
        const response = await fetch(apiUrl, { timeout: 30000, size: 4 * 1024 * 1024 });
        if (!response.ok) throw new Error(`Saved tweet HTTP ${response.status}`);
        const tweetData = await response.json();
        if (!tweetData || Array.isArray(tweetData) || typeof tweetData !== 'object' || typeof tweetData.text !== 'string' && !tweetData.tweetURL) throw new Error('The upstream response is not a tweet.');
        if (!Array.isArray(tweetData.mediaURLs)) tweetData.mediaURLs = [];
        if (tweetData.mediaURLs.length > 100) throw new Error('Saved tweet contains too many media files.');
        for (let index = 0; index < tweetData.mediaURLs.length; index++) {
            const mediaUrl = tweetData.mediaURLs[index];
            const name = `media-${index}-${safeMediaFileName(mediaUrl)}`;
            await downloadToFile(mediaUrl, path.join(stage, name));
            if (retainedBytes + await treeSize(stage) > quota) return { saved: false, reason: 'quota', tweetId };
            tweetData.mediaURLs[index] = `${PUBLIC_BASE_URL}${userId}/${tweetId}/${encodeURIComponent(name)}`;
        }
        if (typeof tweetData.user_profile_image_url === 'string' && tweetData.user_profile_image_url) {
            const mediaUrl = tweetData.user_profile_image_url;
            const name = `profile-${safeMediaFileName(mediaUrl)}`;
            await downloadToFile(mediaUrl, path.join(stage, name));
            tweetData.user_profile_image_url = `${PUBLIC_BASE_URL}${userId}/${tweetId}/${encodeURIComponent(name)}`;
        }
        const dataHandle = await fsp.open(path.join(stage, 'data.json'), 'wx', 0o644);
        try { await dataHandle.writeFile(JSON.stringify(tweetData, null, 4)); await dataHandle.sync(); } finally { await dataHandle.close(); }
        // The existing version is replaced, not counted twice. A rejected save
        // leaves it untouched and removes only this newly created staging tree.
        const resultingBytes = retainedBytes + await treeSize(stage);
        if (resultingBytes > quota) return { saved: false, reason: 'quota', tweetId };
        const journalHandle = await fsp.open(journal, 'w', 0o600);
        try { await journalHandle.writeFile(JSON.stringify({ target: tweetDir, stage, backup })); await journalHandle.sync(); } finally { await journalHandle.close(); }
        if (existing) await fsp.rename(tweetDir, backup);
        try { await fsp.rename(stage, tweetDir); installed = true; }
        catch (error) {
            if (existing && await pathExists(backup) && !await pathExists(tweetDir)) await fsp.rename(backup, tweetDir);
            throw error;
        }
        await fsp.unlink(journal);
        return { saved: true, tweetId, ...(existing ? { previousVersionReceipt: receipt } : {}) };
    } finally {
        if (!installed) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
        await lock.close(); await fsp.unlink(lockPath).catch(() => {});
    }
}

async function handle(interaction) {
    const tweetUrl = interaction.message.embeds[0].url;
    const result = await saveTweetByUrl(interaction.user.id, tweetUrl);
    if (!result.saved && result.reason === 'quota') {
        await interaction.editReply({
            content: 'Saved tweet quota exceeded. Delete old saved tweets before saving a new one.',
            ephemeral: true,
        });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
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
        safeMediaFileName,
    },
};
