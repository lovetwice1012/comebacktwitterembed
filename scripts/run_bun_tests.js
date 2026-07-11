'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const testDir = path.join(__dirname, 'test');
const files = fs.readdirSync(testDir)
    .filter(name => name.endsWith('.test.js'))
    .sort()
    .map(name => path.join('scripts', 'test', name));

let failedFiles = 0;
for (const file of files) {
    const result = spawnSync(process.execPath, ['test', file, '--only-failures'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: 'inherit',
        windowsHide: true,
    });
    if (result.status === 0) continue;
    failedFiles++;
    console.error('[test:bun] Failed:', file);
}

if (failedFiles > 0) {
    console.error('[test:bun] ' + failedFiles + '/' + files.length + ' test files failed.');
    process.exitCode = 1;
} else {
    console.log('[test:bun] All ' + files.length + ' test files passed.');
}
