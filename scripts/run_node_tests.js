'use strict';

const { spawnSync } = require('child_process');

process.env.NODE_ENV = 'test';

const result = spawnSync(process.execPath, ['--test', 'scripts/test/**/*.test.js'], {
    stdio: 'inherit',
    env: process.env,
});

if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
} else {
    process.exitCode = result.status ?? 1;
}
