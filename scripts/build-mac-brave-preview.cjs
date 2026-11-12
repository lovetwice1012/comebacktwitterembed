'use strict';

// Builds an unsigned, experimental candidate only. This does not sign,
// notarize, publish, or overwrite a previously created archive.
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildMacBravePreview, readInput } = require('./build-mac-chrome-preview.cjs');

async function main(args) {
    if (args.length !== 6) throw new Error('Expected arch, Node executable, launcher, lock helper, Node license, output ZIP');
    const [arch, runtimePath, launcherPath, helperPath, licensePath, outputPath] = args;
    if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.zip') throw new Error('Output must be an absolute ZIP path');
    const [runtime, launcher, helper, license] = await Promise.all([readInput(runtimePath, 150 * 1024 * 1024), readInput(launcherPath, 4 * 1024 * 1024),
        readInput(helperPath, 4 * 1024 * 1024), readInput(licensePath, 1024 * 1024)]);
    const result = await buildMacBravePreview({ arch, runtime, launcher, helper, license });
    await fs.writeFile(outputPath, result.archive, { flag: 'wx' });
    await fs.writeFile(`${outputPath}.sha256`, `${result.sha256}  ${path.basename(outputPath)}\n`, { flag: 'wx' });
    process.stdout.write(JSON.stringify({ path: outputPath, sha256: result.sha256, arch, version: result.version, signed: false }) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('Mac Brave preview build failed. No release was published.\n'); process.exitCode = 1; });
module.exports = { main };
