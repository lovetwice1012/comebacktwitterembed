'use strict';

// Local setup helper. The parent must establish ownership, stop the dedicated
// profile and create a protected snapshot before invoking this process. The
// Keychain password arrives through the private stdin pipe, never argv or env.
// A successful stdout response contains sensitive transfer data; the parent
// must capture it privately and save it only after the user's confirmation.
// This helper opens no network connection and never uploads the result.
const { ClassicLevel } = require('classic-level');
const { readChromeSnapshot } = require('../src/automation/chrome-snapshot-io');
const { parseUniqueJson } = require('../src/automation/strict-json');

async function main() {
    const chunks = []; let size = 0, encoded, password;
    try {
        for await (const chunk of process.stdin) {
            size += chunk.length;
            if (size > 32768) throw new Error('X_CHROME_READER_INPUT_INVALID');
            chunks.push(chunk);
        }
        encoded = Buffer.concat(chunks);
        const input = parseUniqueJson(encoded.toString('utf8'), 64);
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).sort().join(',') !== 'browserVersion,macPassword,snapshotPath,subscription,token'
            || typeof input.macPassword !== 'string' || !/^[A-Za-z0-9_-]{2,5462}$/.test(input.macPassword))
            throw new Error('X_CHROME_READER_INPUT_INVALID');
        password = Buffer.from(input.macPassword, 'base64url');
        if (!password.length || password.length > 4096 || password.toString('base64url') !== input.macPassword)
            throw new Error('X_CHROME_READER_INPUT_INVALID');
        const result = await readChromeSnapshot({ snapshotPath: input.snapshotPath, token: input.token,
            subscription: input.subscription, browserVersion: input.browserVersion, platform: 'macos', macPassword: password,
            parseJson: text => parseUniqueJson(text, 64),
            dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' }) });
        process.stdout.write(JSON.stringify({ ok: true, ...result }));
    } finally {
        password?.fill(0); encoded?.fill(0); for (const chunk of chunks) chunk.fill(0);
    }
}
main().catch(error => {
    const code = /^X_CHROME_(?:READER|SNAPSHOT)_[A-Z_]+$/.test(String(error?.code || error?.message || ''))
        ? String(error.code || error.message) : 'X_CHROME_READER_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, errorCode: code })); process.exitCode = 1;
});
