'use strict';

// This entry point is run only inside the OS resource sandbox. Nothing is
// fetched until its bounded input has been received from the parent.
const { fetchSource } = require('./index');
process.stdout.write('READY\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    input += chunk;
    if (Buffer.byteLength(input) > 2 * 1024 * 1024) process.exit(2);
});
process.stdin.on('end', async () => {
    try {
        if (process.platform === 'linux') {
            try { require('./isolation_linux').enforceCgroup(512 * 1024 * 1024); }
            catch { throw Object.assign(new Error('The OS acquisition sandbox is unavailable.'), {
                code: 'AUTO_WATCH_ISOLATION_UNAVAILABLE', retryAfterMs: 300000,
            }); }
        }
        const { source, config } = JSON.parse(input);
        const result = await fetchSource(source, { config, isolate: false });
        process.stdout.write(JSON.stringify({ result }));
    } catch (error) {
        process.stdout.write(JSON.stringify({ error: {
            code: error.code || 'AUTO_WATCH_UPSTREAM_ERROR',
            message: String(error.message || 'Provider acquisition failed.').slice(0, 512),
            status: error.status, retryAfterMs: error.retryAfterMs,
        } }));
    }
});
