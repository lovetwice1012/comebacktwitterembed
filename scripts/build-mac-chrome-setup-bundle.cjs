'use strict';

// Build the JavaScript portion of the future Mac distribution. A packaged
// Node runtime, the native lock helper, app bundle and signing are separate.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const { isUniversalMacAddon } = require('./lib/mac-macho.cjs');
const root = path.resolve(__dirname, '..');
const LEVELDB_SHA256 = 'e311fd4aadf58e151dcb19b0144fbbb468ef08fb73d77bca806e7320725ef26c';

async function buildMacBundle(entry) {
    if (!['chrome-mac-app.cjs', 'brave-mac-app.cjs', 'brave-mac-release-app.cjs', 'firefox-mac-app.cjs', 'firefox-mac-release-app.cjs', 'edge-mac-release-app.cjs'].includes(entry)) throw new Error('Unsupported Mac bundle');
    const binding = { name: 'flat-mac-leveldb', setup(build) {
        build.onResolve({ filter: /^\.\/binding$/ }, args => /[\\/]classic-level[\\/][^\\/]+\.js$/.test(args.importer)
            ? { path: 'binding', namespace: 'mac-level-binding' } : undefined);
        build.onLoad({ filter: /.*/, namespace: 'mac-level-binding' }, () => ({ contents:
            "module.exports = require(require('node:path').join(__dirname, '..', 'MacOS', 'MacLevelDB.node'));", loader: 'js' }));
    } };
    const result = await esbuild.build({ entryPoints: [path.join(__dirname, entry)], absWorkingDir: root,
        bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
        legalComments: 'inline', plugins: [binding], metafile: true });
    if (result.outputFiles.length !== 1 || result.outputFiles[0].contents.length > 4 * 1024 * 1024)
        throw new Error('Unexpected Mac helper bundle');
    const pkgPath = require.resolve('classic-level/package.json', { paths: [root] });
    if (path.relative(root, pkgPath).startsWith('..')) throw new Error('Dependencies must come from this checkout');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (pkg.version !== '3.0.0') throw new Error('Unexpected LevelDB version');
    const addon = await fs.readFile(path.join(path.dirname(pkgPath), 'prebuilds', 'darwin-x64+arm64', 'classic-level.node'));
    if (!addon.length || addon.length > 4 * 1024 * 1024 || !isUniversalMacAddon(addon)
        || createHash('sha256').update(addon).digest('hex') !== LEVELDB_SHA256) throw new Error('Mac LevelDB addon verification failed');
    const dependencyRoots = new Set([path.dirname(pkgPath)]);
    for (const input of Object.keys(result.metafile.inputs)) {
        if (input.startsWith('mac-level-binding:')) continue;
        const segments = path.resolve(root, input).split(path.sep), index = segments.lastIndexOf('node_modules');
        if (index < 0 || !segments[index + 1]) continue;
        dependencyRoots.add(segments.slice(0, segments[index + 1].startsWith('@') ? index + 3 : index + 2).join(path.sep));
    }
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8')), notices = [];
    for (const directory of [...dependencyRoots].sort()) {
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
        const relative = path.relative(root, directory).split(path.sep).join('/');
        if (relative.startsWith('../') || !lock.packages[relative] || lock.packages[relative].version !== manifest.version)
            throw new Error(`Dependency lock mismatch: ${manifest.name}`);
        const license = (await fs.readdir(directory)).find(name => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(name));
        if (!license) throw new Error(`Missing dependency license: ${manifest.name}`);
        notices.push(`===== ${manifest.name} ${manifest.version} =====\n${await fs.readFile(path.join(directory, license), 'utf8')}\n`);
    }
    return { 'MacSetup.cjs': Buffer.from(result.outputFiles[0].contents), 'MacLevelDB.node': addon,
        'MacDependencies-LICENSE.txt': Buffer.from(notices.join('\n'), 'utf8') };
}
const buildMacChromeBundle = () => buildMacBundle('chrome-mac-app.cjs');
const buildMacBraveBundle = () => buildMacBundle('brave-mac-app.cjs');
const buildMacBraveReleaseBundle = () => buildMacBundle('brave-mac-release-app.cjs');
const buildMacFirefoxBundle = () => buildMacBundle('firefox-mac-app.cjs');
const buildMacFirefoxReleaseBundle = () => buildMacBundle('firefox-mac-release-app.cjs');
const buildMacEdgeReleaseBundle = () => buildMacBundle('edge-mac-release-app.cjs');
module.exports = { buildMacChromeBundle, buildMacBraveBundle, buildMacBraveReleaseBundle, buildMacFirefoxBundle, buildMacFirefoxReleaseBundle, buildMacEdgeReleaseBundle, LEVELDB_SHA256 };
