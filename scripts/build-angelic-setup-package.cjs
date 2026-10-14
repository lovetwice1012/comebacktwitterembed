'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'client', 'angelic-setup');
const FILES = Object.freeze(['LICENSE', 'README-ja.md', 'Setup-XNotifications.ps1', 'Start-Setup.ps1', 'FirefoxReader.ps1', 'Export-XNotificationData.ps1', 'Read-PushSubscription.js', 'はじめに読んでください.txt', 'ダブルクリックで開始.cmd']);
const VERSION = '0.1.0-preview.4';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function rejectLinks(target) {
    let current = path.resolve(target);
    for (;;) {
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}

async function buildArchive({ source = SOURCE } = {}) {
    const directory = path.resolve(source);
    await rejectLinks(directory);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('The package source must be a directory.');
    // Exact allowlist: never recurse into profiles, .env, keys or the checkout.
    const entries = {}, hashes = {};
    for (const name of FILES) {
        const filename = path.join(directory, name);
        await rejectLinks(filename);
        const stat = await fs.lstat(filename);
        if (!stat.isFile()) throw new Error('A package source is not a regular file.');
        if (!stat.size || stat.size > 1024 * 1024) throw new Error('A package source has an invalid size.');
        const handle = await fs.open(filename, 'r');
        let bytes;
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || !opened.size || opened.size > 1024 * 1024) throw new Error('A package source has an invalid size.');
            // Keep reads bounded even if a file grows after the size check.
            const buffer = Buffer.alloc(opened.size + 1);
            let size = 0;
            while (size < buffer.length) {
                const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
                if (!bytesRead) break;
                size += bytesRead;
            }
            if (size !== opened.size) throw new Error('A package source changed while being read.');
            await rejectLinks(filename);
            bytes = buffer.subarray(0, size);
        } finally { await handle.close(); }
        hashes[name] = sha256(bytes);
        entries[name] = bytes;
    }
    const manifest = {
        schemaVersion: 1, packageId: 'x-notification-setup', version: VERSION,
        capabilities: { prepareProfile: true, openFirefox: true, realPushExport: true, serverTransfer: false },
        files: hashes,
    };
    entries['package-manifest.json'] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const zipped = Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [bytes, { mtime: new Date(2020, 0, 1, 0, 0, 0) }]]));
    const archive = Buffer.from(zipSync(zipped, { level: 9 })), digest = sha256(archive);
    return { archive, sha256: digest, bytes: archive.length, version: VERSION, manifest };
}

async function buildPackage({ source = SOURCE, output = path.join(ROOT, 'artifacts', 'angelic-setup', `x-notification-setup-${VERSION}.zip`) } = {}) {
    const destination = path.resolve(output), sidecar = `${destination}.sha256`;
    if (path.extname(destination).toLowerCase() !== '.zip') throw new Error('The output must be a new .zip file.');
    await rejectLinks(destination);
    await rejectLinks(sidecar);
    for (const filename of [destination, sidecar]) {
        try { await fs.lstat(filename); throw new Error('An output already exists. Choose a new output path.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const { archive, sha256: digest, bytes, version, manifest } = await buildArchive({ source });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await rejectLinks(destination);
    // Exclusive creation never replaces a previous release or checksum.
    await fs.writeFile(destination, archive, { flag: 'wx' });
    await fs.writeFile(sidecar, `${digest}  ${path.basename(destination)}\n`, { flag: 'wx' });
    return { path: destination, checksumPath: sidecar, sha256: digest, bytes, version, manifest };
}

async function main(argv) {
    if (argv.length && (argv.length !== 2 || argv[0] !== '--output')) throw new Error('Usage: node scripts/build-angelic-setup-package.cjs [--output NEW.zip]');
    const result = await buildPackage(argv.length ? { output: argv[1] } : {});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Package build failed. Check the source files and choose a new, non-linked output path.\n');
    process.exitCode = 1;
});
module.exports = { buildArchive, buildPackage, FILES, VERSION, rejectLinks };
