'use strict';

// Invoked only by the local setup tool. Input arrives through stdin and output
// is captured by that tool; there is no network or upload operation here.
const { ClassicLevel } = require('classic-level');
const { readChromeSnapshot } = require('../src/automation/chrome-snapshot-io');
const { parseUniqueJson } = require('../src/automation/strict-json');

async function main() {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 32768) throw new Error('X_CHROME_READER_INPUT_INVALID');
        chunks.push(chunk);
    }
    const input = parseUniqueJson(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || !['browserVersion,profileKey,snapshotPath,subscription,token', 'browserVersion,engineVersion,profileKey,snapshotPath,subscription,token'].includes(Object.keys(input).sort().join(','))
        || typeof input.profileKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.profileKey)) throw new Error('X_CHROME_READER_INPUT_INVALID');
    const profileKey = Buffer.from(input.profileKey, 'base64url');
    if (profileKey.length !== 32 || profileKey.toString('base64url') !== input.profileKey) throw new Error('X_CHROME_READER_INPUT_INVALID');
    try {
        const result = await readChromeSnapshot({ snapshotPath: input.snapshotPath, token: input.token,
            subscription: input.subscription, browserVersion: input.browserVersion, engineVersion: input.engineVersion,
            unprotect: async () => Buffer.from(profileKey), parseJson: text => parseUniqueJson(text, 64),
            dbFactory: location => new ClassicLevel(location, { createIfMissing: false, keyEncoding: 'utf8', valueEncoding: 'buffer' }) });
        process.stdout.write(JSON.stringify({ ok: true, ...result }));
    } finally { profileKey.fill(0); }
}
main().catch(error => {
    // Only fixed codes cross the process boundary; never print source paths,
    // encrypted secrets, decrypted credentials or an exception stack.
    const code = /^X_CHROME_(?:READER|SNAPSHOT)_[A-Z_]+$/.test(String(error?.code || error?.message || ''))
        ? String(error.code || error.message) : 'X_CHROME_READER_FAILED';
    process.stdout.write(JSON.stringify({ ok: false, errorCode: code }));
    process.exitCode = 1;
});
