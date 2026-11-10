'use strict';
// Disposable-profile integration probe. Synthetic credentials arrive through
// stdin only and are never included in output, arguments, files, or errors.
const { createChromeMcsTransport } = require('../../src/automation/chrome-mcs-transport');
const { createChromeMcsSession } = require('../../src/automation/chrome-mcs-session');
const { checkin } = require('../../src/automation/chrome-checkin');
async function main() {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 8192) throw new Error('FIXTURE_INPUT_INVALID'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const transport = createChromeMcsTransport({ timeoutMs: 15000 });
    let received = false;
    const session = createChromeMcsSession({ credentials: input.credentials, route: input.route,
        store: { pending: async () => [], commit: async message => {
            if (!message.encrypted?.data?.length || !message.persistentId) throw new Error('FIXTURE_RECEIPT_INVALID');
            received = true; return { id: 'fixture', duplicate: false };
        }, confirm: async () => {} },
        send: data => transport.send(data),
    });
    try {
        await checkin({ deviceId: input.credentials.deviceId, securityToken: input.credentials.securityToken,
            browserVersion: input.credentials.clientVersion });
        await transport.connect(); await session.start();
        const hello = await transport.read(15000);
        if (!hello || (await session.receive(hello)).state !== 'listening') throw new Error('FIXTURE_LOGIN_FAILED');
        process.stdout.write('{"ready":true,"checkin":true}\n');
        const deadline = Date.now() + 30000;
        while (!received && Date.now() < deadline) {
            const frame = await transport.read(Math.max(1, deadline - Date.now()));
            if (!frame) break;
            await session.receive(frame);
        }
        if (!received) throw new Error('FIXTURE_RECEIPT_TIMEOUT');
        process.stdout.write('{"encryptedReceipt":true}\n');
    } finally { session.close(); await transport.close(); }
}
main().catch(error => {
    const code = /^FIXTURE_[A-Z_]+$/.test(error?.message || '') ? error.message : 'FIXTURE_MCS_FAILED';
    process.stderr.write(code + '\n'); process.exitCode = 1;
});
