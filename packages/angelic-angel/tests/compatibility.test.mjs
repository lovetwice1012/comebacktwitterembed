/** Real differential tests: this file fails if the retained Rust binary is missing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { stripVTControlCharacters } from 'node:util';
import { WebSocketServer } from 'ws';
import { parseConfig, stringifyConfig, loadConfig, saveConfig } from '../dist/config.js';
import { parseResponse, serializeMessage, isPong, isBackoffClose, registerNew, unregister, connectAndListen, AckCode } from '../dist/autopush.js';
import { decryptEce, decodeBase64UrlNoPad, parseHeaderParam } from '../dist/crypto.js';
import { generateKeys } from '../dist/push.js';
import { calcBackoff, handleNotificationData, sendToWebhook } from '../dist/listener.js';
import { encryptFixture } from './fixtures/crypto-fixture-builder.mjs';
import { register as registerTwitter } from '../dist/legacy/twitter-registration.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const executableExtension = process.platform === 'win32' ? '.exe' : '';
const oraclePath = process.env.ANGELIC_RUST_ORACLE || join(packageRoot, 'compat-rust/target/debug/angelic-angel-rust-oracle' + executableExtension);
const baselinePath = process.env.ANGELIC_RUST_BASELINE || join(packageRoot, 'compat-rust/target/debug/angelic-angel-rust-baseline' + executableExtension);
const nodeCli = join(packageRoot, 'dist/index.js');
const cleanEnv = { ...process.env, NO_COLOR: '1', CLICOLOR: '0', FORCE_COLOR: '0', RUST_BACKTRACE: '0' };
for (const name of ['WEBHOOK_ENDPOINT', 'ANGELIC_ORACLE_WS_URL', 'ANGELIC_ORACLE_TWITTER_URL', 'ANGELIC_ANGEL_ALLOW_LEGACY_X', 'ANGELIC_AUTOPUSH_URL', 'ANGELIC_TWITTER_API_URL']) delete cleanEnv[name];

function rust(input, env = {}) {
  assert.ok(existsSync(oraclePath), 'Build compat-rust first; absence of a Rust oracle cannot pass G0.');
  return new Promise((resolveResult, reject) => {
    const child = spawn(oraclePath, [], { cwd: packageRoot, env: { ...cleanEnv, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Rust oracle timed out')); }, 15000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        // Rust ECE's known debug underflow is classified, never silently skipped.
        if (/attempt to subtract with overflow/u.test(stderr)) return resolveResult({ ok: false, panic: 'legacy-ece-underflow' });
        if (/ece-2\.3\.1/u.test(stderr) && /called `Result::unwrap\(\)` on an `Err` value/u.test(stderr)) {
          return resolveResult({ok:false,panic:'legacy-ece-invalid-key'});
        }
        return reject(new Error(`Rust oracle terminated with exit ${code}`));
      }
      try { resolveResult(JSON.parse(stdout.trim())); } catch { reject(new Error('Rust oracle produced invalid JSON')); }
    });
    child.stdin.end(JSON.stringify(input) + '\n');
  });
}
async function rustValue(input, env) {
  const result = await rust(input, env);
  assert.equal(result.ok, true, `Rust operation ${input.operation} failed: ${result.error || result.panic}`);
  return result.value;
}
function semanticConfig(value) {
  const clone = structuredClone(value);
  if (clone.registration == null) delete clone.registration;
  return clone;
}
function rejection(fn) {
  try { fn(); return false; } catch { return true; }
}
async function withHttp(handler, fn) {
  const server = createServer(handler);
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolveClosed => server.close(resolveClosed)); }
}
async function withWs(handler, fn) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolveReady => server.once('listening', resolveReady));
  server.on('connection', handler);
  try { return await fn(`ws://127.0.0.1:${server.address().port}/`); }
  finally {
    for (const client of server.clients) client.terminate();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
}

test('COMP-CONFIG: Rust-written TOML, Node-written TOML, exact types, unknown fields, real file IO', async () => {
  const keys = generateKeys();
  const configCases = [
    { twitter: { auth_token: 'dummy-token', ct0: 'dummy-csrf' } },
    { twitter: { auth_token: 'dummy\n日本語😀"token', ct0: '' }, registration: {
      endpoint: 'https://push.example.invalid/some/path', autopush: { uaid: 'dummy-uaid', channel_id: 'dummy-chid' }, keys,
    } },
    { twitter: { auth_token: '', ct0: 'dummy' }, registration: {
      endpoint: 'not-validated-by-Rust', autopush: { uaid: '', channel_id: '' },
      keys: { public_key: [], private_key: [0, 255], auth_secret: [1] },
    } },
  ];
  const directory = await mkdtemp(join(tmpdir(), 'angelic-compat-config-'));
  try {
    for (const [index, config] of configCases.entries()) {
      const rustToml = await rustValue({ operation: 'config_save', config });
      assert.deepEqual(parseConfig(rustToml), config, `Rust -> Node ${index}`);
      assert.deepEqual(semanticConfig(await rustValue({ operation: 'config_parse', toml: stringifyConfig(config) })), config, `Node -> Rust ${index}`);
      const rustFile = join(directory, `rust-${index}.toml`);
      await rustValue({ operation: 'config_write', config, path: rustFile });
      assert.deepEqual(await loadConfig(rustFile), config);
      const nodeFile = join(directory, `node-${index}.toml`);
      await saveConfig(config, nodeFile);
      assert.deepEqual(semanticConfig(await rustValue({ operation: 'config_load', path: nodeFile })), config);
    }
    const valid = '[twitter]\nauth_token="dummy"\nct0="dummy"\nunknown=123\n[other]\nignored=true\n';
    assert.deepEqual(parseConfig(valid), semanticConfig(await rustValue({ operation: 'config_parse', toml: valid })));
    for (const toml of ['', '[twitter]\nauth_token="dummy"', '[twitter]\nauth_token=1\nct0="dummy"', '[twitter]\nauth_token="dummy"\nct0="dummy"\n[registration]\nendpoint="dummy"',
      stringifyConfig(configCases[1]).replace(/public_key = \[[\s\S]*?\]/u, 'public_key = [-1]'),
      stringifyConfig(configCases[1]).replace(/public_key = \[[\s\S]*?\]/u, 'public_key = [256]')]) {
      const rustResult = await rust({ operation: 'config_parse', toml });
      assert.equal(rejection(() => parseConfig(toml)), !rustResult.ok, 'same TOML rejection');
    }
    const absent = join(directory, 'missing.toml');
    assert.equal((await rust({ operation: 'config_load', path: absent })).ok, false);
    await assert.rejects(loadConfig(absent));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('COMP-PROTOCOL: serde wire serialization and parsing, omission/defaults, rejected values', async () => {
  const messages = [
    { messageType: 'hello', uaid: '', use_webpush: true, broadcasts: {} },
    { messageType: 'hello', uaid: 'dummy', channelIDs: ['a', 'b'], use_webpush: false, broadcasts: { foo: 'bar' } },
    { messageType: 'hello', use_webpush: true, broadcasts: {} },
    { messageType: 'register', channelID: 'dummy', key: 'dummy-key' },
    { messageType: 'register', channelID: 'dummy' },
    { messageType: 'unregister', channelID: 'dummy', code: 200 },
    ...[100,101,102].map(code => ({ messageType: 'ack', updates: [{ channelID: 'dummy', version: 'v1', code }] })),
  ];
  for (const message of messages) assert.deepEqual(JSON.parse(serializeMessage(message)), await rustValue({ operation: 'protocol_serialize', message }));
  const responses = [
    { messageType:'hello',status:200,uaid:'dummy' },
    { messageType:'hello',status:200,uaid:'dummy',use_webpush:true,broadcasts:{channel:'version'},ignored:1 },
    { messageType:'hello',status:65535,uaid:'',use_webpush:null,broadcasts:null },
    { messageType:'register',status:200,pushEndpoint:'dummy',channelID:'dummy',ignored:true },
    { messageType:'notification',channelID:'dummy',version:'v1' },
    { messageType:'notification',channelID:'other',version:'v1',data:null,headers:null },
    { messageType:'notification',channelID:'dummy',version:'v2',data:'YWJj',headers:{encoding:'aes128gcm'} },
  ];
  for (const response of responses) {
    const text = JSON.stringify(response);
    assert.deepEqual(parseResponse(text), await rustValue({ operation:'protocol_parse',text }));
  }
  const invalidTexts = [
    'garbage', '[]', 'null', '{}', '{"messageType":"unknown"}',
    '{"messageType":"hello","status":200}',
    '{"messageType":"hello","status":-1,"uaid":"dummy"}',
    '{"messageType":"hello","status":65536,"uaid":"dummy"}',
    '{"messageType":"hello","status":200.0,"uaid":"dummy"}',
    '{"messageType":"hello","status":2e2,"uaid":"dummy"}',
    '{"messageType":"hello","status":200,"status":200,"uaid":"dummy"}',
    '{"messageType":"hello","status":200,"uaid":"dummy","uaid":"other"}',
    '{"messageType":"notification","channelID":"dummy","version":1}',
    '{"messageType":"notification","channelID":"dummy","version":"1","headers":{"encoding":1}}',
    '{"messageType":"register","status":200,"pushEndpoint":"dummy"}',
    '{"messageType":"hello","status":200,"uaid":"dummy","ignored":' + '['.repeat(128) + '0' + ']'.repeat(128) + '}',
  ];
  for (const text of invalidTexts) {
    const result = await rust({ operation:'protocol_parse',text });
    assert.equal(rejection(() => parseResponse(text)), !result.ok, `same response rejection: ${text}`);
  }
});

test('COMP-KEEPALIVE: pong object classification, 4774 close, saturating retry backoff, header extraction', async () => {
  for (const text of ['{}','{"ignored":1}','[]','null','"text"','bad','{"messageType":null}','{"messageType":"notification"}',
    '{"ignored":' + '['.repeat(128) + '0' + ']'.repeat(128) + '}',
    '{"ignored":"\\ud800","ignored":"ok"}', '{"ignored":1e400,"ignored":1}']) {
    assert.equal(isPong(text), await rustValue({ operation:'pong',text }));
  }
  for (const code of [null, 1000, 1001, 4774, 4775]) assert.equal(isBackoffClose(code), await rustValue({ operation:'backoff_close',code }));
  for (const count of [0,1,2,3,6,7,8,63,64,0xffffffff]) assert.equal(calcBackoff(count), await rustValue({ operation:'backoff',count }));
  for (const header of [null,'dh=abc;p256ecdsa=xyz',' x=y; dh= abc== ; other=x','dh=first;dh=second','dh=','wrong=abc','DH=abc','dh="abc"']) {
    const result = await rust({ operation:'header',header,name:'dh' });
    if (result.ok) assert.equal(parseHeaderParam(header ?? undefined, 'dh'), result.value);
    else assert.equal(rejection(() => parseHeaderParam(header ?? undefined, 'dh')), true);
  }
});

test('COMP-CRYPTO: P-256 key generation and bidirectional aes128gcm + legacy aesgcm ECE', async () => {
  const nodeKeys = generateKeys(), rustKeys = await rustValue({ operation:'keys' });
  for (const keys of [nodeKeys, rustKeys]) {
    assert.equal(keys.public_key.length,65); assert.equal(keys.private_key.length,32); assert.equal(keys.auth_secret.length,16);
    const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.from(keys.private_key));
    assert.deepEqual([...curve.getPublicKey()],keys.public_key);
    for (const encoding of ['aes128gcm','aesgcm']) for (const plaintext of [Buffer.from('{"dummy":"日本語😀"}'),Buffer.from('non-JSON dummy'),Buffer.from([0,1,2,255]),Buffer.alloc(3000,97)]) {
      const encrypted = await rustValue({ operation:'encrypt',keys,data:plaintext.toString('base64url'),encoding });
      assert.deepEqual(decryptEce(Buffer.from(encrypted.data,'base64url'),encrypted.headers,keys),plaintext, `Rust encryption -> Node ${encoding}`);
      const nodeEncrypted = encryptFixture(keys,plaintext,{ legacy:encoding === 'aesgcm' });
      assert.equal(await rustValue({ operation:'decrypt',keys,data:nodeEncrypted.data,headers:nodeEncrypted.headers }), plaintext.toString('base64url'), `Node encryption -> Rust ${encoding}`);
    }
  }
});

test('COMP-CRYPTO-GOLDEN: both implementations consume all identical success and corruption fixtures', async context => {
  const fixtures = JSON.parse(await readFile(join(packageRoot,'tests/fixtures/crypto-golden.json'),'utf8'));
  let panics = 0;
  for (const fixture of fixtures.cases) {
    const keys = fixture.keys ?? fixtures.keys;
    const result = await rust({ operation:'decrypt',keys,data:fixture.data,headers:fixture.headers ?? null });
    let actual;
    try { actual = decryptEce(decodeBase64UrlNoPad(fixture.data),fixture.headers,keys); }
    catch { /* The paired Rust result below must reject the same fixture. */ }
    if (fixture.expected_plaintext_hex !== undefined) {
      assert.equal(result.ok,true,fixture.id);
      assert.equal(Buffer.from(result.value,'base64url').toString('hex'),fixture.expected_plaintext_hex,fixture.id);
      assert.equal(actual?.toString('hex'),fixture.expected_plaintext_hex,fixture.id);
    } else {
      assert.equal(result.ok,false,fixture.id);
      assert.equal(actual,undefined,fixture.id);
      if (result.panic) panics++;
    }
  }
  // A corrupt legacy block must cause a controlled Node error even where the
  // retained Rust dependency panics in debug mode. This is an explicit delta.
  context.diagnostic(`${fixtures.cases.length} shared fixtures; ${panics} controlled Node rejections of retained Rust ECE debug underflow`);
});

test('COMP-KEY-EXCEPTIONS: compressed receiver keys work and malformed local keys become controlled Node errors', async () => {
  const keys = generateKeys(), plaintext = Buffer.from('dummy-key-fixture');
  const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.from(keys.private_key));
  const encrypted = encryptFixture(keys,plaintext);
  const compressedKeys = {...keys,public_key:[...curve.getPublicKey(undefined,'compressed')]};
  assert.equal(await rustValue({operation:'decrypt',keys:compressedKeys,data:encrypted.data,headers:encrypted.headers}),plaintext.toString('base64url'));
  assert.deepEqual(decryptEce(Buffer.from(encrypted.data,'base64url'),encrypted.headers,compressedKeys),plaintext);
  for (const publicKey of [[],[4],Array(65).fill(0)]) {
    const malformed = {...keys,public_key:publicKey};
    const original = await rust({operation:'decrypt',keys:malformed,data:encrypted.data,headers:encrypted.headers});
    assert.equal(original.ok,false); assert.equal(original.panic,'legacy-ece-invalid-key');
    assert.throws(()=>decryptEce(Buffer.from(encrypted.data,'base64url'),encrypted.headers,malformed),error=>error.code === 'Decryption');
  }
});

test('COMP-WEBHOOK: same payload body for JSON/raw, missing env, network failure and documented HTTP-status delta', async () => {
  const keys = generateKeys(), recorded = [];
  await withHttp(async (request,response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    recorded.push({method:request.method,type:request.headers['content-type'],payload:JSON.parse(rawBody),rawBody});
    response.writeHead(request.url === '/fail' ? 503 : 200); response.end('dummy-response');
  }, async url => {
    for (const plaintext of ['{"dummy":"日本語"}', 'dummy raw text', 'false', '42', 'null', '[1,2]']) {
      const encrypted = encryptFixture(keys,plaintext);
      const requestIndex = recorded.length;
      const rustAck = await rustValue({operation:'notification',keys,data:encrypted.data,headers:encrypted.headers},{ WEBHOOK_ENDPOINT:url + '/success' });
      assert.equal(rustAck.ack,100,`Rust webhook must actually deliver the fixture ${plaintext}`);
      assert.equal(recorded.length,requestIndex + 1,'Rust webhook must produce exactly one new request before comparison');
      await handleNotificationData(encrypted.data,encrypted.headers,keys,{env:{ WEBHOOK_ENDPOINT:url + '/success' }});
      assert.equal(recorded.length,requestIndex + 2,'Node webhook must produce exactly one new request before comparison');
      const { rawBody:nodeRaw, ...nodeRecord } = recorded[requestIndex + 1];
      const { rawBody:rustRaw, ...rustRecord } = recorded[requestIndex];
      assert.deepEqual(nodeRecord,rustRecord);
      assert.deepEqual(JSON.parse(nodeRaw),JSON.parse(rustRaw));
      assert.equal(recorded.at(-1).method,'POST'); assert.match(recorded.at(-1).type,/application\/json/u);
    }
    for (const plaintext of ['{"id":18446744073709551615}','{"id":9223372036854775807}','{"id":-9223372036854775808}','-0','1e400','{"id":"\\ud800"}']) {
      const encrypted = encryptFixture(keys,plaintext);
      const requestIndex = recorded.length;
      const rustAck = await rustValue({operation:'notification',keys,data:encrypted.data,headers:encrypted.headers},{ WEBHOOK_ENDPOINT:url + '/success' });
      assert.equal(rustAck.ack,100,`Rust webhook must actually deliver the fixture ${plaintext}`);
      assert.equal(recorded.length,requestIndex + 1,'Rust webhook must produce exactly one new request before comparison');
      await handleNotificationData(encrypted.data,encrypted.headers,keys,{env:{WEBHOOK_ENDPOINT:url + '/success'}});
      assert.equal(recorded.length,requestIndex + 2,'Node webhook must produce exactly one new request before comparison');
      assert.equal(recorded[requestIndex + 1].rawBody,recorded[requestIndex].rawBody,'Rust numeric and invalid JSON forwarding semantics');
    }
    const failedPayload = encryptFixture(keys,'{}');
    assert.equal((await rustValue({operation:'notification',keys,data:failedPayload.data,headers:failedPayload.headers},{ WEBHOOK_ENDPOINT:url + '/fail' })).ack,100,'Rust incorrectly acknowledges non-2xx delivery');
    await assert.rejects(handleNotificationData(failedPayload.data,failedPayload.headers,keys,{env:{WEBHOOK_ENDPOINT:url + '/fail'}}));
  });
  assert.equal((await rust({operation:'webhook',payload:{dummy:true}})).ok,false);
  await assert.rejects(sendToWebhook({dummy:true},{env:{}}));
  const stopped = 'http://127.0.0.1:1/';
  assert.equal((await rust({operation:'webhook',payload:{dummy:true}},{WEBHOOK_ENDPOINT:stopped})).ok,false);
  await assert.rejects(sendToWebhook({dummy:true},{env:{WEBHOOK_ENDPOINT:stopped}}));
});

test('COMP-X-REGISTRATION: isolated legacy request body/headers and response errors match real Rust against loopback', async () => {
  const twitter = {auth_token:'dummy-cookie',ct0:'dummy-csrf'}, keys = generateKeys();
  const registration = {endpoint:'https://push.example.invalid/dummy',autopush:{uaid:'dummy',channel_id:'dummy'},keys};
  for (const scenario of ['success','status','invalid-json']) {
    const requests = [];
    await withHttp(async (request,response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const headers = Object.fromEntries(['authorization','cookie','x-csrf-token','x-twitter-auth-type','x-twitter-active-user','x-twitter-client-language','content-type'].map(key=>[key,request.headers[key]]));
      requests.push({method:request.method,path:request.url,headers,body:JSON.parse(Buffer.concat(chunks))});
      response.writeHead(scenario === 'status' ? 403 : 200, {'content-type':'application/json'});
      response.end(scenario === 'invalid-json' ? 'dummy-non-json' : '{}');
    }, async url => {
      const original = await rust({operation:'twitter',twitter,registration},{ANGELIC_ORACLE_TWITTER_URL:url});
      if (scenario === 'success') {
        assert.equal(original.ok,true);
        await registerTwitter(twitter,registration,{allowLegacyX:true,endpoint:url + '/notifications/settings/login.json'});
      } else {
        assert.equal(original.ok,false);
        await assert.rejects(registerTwitter(twitter,registration,{allowLegacyX:true,endpoint:url + '/notifications/settings/login.json'}));
      }
      assert.deepEqual(requests[0],requests[1]);
    });
  }
});

test('COMP-CLI: original help/status/input failure golden with documented safe secret redaction', async () => {
  assert.ok(existsSync(baselinePath),'Build original Rust CLI comparison binary first.');
  const directory = await mkdtemp(join(tmpdir(),'angelic-compat-cli-'));
  function command(binary,args) {
    const result = spawnSync(binary,args,{cwd:directory,env:cleanEnv,encoding:'utf8',windowsHide:true,timeout:10000,input:''});
    assert.ifError(result.error);
    return { code:result.status, text:stripVTControlCharacters(result.stdout + result.stderr).replace(/\r\n/gu,'\n') };
  }
  const both = args => [command(baselinePath,args),command(process.execPath,[nodeCli,...args])];
  const canonicalHelp = text => text.replaceAll('angelic-angel-rust-baseline' + executableExtension,'angelic-angel').replace(/\s+/gu,' ').trim();
  try {
    const [rustHelp,nodeHelp] = both(['--help']);
    assert.equal(rustHelp.code,0); assert.equal(nodeHelp.code,0);
    assert.equal(canonicalHelp(nodeHelp.text),canonicalHelp(rustHelp.text),'full normalized --help golden');
    for (const word of ['init','register','listen','status','unregister','--config','--verbose','--help']) {
      assert.ok(rustHelp.text.includes(word),`Rust help ${word}`); assert.ok(nodeHelp.text.includes(word),`Node help ${word}`);
    }
    for (const args of [['-h'],...['init','register','listen','status','unregister'].map(name=>[name,'--help'])]) {
      const [rustCli,node] = both(args);
      assert.equal(node.code,rustCli.code);
      assert.equal(canonicalHelp(node.text),canonicalHelp(rustCli.text),`full normalized help ${args.join(' ')}`);
    }
    for (const args of [[],['unknown'],['--config'],['init','--unknown'],['init','--auth-token'],
      ['-c','a','-c','b','status'],['-v','-v','status'],['--verbose','-v','status'],['--config=a','--config=b','status'],
      ['-vv','status'],['--version'],['init','--auth-token','dummy','--auth-token','again','--ct0','dummy']]) {
      const [rustCli,node] = both(args); assert.equal(rustCli.code,2); assert.equal(node.code,rustCli.code,JSON.stringify(args));
    }
    const rustInitPath = join(directory,'rust-init.toml'), nodeInitPath = join(directory,'node-init.toml');
    const rustInit = command(baselinePath,['-c',rustInitPath,'init','--auth-token','DUMMY_UNICODE_😀','--ct0','dummy-csrf']);
    const nodeInit = command(process.execPath,[nodeCli,'-c',nodeInitPath,'init','--auth-token','DUMMY_UNICODE_😀','--ct0','dummy-csrf']);
    assert.equal(rustInit.code,0); assert.equal(nodeInit.code,0);
    assert.deepEqual(parseConfig(await readFile(nodeInitPath,'utf8')),parseConfig(await readFile(rustInitPath,'utf8')));
    for (const args of [['-vcfile','status'],['-vh'],['-vc','file','status'],['--','status'],['help','init'],['init','--help'],['status','--help']]) {
      const [rustCli,node] = both(args); assert.equal(node.code,rustCli.code,JSON.stringify(args));
      if (args.includes('init') && args.includes('--help')) assert.ok(node.text.includes('--auth-token') && node.text.includes('--ct0'));
    }
    for (const args of [['status'],['-c','missing.toml','listen'],['-c','missing.toml','unregister'],['init']]) {
      const [rustCli,node] = both(args); assert.equal(node.code,rustCli.code,JSON.stringify(args));
      if (args[0] === 'status') { assert.match(rustCli.text,/Config\s+not found/u); assert.match(node.text,/Config\s+not found/u); }
      if (args[0] === 'init') { assert.match(rustCli.text,/input error/u); assert.match(node.text,/input error/u); }
    }
    const config = {twitter:{auth_token:'DUMMY_COOKIE_MUST_BE_REDACTED',ct0:'DUMMY_CSRF_MUST_BE_REDACTED'}};
    await writeFile(join(directory,'angelic-angel.toml'),stringifyConfig(config));
    const [rustStatus,nodeStatus] = both(['status']);
    assert.equal(rustStatus.code,0); assert.equal(nodeStatus.code,0);
    for (const label of ['Status','Config','auth_token','ct0','Registration','not registered']) assert.ok(rustStatus.text.includes(label) && nodeStatus.text.includes(label),label);
    assert.ok(rustStatus.text.includes('DUMMY_COOKIE_MUST_BE'),'Rust original secret prefix golden');
    assert.ok(!nodeStatus.text.includes('DUMMY_COOKIE') && !nodeStatus.text.includes('DUMMY_CSRF'),'MIG-008 explicit safe status difference');
    const [rustListen,nodeListen] = both(['listen']); assert.equal(nodeListen.code,rustListen.code); assert.match(nodeListen.text,/No registration found/u);
    await writeFile(join(directory,'angelic-angel.toml'),'[broken');
    const [rustInvalid,nodeInvalid] = both(['listen']); assert.equal(nodeInvalid.code,rustInvalid.code); assert.match(rustInvalid.text,/TOML error/u); assert.match(nodeInvalid.text,/TOML error/u);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('COMP-WS: real Rust and Node REGISTER/UNREGISTER/HELLO/notification/ACK transcript equivalence', async () => {
  const keys = generateKeys(), session = {uaid:'dummy-uaid',channel_id:'dummy-chid'};
  for (const implementation of ['rust','node']) {
    const outgoing = [], notifications = [];
    await withWs(socket => socket.on('message',buffer => {
      const message = JSON.parse(buffer.toString()); outgoing.push(message);
      if (message.messageType === 'hello') socket.send(JSON.stringify({messageType:'hello',status:200,uaid:'dummy-uaid'}));
      if (message.messageType === 'register') socket.send(JSON.stringify({messageType:'register',status:200,pushEndpoint:'https://push.example.invalid/dummy',channelID:message.channelID}));
      if (message.messageType === 'unregister') socket.close(1000);
    }), async url => {
      const registration = implementation === 'rust'
        ? await rustValue({operation:'register',keys},{ANGELIC_ORACLE_WS_URL:url})
        : await registerNew(keys,{url});
      assert.equal(registration.uaid,session.uaid); assert.match(registration.channel_id,/^[0-9a-f-]{36}$/u);
      assert.equal(registration.endpoint,'https://push.example.invalid/dummy');
      assert.deepEqual(outgoing[0],{messageType:'hello',uaid:'',use_webpush:true,broadcasts:{}});
      assert.equal(outgoing[1].messageType,'register'); assert.equal(outgoing[1].key.length,87);
      outgoing.length = 0;
      if (implementation === 'rust') await rustValue({operation:'unregister',session},{ANGELIC_ORACLE_WS_URL:url});
      else await unregister(session,{url});
      assert.deepEqual(outgoing,[{messageType:'hello',uaid:session.uaid,use_webpush:true,broadcasts:{}},{messageType:'unregister',channelID:session.channel_id,code:200}]);
    });
    outgoing.length = 0;
    await withWs(socket => socket.on('message',buffer => {
      const message = JSON.parse(buffer.toString()); outgoing.push(message);
      if (message.messageType === 'hello') {
        socket.send(JSON.stringify({messageType:'hello',status:200,uaid:session.uaid}));
        socket.send('{}'); socket.ping('fixture');
        for (const [channelID,version] of [[session.channel_id,'one'],['other-channel','one'],[session.channel_id,'two']]) socket.send(JSON.stringify({messageType:'notification',channelID,version}));
      }
      if (outgoing.filter(item=>item.messageType === 'ack').length === 3) socket.close(1000);
    }), async url => {
      if (implementation === 'rust') {
        const result = await rustValue({operation:'session',session,keys},{ANGELIC_ORACLE_WS_URL:url});
        notifications.push(...result.notifications);
      } else {
        const result = await connectAndListen(session,keys,{url}); assert.equal(result.kind,'Connected');
        try {
          for (;;) {
            const notification = await result.client.nextNotification(); if (notification === null) break;
            notifications.push({channelID:notification.channel_id,version:notification.version,data:notification.data,headers:notification.headers});
            await result.client.ackNotification(notification.channel_id,notification.version,AckCode.Delivered);
          }
        } finally { await result.client.close(); }
      }
      assert.deepEqual(notifications,[{channelID:session.channel_id,version:'one',data:null,headers:null},{channelID:session.channel_id,version:'two',data:null,headers:null}]);
      assert.deepEqual(outgoing.filter(item=>item.messageType==='ack').map(item=>item.updates[0]),[
        {channelID:session.channel_id,version:'one',code:100},{channelID:'other-channel',version:'one',code:100},{channelID:session.channel_id,version:'two',code:100},
      ]);
    });
  }
});

test('COMP-WS-ERRORS: original Rust and Node both reject handshake/protocol/4774/pong timeouts', async () => {
  const keys = generateKeys(), session = {uaid:'dummy-uaid',channel_id:'dummy-chid'};
  for (const scenario of ['hello-status','hello-timeout','wrong-tag','binary-hello','closed-hello','register-status','register-timeout','unknown-response','backoff','pong-timeout']) {
    for (const implementation of ['rust','node']) {
      await withWs(socket => socket.on('message',buffer => {
        const message = JSON.parse(buffer.toString());
        if (message.messageType === 'hello') {
          if (scenario === 'hello-timeout') return;
          if (scenario === 'hello-status') socket.send(JSON.stringify({messageType:'hello',status:503,uaid:session.uaid}));
          else if (scenario === 'wrong-tag') socket.send(JSON.stringify({messageType:'notification',channelID:'dummy',version:'1'}));
          else if (scenario === 'binary-hello') socket.send(Buffer.from('dummy'),{binary:true});
          else if (scenario === 'closed-hello') socket.close(1000);
          else {
            socket.send(JSON.stringify({messageType:'hello',status:200,uaid:session.uaid}));
            if (scenario === 'unknown-response') socket.send('{"messageType":"unknown"}');
            if (scenario === 'backoff') socket.close(4774);
          }
        }
        if (message.messageType === 'register' && scenario !== 'register-timeout') socket.send(JSON.stringify({messageType:'register',status:409,channelID:message.channelID,pushEndpoint:'dummy'}));
        // App-level {} is deliberately left unanswered for pong-timeout.
      }), async url => {
        const operation = ['register-status','register-timeout'].includes(scenario) ? 'register' : 'session';
        if (implementation === 'rust') {
          const result = await rust({operation,keys,session},{ANGELIC_ORACLE_WS_URL:url,
            ANGELIC_ORACLE_APP_PING_MS:'40',ANGELIC_ORACLE_WS_PING_MS:'500',ANGELIC_ORACLE_REQUEST_TIMEOUT_MS:'80'});
          assert.equal(result.ok,false,`Rust ${scenario}`);
          if (scenario === 'backoff') assert.match(result.error,/BACKOFF/u);
          if (scenario === 'pong-timeout') assert.match(result.error,/pong timed out/u);
        } else if (operation === 'register') {
          await assert.rejects(registerNew(keys,{url,requestTimeoutMs:80}));
        } else {
          let client;
          try {
            await assert.rejects((async () => {
              const result = await connectAndListen(session,keys,{url,appPingIntervalMs:40,wsPingIntervalMs:500,requestTimeoutMs:80});
              assert.equal(result.kind,'Connected'); client = result.client;
              await client.nextNotification();
            })(),scenario === 'backoff' ? /BACKOFF/u : undefined);
          } finally { await client?.close(); }
        }
      });
    }
  }
});

test('COMP-WS-DEDUPE: FIFO100 eviction and notification-during-pong legacy bypass match Rust exactly', async () => {
  const keys = generateKeys(), session = {uaid:'dummy-uaid',channel_id:'dummy-chid'};
  for (const scenario of ['eviction','pong-bypass']) for (const implementation of ['rust','node']) {
    const versions = [], acknowledgements = [];
    await withWs(socket => socket.on('message',buffer => {
      const message = JSON.parse(buffer.toString());
      const send = version => socket.send(JSON.stringify({messageType:'notification',channelID:session.channel_id,version}));
      if (message.messageType === 'hello') {
        socket.send(JSON.stringify({messageType:'hello',status:200,uaid:session.uaid}));
        send('zero');
        if (scenario === 'eviction') {
          send('zero');
          for (let index=1;index<=100;index++) send(String(index));
          send('zero');
        }
      } else if (!message.messageType && scenario === 'pong-bypass') send('zero');
      if (message.messageType === 'ack') {
        acknowledgements.push(message.updates[0]);
        if (acknowledgements.length === (scenario === 'eviction' ? 103 : 2)) socket.close(1000);
      }
    }), async url => {
      if (implementation === 'rust') {
        const result = await rustValue({operation:'session',keys,session},{ANGELIC_ORACLE_WS_URL:url,
          ANGELIC_ORACLE_APP_PING_MS:'40',ANGELIC_ORACLE_WS_PING_MS:'500',ANGELIC_ORACLE_REQUEST_TIMEOUT_MS:'100'});
        versions.push(...result.notifications.map(item=>item.version));
      } else {
        const result = await connectAndListen(session,keys,{url,appPingIntervalMs:40,wsPingIntervalMs:500,requestTimeoutMs:100});
        assert.equal(result.kind,'Connected');
        try {
          for (;;) {
            const notification = await result.client.nextNotification(); if (notification === null) break;
            versions.push(notification.version);
            await result.client.ack(notification.channel_id,notification.version,AckCode.Delivered);
          }
        } finally { await result.client.close(); }
      }
      assert.deepEqual(versions,scenario === 'eviction' ? ['zero',...Array.from({length:100},(_value,index)=>String(index+1)),'zero'] : ['zero','zero']);
      assert.ok(acknowledgements.every(item=>item.code === 100));
    });
  }
});

test('COMP-UAID: same changed-UAID fixture creates new keys/channel and full legacy recovery information', async () => {
  const keys = generateKeys(), session = {uaid:'old-dummy',channel_id:'old-dummy-channel'};
  for (const implementation of ['rust','node']) {
    const transcript = [];
    await withWs(socket => socket.on('message',buffer => {
      const message = JSON.parse(buffer.toString()); transcript.push(message);
      if (message.messageType === 'hello') socket.send(JSON.stringify({messageType:'hello',status:200,uaid:'new-dummy'}));
      if (message.messageType === 'register') socket.send(JSON.stringify({messageType:'register',status:200,pushEndpoint:'https://push.example.invalid/fresh',channelID:message.channelID}));
    }), async url => {
      let normalized;
      if (implementation === 'rust') normalized = await rustValue({operation:'session',keys,session},{ANGELIC_ORACLE_WS_URL:url});
      else {
        const result = await connectAndListen(session,keys,{url,allowReregistration:true});
        assert.equal(result.kind,'NeedsReregistration');
        normalized = {reregister:true,...result.registration,keys:result.keys};
      }
      assert.equal(normalized.reregister,true); assert.equal(normalized.uaid,'new-dummy');
      assert.equal(normalized.endpoint,'https://push.example.invalid/fresh');
      assert.notEqual(normalized.channel_id,session.channel_id);
      assert.notDeepEqual(normalized.keys.private_key,keys.private_key);
      assert.notDeepEqual(normalized.keys.auth_secret,keys.auth_secret);
      assert.equal(normalized.keys.public_key.length,65);
      assert.deepEqual(transcript.slice(0,2),[
        {messageType:'hello',uaid:'old-dummy',use_webpush:true,broadcasts:{}},
        {messageType:'hello',uaid:'',use_webpush:true,broadcasts:{}},
      ]);
      assert.equal(transcript[2].messageType,'register'); assert.equal(transcript[2].channelID,normalized.channel_id);
    });
  }
});
