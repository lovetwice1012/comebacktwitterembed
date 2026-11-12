'use strict';
// The owner supplies an existing signing identity and notary profile on a Mac.
// This creates an unpublished candidate and does not change server settings.
const { buildEdgeCandidate, parseArgs } = require('./build-mac-chrome-release-candidate.cjs');
if (require.main === module) Promise.resolve().then(() => buildEdgeCandidate(parseArgs(process.argv.slice(2))))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { const stage = /^[a-z_]+$/.test(String(error?.stage || '')) ? ` stage=${error.stage}` : '';
        process.stderr.write(`${/^MAC_RELEASE_[A-Z_]+$/.test(String(error?.code || '')) ? error.code : 'MAC_RELEASE_FAILED'}${stage}\n`); process.exitCode = 1; });
module.exports = { buildEdgeCandidate };
