'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const component = require('../../src/components/showMediaAsAttachments');

test('extensionless images are identified without reading a whole response or guessing on failure', async t => {
    const server = http.createServer((req, res) => {
        if (req.method === 'HEAD') {
            res.writeHead(405).end();
        } else if (req.url === '/valid') {
            // Ignore Range and leave the rest of the response open: the probe must stop after the prefix.
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]));
        } else if (req.url === '/html') {
            res.writeHead(200, { 'content-type': 'text/html' }).end('<html>upstream error</html>');
        } else {
            res.writeHead(404, { 'content-type': 'image/jpeg' }).end('not an image');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(await component._internal.resolveImageExtension(`${base}/valid`), 'png');
    assert.equal(await component._internal.resolveImageExtension(`${base}/missing`), null);
    assert.equal(await component._internal.resolveImageExtension(`${base}/html`), null);

    let edits = 0, replies = 0;
    const interaction = {
        guildId: 'test', locale: 'en',
        message: { attachments: [], embeds: [{ title: 'source', image: { url: `${base}/missing` } }], edit: async () => { edits++; } },
        editReply: async () => { replies++; },
    };
    await assert.rejects(component.handle(interaction, { buttons: {} }), /GRID_SOURCE_INCOMPLETE/);
    assert.equal(edits, 0);
    assert.equal(replies, 0);
});
