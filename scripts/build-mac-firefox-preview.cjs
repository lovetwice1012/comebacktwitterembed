'use strict';

// Local unsigned preview only. This does not sign, notarize or publish.
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildMacFirefoxPreview, readInput } = require('./build-mac-chrome-preview.cjs');

async function main(args) {
    if (args.length !== 6) throw new Error('Invalid preview inputs');
    const [arch, runtimePath, launcherPath, helperPath, licensePath, outputPath] = args;
    if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.zip') throw new Error('Invalid output');
    const [runtime, launcher, helper, license] = await Promise.all([readInput(runtimePath, 150 * 1024 * 1024),
        readInput(launcherPath, 4 * 1024 * 1024), readInput(helperPath, 4 * 1024 * 1024), readInput(licensePath, 1024 * 1024)]);
    const result = await buildMacFirefoxPreview({ arch, runtime, launcher, helper, license });
    await fs.writeFile(outputPath, result.archive, { flag: 'wx' });
    await fs.writeFile(`${outputPath}.sha256`, `${result.sha256}  ${path.basename(outputPath)}\n`, { flag: 'wx' });
    process.stdout.write(JSON.stringify({ path: outputPath, sha256: result.sha256, arch, version: result.version, signed: false }) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('Mac Firefox preview build failed. No release was published.\n'); process.exitCode = 1; });
module.exports = { main };
