'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
test('Windows loopback peer verification distinguishes the owned process from another process', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port, children = [], sockets = [];
    async function connect() {
        const accepted = once(server, 'connection');
        const child = spawn(process.execPath, ['-e', `require('node:net').connect(${port},'127.0.0.1');`], { windowsHide: true, stdio: 'ignore' });
        children.push(child); const [socket] = await accepted; sockets.push(socket); return { child, socket };
    }
    async function connectDescendant() {
        const accepted = once(server, 'connection');
        const inner = `require('node:net').connect(${port},'127.0.0.1');`;
        const outer = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(inner)}],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000);`;
        const child = spawn(process.execPath, ['-e', outer], { windowsHide: true, stdio: 'ignore' });
        children.push(child); const [socket] = await accepted; sockets.push(socket); return { child, socket };
    }
    try {
        const own = await connect(), other = await connect(), descendant = await connectDescendant(), helper = path.resolve(__dirname, '../../client/angelic-setup/EdgePeerIdentity.ps1');
        const quoted = value => `'${value.replace(/'/g, "''")}'`;
        const script = `$ErrorActionPreference='Stop'; . ${quoted(helper)}
$root=Get-Process -Id ${own.child.pid}; try { $ticks=$root.StartTime.ToUniversalTime().Ticks } finally { $root.Dispose() }
$common=@{ServerPort=${port};BrowserPid=${own.child.pid};BrowserStartTicks=$ticks;BrowserExecutable=${quoted(process.execPath)}}
if (-not (Test-XEdgeOwnedLoopbackPeer @common -ClientPort ${own.socket.remotePort})) { throw 'owned peer rejected' }
if (Test-XEdgeOwnedLoopbackPeer @common -ClientPort ${other.socket.remotePort}) { throw 'foreign peer accepted' }
$wrong=@{ServerPort=${port};BrowserPid=${own.child.pid};BrowserStartTicks=($ticks+1);BrowserExecutable=${quoted(process.execPath)}}
if (Test-XEdgeOwnedLoopbackPeer @wrong -ClientPort ${own.socket.remotePort}) { throw 'wrong start time accepted' }
if (Test-XEdgeOwnedLoopbackPeer @common -ClientPort 1) { throw 'invalid port accepted' }
$parent=Get-Process -Id ${descendant.child.pid}; try { $parentTicks=$parent.StartTime.ToUniversalTime().Ticks } finally { $parent.Dispose() }
$tree=@{ServerPort=${port};BrowserPid=${descendant.child.pid};BrowserStartTicks=$parentTicks;BrowserExecutable=${quoted(process.execPath)}}
if (-not (Test-XEdgeOwnedLoopbackPeer @tree -ClientPort ${descendant.socket.remotePort})) { throw 'owned descendant rejected' }
'ok'`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            { encoding: 'utf8', windowsHide: true, timeout: 25000 });
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /ok/);
    } finally {
        for (const socket of sockets) socket.destroy();
        for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit').catch(() => {}); }
        await new Promise(resolve => server.close(resolve));
    }
});
