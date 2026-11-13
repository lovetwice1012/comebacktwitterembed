'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createXSetup } = require('../../src/automation/x-setup');
const { createTransferPublicSealer } = require('../../src/automation/x-setup-transfer');
const { dispatch } = require('../../src/automation/api');
const { fixture: makePushFile } = require('./helpers/x-push-fixture.cjs');

const owner = { userId: '222222222222222222' };
test('real X setup API keeps an unusable duplicate open and only selects it after recovery', { timeout: 60000 }, async () => {
    const db = await createTestDatabase(Number(process.env.AUTOMATION_TEST_DB_PORT));
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const sealer = createTransferPublicSealer({ activeKeyId: 'fixture', publicKeys: { fixture: publicKey } });
    const service = createXSetup(db, { sealer, rolloutMode: 'public', receiverEnabled: true });
    const services = { db, xSetup: service, service: { withOperation: async (_actor, _group, work) => work() } }, fileText = JSON.stringify(makePushFile());
    const api = (path, method = 'GET', body = {}) => dispatch({ method, path: path.split('/'), search: new URLSearchParams(), body }, owner, services);
    let f;
    try {
        const session = await api('x-setup/sessions', 'POST', { consent: true });
        const initial = await api('x-setup/import', 'POST', { sessionId: session.sessionId, fileText, consent: true });
        assert.equal(initial.duplicate, false);
        await db.queryDatabase("INSERT INTO automation_x_push_receivers (subscription_id,state,subscription_revision,updated_at_ms) VALUES (?,'requires_reenrollment',?,0)", [initial.subscription.id, initial.subscription.revision]);
        for (const [state, expectedChoices] of [['requires_reenrollment', 0], ['awaiting', 1]]) {
            await db.queryDatabase('UPDATE automation_x_push_receivers SET state=? WHERE subscription_id=?', [state, initial.subscription.id]);
            const chosen = [], writes = [];
            f = await reactFixture('export { XNotificationSetup } from "./components/automation/x-notification-setup";');
            f.set('confirm', () => true);
            const request = async (path, method = 'GET', body) => { if (method !== 'GET') writes.push(path); return api(path, method, body); };
            await f.render(f.React.createElement(f.exports.XNotificationSetup, { api: request, initiallyOpen: true, embedded: true,
                onChooseSubscription: value => chosen.push(value) })); await f.settle();
            for (let attempt = 0; attempt < 100 && ![...f.container.querySelectorAll('button')].some(button => button.textContent === '受信情報を追加'); attempt++)
                await f.act(async () => new Promise(resolve => setTimeout(resolve, 25)));
            assert(!f.container.querySelector('[role="alert"]'), 'initial status should load');
            await f.click('受信情報を追加');
            const firefox = [...f.container.querySelectorAll('label')].find(label => label.textContent.trim() === 'Firefox');
            assert(firefox); await f.act(async () => firefox.querySelector('input').click());
            await f.click('作成したファイルを登録');
            const consent = [...f.container.querySelectorAll('label')].find(label => label.textContent.includes('サーバーでX通知を受信・復号')).querySelector('input');
            await f.act(async () => consent.click());
            const input = f.container.querySelector('input[type=file]'), bytes = Buffer.from(fileText);
            Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'synthetic.json', size: bytes.length,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }] });
            await f.act(async () => input.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })));
            await f.click('ファイルの内容を確認');
            for (let attempt = 0; attempt < 100 && !f.container.querySelector('[aria-label="X通知ファイルの登録確認"]'); attempt++)
                await f.act(async () => new Promise(resolve => setTimeout(resolve, 25)));
            assert(f.container.querySelector('[aria-label="X通知ファイルの登録確認"]'), 'review should load');
            await f.click('この受信情報を登録');
            for (let attempt = 0; attempt < 100 && !chosen.length && !f.container.textContent.includes('このファイルは再登録が必要な受信情報と同じです'); attempt++)
                await f.act(async () => new Promise(resolve => setTimeout(resolve, 25)));
            assert.deepEqual(writes, ['x-setup/sessions', 'x-setup/validate', 'x-setup/import']);
            assert.equal(chosen.length, expectedChoices);
            if (state === 'requires_reenrollment') {
                assert.match(f.container.textContent, /このファイルは再登録が必要な受信情報と同じです/);
                const card = f.container.querySelector('[aria-label="受信情報1"]'); assert(card);
                assert([...card.querySelectorAll('button')].find(button => button.textContent.includes('この接続を使う')).disabled);
                assert(!f.container.textContent.includes('受信情報を登録しました'));
            } else assert.equal(chosen[0].id, initial.subscription.id);
            assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM automation_x_subscriptions WHERE owner_user_id=?', [owner.userId]))[0].n), 1);
            assert.equal((await db.queryDatabase('SELECT state FROM automation_x_push_receivers WHERE subscription_id=?', [initial.subscription.id]))[0].state, state);
            await f.close(); f = null;
        }
    } finally { if (f) await f.close(); await db.close(); }
});
