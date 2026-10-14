import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runCli } from '../dist/cli.js';
import { loadConfig } from '../dist/config.js';
import { generateKeys } from '../dist/push.js';
import { encryptFixture } from './fixtures/crypto-fixture-builder.mjs';

test('MOCK-E2E full init→AutoPush register→legacy X mock→restart config→listen/decrypt/webhook/ACK→unregister', async t => {
  const directory = await mkdtemp(join(tmpdir(),'angelic-lifecycle-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const configPath=join(directory,'angelic-angel.toml');
  const controller=new AbortController();
  const transcript=[],acks=[],delivered=[],logs=[];
  let stored,phase='register',registeredX=0;
  const stderr=new Writable({write(chunk,_encoding,callback){logs.push(chunk.toString());callback();}});
  const httpServer=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    if(req.url==='/x'){
      registeredX++;const payload=JSON.parse(text).push_device_info;
      stored.keys.public_key=[...Buffer.from(payload.encryption_key1,'base64url')];
      stored.keys.auth_secret=[...Buffer.from(payload.encryption_key2,'base64url')];
      assert.equal(payload.token,'https://push.example.invalid/test-endpoint');
      assert.equal(req.headers.cookie,'auth_token=TEST_ONLY_AUTH; ct0=TEST_ONLY_CT0');
      res.end('{}');
    }else {delivered.push(JSON.parse(text));res.statusCode=204;res.end();}
  });
  await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{httpServer.closeAllConnections();httpServer.close(resolve);}));
  const base=`http://127.0.0.1:${httpServer.address().port}`;
  const wsServer=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(resolve=>wsServer.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{for(const ws of wsServer.clients)ws.terminate();wsServer.close(resolve);}));
  wsServer.on('connection',ws=>ws.on('message',async bytes=>{
    const message=JSON.parse(bytes.toString());transcript.push(message);
    if(message.messageType==='hello'){
      assert.equal(message.use_webpush,true);assert.deepEqual(message.broadcasts,{});assert.ok(!Object.hasOwn(message,'channelIDs'));
      ws.send(JSON.stringify({messageType:'hello',status:200,uaid:'TEST_UAID'}));
      if(phase==='listen'){
        const plaintext=Buffer.from(JSON.stringify({tweet:'TEST_ONLY_PAYLOAD',id:'123'}));
        const envelope=encryptFixture(stored.keys,plaintext,{senderPrivate:Buffer.from(generateKeys().private_key)});
        // Both duplicate suppression and decryption failure are observed on the actual socket.
        const notification={messageType:'notification',channelID:stored.autopush.channel_id,version:'1',data:envelope.data,headers:envelope.headers};
        ws.send(JSON.stringify(notification));ws.send(JSON.stringify(notification));
        ws.send(JSON.stringify({...notification,version:'2',data:'%%%'}));
        ws.send(JSON.stringify({messageType:'notification',channelID:stored.autopush.channel_id,version:'3'}));
      }
    }else if(message.messageType==='register'){
      stored={keys:{public_key:[],private_key:[],auth_secret:[]},autopush:{uaid:'TEST_UAID',channel_id:message.channelID}};
      ws.send(JSON.stringify({messageType:'register',status:200,channelID:message.channelID,pushEndpoint:'https://push.example.invalid/test-endpoint'}));
      // The subsequent X request contains only public key/auth. The complete generated
      // scalar is intentionally retained in config, not exposed in protocol messages.
    }else if(message.messageType==='ack'){
      acks.push(message.updates[0]);if(acks.length===4)controller.abort();
    }else if(message.messageType==='unregister')assert.equal(message.code,200);
  }));
  const autopush={url:`ws://127.0.0.1:${wsServer.address().port}/`};
  const legacy={allowLegacyX:true,endpoint:base+'/x'};
  // Capture keys safely from the mocked X public/auth fields; the private scalar
  // is then recovered through the same config read used on an actual restart.
  assert.equal(await runCli(['-c',configPath,'init','--auth-token','TEST_ONLY_AUTH','--ct0','TEST_ONLY_CT0'],{stderr}),0);
  assert.equal(await runCli(['-c',configPath,'register'],{stderr,autopush,legacy}),0);
  assert.equal(registeredX,1);
  stored=(await loadConfig(configPath)).registration;
  assert.equal(stored.keys.private_key.length,32);assert.equal(stored.autopush.uaid,'TEST_UAID');
  assert.ok((await readFile(configPath,'utf8')).includes('[registration.keys]'));
  phase='listen';
  const watchdog=setTimeout(()=>controller.abort(),5000);t.after(()=>clearTimeout(watchdog));
  assert.equal(await runCli(['-v','-c',configPath,'listen'],{stderr,autopush,legacy,env:{WEBHOOK_ENDPOINT:base+'/webhook'},signal:controller.signal}),0);
  assert.deepEqual(acks.map(item=>item.code),[100,100,101,100]);assert.deepEqual(delivered,[{tweet:'TEST_ONLY_PAYLOAD',id:'123'}]);
  phase='unregister';
  assert.equal(await runCli(['-c',configPath,'unregister'],{stderr,autopush}),0);
  assert.equal((await loadConfig(configPath)).registration,undefined);
  assert.equal(transcript.filter(message=>message.messageType==='unregister').length,1);
  const text=logs.join('');for(const secret of ['TEST_ONLY_AUTH','TEST_ONLY_CT0','TEST_ONLY_PAYLOAD','https://push.example.invalid/test-endpoint'])assert.ok(!text.includes(secret));
});
