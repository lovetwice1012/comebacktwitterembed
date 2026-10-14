import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { v0 } from './mods/m0.mjs';

assert.equal(v0, 0);
test('one fresh loopback HTTP connection per child process', { timeout: 5000 }, async context => {
  assert.ok(readFileSync(new URL(import.meta.url), 'utf8').length > 0);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
    response.end('<h1>ok</h1>');
  });
  context.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(await response.text(), '<h1>ok</h1>');
});
