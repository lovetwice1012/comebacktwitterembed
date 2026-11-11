'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zipSync } = require('fflate');
const { rejectLinks } = require('./build-angelic-setup-package.cjs');
const { buildChromeBundles } = require('./build-chrome-setup-bundles.cjs');
const { resolveProjectNode, NODE_EXE_SHA256 } = require('./run-project-node.cjs');
const ROOT = path.resolve(__dirname, '..'), SOURCE = path.join(ROOT, 'client', 'angelic-setup');
const VERSION = '0.1.0-edge-preview.8';
const SOURCES = Object.freeze({ 'EdgeShared.ps1': 'EdgeShared.ps1', 'EdgeSetup.ps1': 'EdgeSetup.ps1', 'Start-EdgeSetup.ps1': 'Start-EdgeSetup.ps1',
    'EdgeSnapshot.ps1': 'EdgeSnapshot.ps1', 'EdgeExport.ps1': 'EdgeExport.ps1', 'EdgeCalibration.ps1': 'EdgeCalibration.ps1',
    'EdgeCalibrationJob.ps1': 'EdgeCalibrationJob.ps1', 'EdgeEphemeralCertificate.ps1': 'EdgeEphemeralCertificate.ps1',
    'EdgePeerIdentity.ps1': 'EdgePeerIdentity.ps1', 'EdgePeerVerify.ps1': 'EdgePeerVerify.ps1', 'NativeSetup.ps1': 'FirefoxReader.ps1',
    'はじめに.txt': 'Edge-はじめに.txt', 'Edgeで開始.cmd': 'Edgeで開始.cmd', LICENSE: 'LICENSE' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function readFile(filename, limit) {
    await rejectLinks(filename); const handle = await fs.open(filename, 'r');
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw new Error('Invalid package input');
        const data = await handle.readFile(); if (data.length !== stat.size) throw new Error('Package input changed'); await rejectLinks(filename); return data;
    } finally { await handle.close(); }
}
async function buildArchive({ source = SOURCE, nodeExecutable = resolveProjectNode() } = {}) {
    const sourceRoot = path.resolve(source); await rejectLinks(sourceRoot); const entries = {};
    for (const [name, sourceName] of Object.entries(SOURCES)) entries[name] = await readFile(path.join(sourceRoot, sourceName), 1024 * 1024);
    Object.assign(entries, await buildChromeBundles({ includeEdge: true }));
    entries['ChromeNode.exe'] = await readFile(path.resolve(nodeExecutable), 100 * 1024 * 1024);
    if (hash(entries['ChromeNode.exe']) !== NODE_EXE_SHA256) throw new Error('Node runtime checksum mismatch');
    entries['ChromeNode-LICENSE.txt'] = await readFile(path.join(path.dirname(nodeExecutable), 'LICENSE'), 1024 * 1024);
    const files = Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, hash(data)]));
    const manifest = { schemaVersion: 1, packageId: 'x-notification-edge-setup', version: VERSION, files };
    entries['package-manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const layout = Object.fromEntries(Object.entries(entries).map(([name, data]) => [`_app/${name}`, data]));
    layout['はじめに.txt'] = entries['はじめに.txt'];
    const launcher = entries['Edgeで開始.cmd'].toString('utf8');
    if (!launcher.includes('%~dp0Start-EdgeSetup.ps1')) throw new Error('Launcher entry missing');
    layout['Edgeで開始.cmd'] = Buffer.from(launcher.replace('%~dp0Start-EdgeSetup.ps1', '%~dp0_app\\Start-EdgeSetup.ps1'), 'utf8');
    const zipped = Object.fromEntries(Object.entries(layout).map(([name, data]) => [name, [data, { mtime: new Date(2020, 0, 1) }]]));
    const archive = Buffer.from(zipSync(zipped, { level: 6 })); return { archive, manifest, sha256: hash(archive), version: VERSION };
}
async function buildPackage({ output = path.join(ROOT, 'artifacts', 'angelic-setup', `edge-setup-${VERSION}.zip`), ...options } = {}) {
    const destination = path.resolve(output), checksum = `${destination}.sha256`;
    if (path.extname(destination).toLowerCase() !== '.zip') throw new Error('Output must be a ZIP');
    await rejectLinks(destination); await rejectLinks(checksum);
    for (const name of [destination, checksum]) { try { await fs.lstat(name); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const built = await buildArchive(options); await fs.mkdir(path.dirname(destination), { recursive: true }); await rejectLinks(destination); await rejectLinks(checksum);
    await fs.writeFile(destination, built.archive, { flag: 'wx' }); await fs.writeFile(checksum, `${built.sha256}  ${path.basename(destination)}\n`, { flag: 'wx' });
    return { path: destination, checksumPath: checksum, sha256: built.sha256, bytes: built.archive.length, version: VERSION };
}
if (require.main === module) buildPackage(process.argv.length === 4 && process.argv[2] === '--output' ? { output: process.argv[3] } : {})
    .then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => { process.stderr.write('Edge setup package build failed.\n'); process.exitCode = 1; });
module.exports = { buildArchive, buildPackage, SOURCES, VERSION };
