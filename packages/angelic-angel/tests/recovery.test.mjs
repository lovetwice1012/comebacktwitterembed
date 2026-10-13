import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { tryConnect } from '../dist/listener.js';
import { main } from '../dist/index.js';
import { saveConfig, loadConfig } from '../dist/config.js';
import { generateKeys } from '../dist/push.js';
import { encryptFixture } from './fixtures/crypto-fixture-builder.mjs';

async function fixture(t,status=200) {
  const dir=await mkdtemp(join(tmpdir(),'angelic-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'config.toml'),registration={endpoint:'https://push.example.invalid/old',autopush:{uaid:'old',channel_id:'old-channel'},keys:generateKeys()};
  await saveConfig({twitter:{auth_token:'DUMMY_AUTH',ct0:'DUMMY_CT0'},registration},path);
  let calls=0;
  const server=http.createServer(async(req,res)=>{for await(const chunk of req){void chunk;}calls++;res.statusCode=status;res.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const replacement={kind:'NeedsReregistration',registration:{uaid:'new',channel_id:'new-channel',endpoint:'https://push.example.invalid/new'},keys:generateKeys()};
  return {path,registration,replacement,calls:()=>calls,legacy:{allowLegacyX:true,endpoint:`http://127.0.0.1:${server.address().port}`}};
}
test('full authorized UAID recovery calls legacy mock then saves fresh keys and reconnects with restart-readable configuration',async t=>{
  const f=await fixture(t), observed=[];
  const client={nextNotification:async()=>null,ack:async()=>{},close:async()=>{}};
  const connected=await tryConnect(f.registration,f.path,{legacy:f.legacy,connect:async(reg,opts)=>{
    assert.equal(opts.allowReregistration,true);observed.push(structuredClone(reg));
    return observed.length===1?f.replacement:{kind:'Connected',client};
  }});
  assert.equal(connected,client);assert.equal(f.calls(),1);
  assert.equal(observed[0].autopush.uaid,'old');assert.equal(observed[1].autopush.uaid,'new');
  assert.deepEqual((await loadConfig(f.path)).registration,f.registration);
  assert.deepEqual(f.registration.keys,f.replacement.keys);
  assert.notDeepEqual(observed[0].keys,observed[1].keys);
});
test('failed legacy re-registration preserves both original persisted and in-memory registration',async t=>{
  const f=await fixture(t,500),original=structuredClone(f.registration);
  await assert.rejects(tryConnect(f.registration,f.path,{legacy:f.legacy,connect:async()=>f.replacement}),{code:'TwitterApi'});
  assert.deepEqual(f.registration,original);assert.deepEqual((await loadConfig(f.path)).registration,original);assert.equal(f.calls(),1);
});
test('second UAID invalidation returns fatal diagnostics and retains successfully registered state',async t=>{
  const f=await fixture(t);
  await assert.rejects(tryConnect(f.registration,f.path,{legacy:f.legacy,connect:async()=>f.replacement}),error=>error.code==='AutoPush'&&error.message.includes('still failed after re-registration'));
  assert.equal(f.calls(),1);assert.equal((await loadConfig(f.path)).registration.autopush.uaid,'new');
});
test('unauthorized UAID recovery never calls legacy HTTP or changes original config',async t=>{
  const f=await fixture(t),original=structuredClone(f.registration);
  await assert.rejects(tryConnect(f.registration,f.path,{connect:async(_reg,opts)=>{assert.equal(opts.allowReregistration,false);return f.replacement;}}),{code:'TwitterApi'});
  assert.equal(f.calls(),0);assert.deepEqual(f.registration,original);assert.deepEqual((await loadConfig(f.path)).registration,original);
});
test('read-only registration config rejects recovery save while preserving old disk and in-memory state',async t=>{
  const f=await fixture(t),original=structuredClone(f.registration);
  // On Windows file read-only attributes prevent atomic replacement. On POSIX
  // the parent directory controls replacement, so restrict that directory too.
  const protectedPath=process.platform==='win32'?f.path:join(f.path,'..');
  await chmod(protectedPath,process.platform==='win32'?0o444:0o500);
  try {
    await assert.rejects(tryConnect(f.registration,f.path,{legacy:f.legacy,connect:async()=>f.replacement}),{code:'Io'});
    assert.equal(f.calls(),1);assert.deepEqual(f.registration,original);assert.deepEqual((await loadConfig(f.path)).registration,original);
  }finally {await chmod(protectedPath,process.platform==='win32'?0o600:0o700);}
});
for(const scenario of ['idle','backoff','webhook'])test(`main SIGINT during ${scenario} cleans resources and matches Rust successful interruption exit`,async t=>{
  const f=await fixture(t),output=[],stderr=new Writable({write(chunk,_enc,callback){output.push(chunk.toString());callback();}});
  const wsServer=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(resolve=>wsServer.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{for(const ws of wsServer.clients)ws.terminate();wsServer.close(resolve);}));
  let socket;
  const ready=new Promise(resolve=>wsServer.on('connection',ws=>{
    socket=ws;
    ws.on('message',data=>{const message=JSON.parse(data.toString());if(message.messageType==='hello'){
      ws.send(JSON.stringify({messageType:'hello',status:200,uaid:'old'}));
      if(scenario==='webhook'){
        const encrypted=encryptFixture(f.registration.keys,'{"TEST_ONLY":"message"}');
        ws.send(JSON.stringify({messageType:'notification',channelID:'old-channel',version:'1',data:encrypted.data,headers:encrypted.headers}));
      }
      resolve();
    }});
  }));
  let hookReady;
  const hook=new Promise(resolve=>{hookReady=resolve;});
  const server=http.createServer(req=>{req.resume();hookReady();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const running=main(['-v','-c',f.path,'listen'],{stderr,autopush:{url:`ws://127.0.0.1:${wsServer.address().port}/`},env:{WEBHOOK_ENDPOINT:`http://127.0.0.1:${server.address().port}`}});
  const watchdog=setTimeout(()=>process.emit('SIGINT'),5000);t.after(()=>clearTimeout(watchdog));
  await ready;
  if(scenario==='backoff'){socket.close(4774);await new Promise(resolve=>setTimeout(resolve,20));}
  else if(scenario==='webhook')await hook;
  process.emit('SIGINT');
  assert.equal(await running,0);assert.match(output.join(''),/Interrupted/);
  assert.ok(!output.join('').includes('DUMMY_AUTH'));
});
