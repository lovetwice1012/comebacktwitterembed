'use strict';

// Combine the X/UI acceptance matrix with the audit's complete notification,
// command and provider suites. Every SQL test uses an explicit disposable port.
const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveProjectNode } = require('./run-project-node.cjs');
const { files: xAcceptanceFiles } = require('./run-x-notification-acceptance.cjs');
const root = path.resolve(__dirname, '..');
const files = [...new Set([
    ...xAcceptanceFiles,
    'scripts/test/steam.parser.test.js',
    'scripts/test/webhook-destination.test.js',
    'scripts/test/recovery-bootstrap.test.js',
    'scripts/test/recovery-lease.test.js',
    ...readdirSync(path.join(root, 'scripts/test'))
        .filter(name => /^(?:automation-|autoWatch\.|autoextract\.|priceWatch\.|notification-|provider-saturation-).*\.test\.js$/.test(name))
        .map(name => `scripts/test/${name}`),
])].sort();

function main() {
    const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3306) {
        throw Error('Set an explicit disposable AUTOMATION_TEST_DB_PORT');
    }
    const report = process.env.SUPPORTER_READINESS_TEST_REPORT
        || 'docs/audits/supporter-readiness-remediation-2026-10-16-tests.xml';
    const progress = process.env.SUPPORTER_READINESS_PROGRESS_REPORT;
    const result = spawnSync(resolveProjectNode(), [
        '--test', '--test-concurrency=1', '--test-reporter=junit', `--test-reporter-destination=${report}`,
        ...(progress ? ['--test-reporter=spec', `--test-reporter-destination=${progress}`] : []), ...files,
    ], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
}

module.exports = { files: Object.freeze(files) };
if (require.main === module) main();
