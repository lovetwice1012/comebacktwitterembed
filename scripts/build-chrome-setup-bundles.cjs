'use strict';

// Builds local-only helper programs and a pinned Windows LevelDB addon for the
// setup ZIP. Node itself is supplied separately and verified by the packager.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
async function buildChromeBundles({ nodePaths = [], includeEdge = false } = {}) {
    if (typeof includeEdge !== 'boolean') throw new Error('Invalid bundle selection');
    const outputs = {}, dependencyRoots = new Set();
    const levelBinding = { name: 'flat-windows-leveldb', setup(build) {
        build.onResolve({ filter: /^\.\/binding$/ }, args => /[\\/]classic-level[\\/][^\\/]+\.js$/.test(args.importer)
            ? { path: 'binding', namespace: 'chrome-level-binding' } : undefined);
        build.onLoad({ filter: /.*/, namespace: 'chrome-level-binding' }, () => ({ contents:
            "module.exports = require(require('node:path').join(__dirname, 'ChromeLevelDB.node'));", loader: 'js' }));
    } };
    const entries = [['ChromeBroker.cjs', 'chrome-setup-broker.cjs'], ['ChromeCapture.cjs', 'chrome-setup-capture.cjs'], ['ChromeReader.cjs', 'chrome-setup-reader.cjs']];
    if (includeEdge) entries.push(['EdgeReader.cjs', 'edge-setup-reader.cjs'], ['EdgeBroker.cjs', 'edge-setup-broker.cjs'], ['EdgeCapture.cjs', 'edge-setup-capture.cjs']);
    for (const [name, entry] of entries) {
        const result = await esbuild.build({ entryPoints: [path.join(__dirname, entry)], absWorkingDir: root,
            bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', nodePaths,
            logLevel: 'silent', legalComments: 'inline', plugins: [levelBinding], metafile: true });
        if (result.outputFiles.length !== 1 || result.outputFiles[0].contents.length > 4 * 1024 * 1024) throw new Error('Unexpected helper bundle');
        outputs[name] = Buffer.from(result.outputFiles[0].contents);
        for (const input of Object.keys(result.metafile.inputs)) {
            if (input.startsWith('chrome-level-binding:')) continue;
            const segments = path.resolve(root, input).split(path.sep), index = segments.lastIndexOf('node_modules');
            if (index < 0 || !segments[index + 1]) continue;
            const end = segments[index + 1].startsWith('@') ? index + 3 : index + 2;
            dependencyRoots.add(segments.slice(0, end).join(path.sep));
        }
    }
    const pkgPath = require.resolve('classic-level/package.json', { paths: [root, ...nodePaths] });
    if (path.relative(root, pkgPath).startsWith('..')) throw new Error('Dependencies must come from this checkout');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    if (pkg.version !== '3.0.0') throw new Error('Unexpected LevelDB addon version');
    const addon = await fs.readFile(path.join(path.dirname(pkgPath), 'prebuilds', 'win32-x64', 'classic-level.node'));
    if (!addon.length || addon.length > 4 * 1024 * 1024) throw new Error('Invalid LevelDB addon');
    if (createHash('sha256').update(addon).digest('hex') !== '3537a4724d84912b85ff873d0e4f2665580ba7bc917d4f19aa2ed164a76ea7cf') throw new Error('LevelDB addon checksum mismatch');
    outputs['ChromeLevelDB.node'] = addon;
    dependencyRoots.add(path.dirname(pkgPath));
    const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const notices = [];
    for (const directory of [...dependencyRoots].sort()) {
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
        const relative = path.relative(root, directory).split(path.sep).join('/');
        if (relative.startsWith('../') || !lock.packages[relative] || lock.packages[relative].version !== manifest.version)
            throw new Error(`Dependency lock mismatch: ${manifest.name}`);
        const names = await fs.readdir(directory);
        const license = names.find(name => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(name));
        if (!license) throw new Error(`Missing dependency license: ${manifest.name}`);
        notices.push(`===== ${manifest.name} ${manifest.version} =====\n${await fs.readFile(path.join(directory, license), 'utf8')}\n`);
    }
    outputs['ChromeDependencies-LICENSE.txt'] = Buffer.from(notices.join('\n'), 'utf8');
    return outputs;
}
module.exports = { buildChromeBundles };
