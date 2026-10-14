const { spawn, execFileSync } = require('node:child_process');
const { writeFileSync, mkdirSync, createWriteStream, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const os = require('node:os');

const count = Number(process.argv[2] || 1000);
const concurrency = Number(process.argv[3] || 2);
if (!Number.isSafeInteger(count) || count < 1 || count > 3000 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('Bounded diagnostic arguments required');
const resultRoot = join(__dirname, `results-${process.version}-${Date.now()}`);
mkdirSync(resultRoot);
const log = createWriteStream(join(resultRoot, 'iterations.ndjson'), { flags: 'wx' });
const failures = [];
let next = 0;
let completed = 0;
const startedAt = new Date().toISOString();
async function worker() {
  while (next < count) {
    const index = next++;
    await new Promise(resolve => {
      const started = Date.now();
      const child = spawn(process.execPath, ['--test', '--test-timeout=10000', '--test-reporter=tap', join(__dirname, 'loopback-single.test.mjs')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let error = '';
      let timedOut = false;
      const timeout = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch (failure) {
          error += `Owned diagnostic tree timeout cleanup failed: ${failure.code}\n`;
        }
      }, 20000);
      child.stdout.on('data', bytes => output += bytes);
      child.stderr.on('data', bytes => error += bytes);
      child.on('error', failure => error += String(failure));
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        const iteration = { index, code, signal, timedOut, durationMs: Date.now() - started, nativeSignature: /3221226505/.test(output + error), eaddrinuse: /EADDRINUSE/.test(output + error) };
        if (code !== 0 || signal || timedOut) {
          failures.push(iteration);
          writeFileSync(join(resultRoot, `failure-${index}.tap`), output + '\nSTDERR\n' + error, { flag: 'wx' });
        }
        log.write(JSON.stringify(iteration) + '\n');
        completed++;
        if (completed % 100 === 0) process.stdout.write(JSON.stringify({ runtime: process.version, completed, count, failures: failures.length, nativeFailures: failures.filter(failure => failure.nativeSignature).length }) + '\n');
        resolve();
      });
    });
  }
}
Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
  const sha = name => createHash('sha256').update(readFileSync(join(__dirname, name))).digest('hex');
  const result = { startedAt, finishedAt: new Date().toISOString(), runtime: process.version, v8: process.versions.v8, libuv: process.versions.uv, executable: process.execPath, platform: process.platform, arch: process.arch, osRelease: os.release(), count, completed, concurrency, connectionsPerIteration: 1, debugged: false, useKeepAlive: false, timeoutMs: 20000, testTimeoutMs: 10000, fixtureSha256: sha('loopback-single.test.mjs'), harnessSha256: sha('run-single-stress.cjs'), passed: count - failures.length, failures };
  writeFileSync(join(resultRoot, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  log.end();
  process.stdout.write(JSON.stringify({ resultRoot, ...result }) + '\n');
});
