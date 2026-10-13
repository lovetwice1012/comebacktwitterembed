import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { parseConfig, stringifyConfig, saveConfig, loadConfig, getWebhookEndpoint } from '../dist/config.js';
import { runCli, parseCli } from '../dist/cli.js';
import { main } from '../dist/index.js';
import { AngelicAngelError } from '../dist/errors.js';
const dummy = { twitter: { auth_token: 'DUMMY_AUTH_TOKEN_NEVER_LOG', ct0: 'DUMMY_CT0_NEVER_LOG' } };
function output() { let text = ''; return { stream: new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } }), text: () => text }; }
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'angelic-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('TOML schema preserves mandatory strings, optional registration, arbitrary byte arrays and ignores unknown fields as serde', () => {
  assert.deepEqual(parseConfig(stringifyConfig(dummy)), dummy);
  const config = { ...dummy, registration: { endpoint: 'https://push.example.invalid/test-only', autopush: { uaid: 'dummy', channel_id: 'dummy-channel' }, keys: { public_key: [0, 255], private_key: [], auth_secret: [7] } } };
  assert.deepEqual(parseConfig(stringifyConfig(config)), config);
  assert.deepEqual(parseConfig('[twitter]\nauth_token="a"\nct0="b"\nignored=123'), { twitter: { auth_token: 'a', ct0: 'b' } });
});
for (const input of ['', '[twitter]\nauth_token="SECRET_ERROR"', '[twitter]\nauth_token=1\nct0="x"', '[twitter]\nauth_token="x"\nct0="x"\n[registration]\nendpoint="x"', '[twitter]\nauth_token="x"\nct0="x"\n[registration]\nendpoint="x"\n[registration.autopush]\nuaid="x"\nchannel_id="x"\n[registration.keys]\npublic_key=[256]\nprivate_key=[]\nauth_secret=[]']) {
  test('invalid TOML rejects without reflecting source secrets', () => {
    assert.throws(() => parseConfig(input), error => error instanceof AngelicAngelError && error.code === 'Toml' && !error.message.includes('SECRET_ERROR'));
  });
}
test('atomic config save retains recoverable original and restart state', async t => {
  const dir = await directory(t), path = join(dir, 'config.toml');
  await saveConfig(dummy, path);
  const updated = { twitter: { ...dummy.twitter, ct0: 'updated-dummy' } };
  await saveConfig(updated, path);
  assert.deepEqual(await loadConfig(path), updated);
  const backup = (await readdir(dir)).find(name => name.includes('.bak-'));
  assert.ok(backup);
  assert.deepEqual(parseConfig(await readFile(join(dir, backup), 'utf8')), dummy);
  assert.equal((await readdir(dir)).filter(name => name.includes('.tmp-')).length, 0);
});
test('file read and write failures have separate typed errors', async t => {
  const dir = await directory(t);
  await assert.rejects(loadConfig(join(dir, 'missing')), { code: 'Config' });
  await mkdir(join(dir, 'occupied'));
  await assert.rejects(saveConfig(dummy, join(dir, 'occupied')), { code: 'Io' });
});
test('WEBHOOK_ENDPOINT absence and empty string preserve Rust environment semantics', () => {
  assert.throws(() => getWebhookEndpoint({}), { code: 'Config' });
  assert.equal(getWebhookEndpoint({ WEBHOOK_ENDPOINT: '' }), '');
});
test('CLI complete subcommands and option parsing, per-command help', () => {
  for (const command of ['init','register','listen','status','unregister']) assert.equal(parseCli(['-v','-c','dummy.toml',command]).command, command);
  assert.deepEqual(parseCli(['--config=path','init','--auth-token=a=b','--ct0','c']), { config: 'path', verbose: false, command: 'init', authToken: 'a=b', ct0: 'c' });
  for (const command of ['init','register','listen','status','unregister']) assert.match(parseCli([command, '--help']).help, new RegExp(`Usage: angelic-angel ${command}`));
  for (const args of [[], ['unknown'], ['--config'], ['listen','--verbose'], ['init','--ct0'], ['init','--ct0','a','--ct0','b']]) assert.throws(() => parseCli(args));
});
test('CLI init and status redact every credential and registration secret even verbose', async t => {
  const dir = await directory(t), path = join(dir,'config.toml'), out = output(), err = output();
  assert.equal(await runCli(['-c',path,'init','--auth-token',dummy.twitter.auth_token,'--ct0',dummy.twitter.ct0], { stdout: out.stream, stderr: err.stream }), 0);
  assert.equal(await runCli(['-v','-c',path,'status'], { stdout: out.stream, stderr: err.stream }), 0);
  assert.ok(!err.text().includes(dummy.twitter.auth_token)); assert.ok(!err.text().includes(dummy.twitter.ct0));
  assert.match(err.text(), /not registered/); assert.equal(out.text(), '');
});
test('CLI argument/error exits, missing status is successful and legacy registration remains opt-in', async t => {
  const dir = await directory(t), path = join(dir,'config.toml'), err = output();
  assert.equal(await runCli([], { stderr: err.stream }), 2);
  assert.equal(await runCli(['-c',path,'status'], { stderr: err.stream }), 0);
  assert.equal(await runCli(['-c',path,'listen'], { stderr: err.stream }), 1);
  await saveConfig(dummy,path);
  assert.equal(await runCli(['-c',path,'listen'], { stderr: err.stream }), 1);
  assert.equal(await runCli(['-c',path,'unregister'], { stderr: err.stream }), 1);
  assert.equal(await runCli(['-c',path,'register'], { env: {}, stderr: err.stream }), 1);
  assert.match(err.text(), /legacy X registration is disabled/);
  assert.deepEqual(await loadConfig(path),dummy);
});
test('interactive init prompts only missing arguments and abort propagates cleanly', async t => {
  const dir = await directory(t), path = join(dir, 'config.toml'), asked = [], err = output();
  assert.equal(await runCli(['-c',path,'init','--ct0','dummy'], { stderr: err.stream, prompt: async label => { asked.push(label); return 'dummy'; } }),0);
  assert.deepEqual(asked,['auth_token']);
  const pending = main(['-c',path,'init'], { stderr: err.stream, prompt: (_label, signal) => new Promise((_resolve,reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  process.emit('SIGINT');
  assert.equal(await pending,0); assert.match(err.text(),/Interrupted/);
});
test('built JavaScript CLI launches without Rust or TypeScript runtime', () => {
  const result = spawnSync(process.execPath,['dist/index.js','--help'],{ encoding:'utf8' });
  assert.equal(result.status,0); assert.match(result.stdout,/Twitter|receiving tweet/); assert.equal(result.stderr,'');
  const invalid = spawnSync(process.execPath,['dist/index.js','--does-not-exist'],{ encoding:'utf8' });
  assert.equal(invalid.status,2);
});
