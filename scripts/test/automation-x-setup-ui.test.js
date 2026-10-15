'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const SECRET = 'SYNTHETIC_PRIVATE_X_PUSH_MATERIAL';
const FILE = JSON.stringify({ syntheticPrivateMaterial: SECRET });
const subscription = changes => ({ id: 'sub-1', state: 'stored', revision: 1, createdAtMs: 1791921600000, updatedAtMs: 1791921600000, browserVersion: '160.0a1', ...changes });
const status = changes => ({ available: true, reasonCode: null, receiverEnabled: false,
    rollout: { mode: 'public', eligible: true, reasonCode: null, reason: null },
    download: { url: '/api/automation/x-setup/download', version: '0.1.0-preview.4', sha256: 'a'.repeat(64) }, subscriptions: [], maxFileBytes: 32768, nextCursor: null, ...changes });
const writes = f => f.calls.filter(call => call.method !== 'GET');
async function fixture({ current = status(), respond, opened = true, active = true, upload = true, setupProps = {} } = {}) {
    const f = await reactFixture('export { XNotificationSetup } from "./components/automation/x-notification-setup"; export { XNotificationSetupScreen } from "./components/automation/x-notification-setup-screen"; export { parseXSetupStatus,parseXSetupPreview,parseXSetupSubscription,xSetupFeedback } from "./components/automation/x-setup-view";');
    f.calls = []; f.current = current; f.sessions = 0;
    f.api = async (route, method = 'GET', body) => {
        f.calls.push({ route, method, body }); const override = respond && await respond(route, method, body, f); if (override !== undefined) return override;
        if (route === 'x-setup' && method === 'GET') return f.current;
        if (route === 'x-setup/sessions' && method === 'POST') return { sessionId: String(++f.sessions).padStart(64, '0'), expiresAtMs: Date.now() + 600000 };
        if (route === 'x-setup/validate' && method === 'POST') return { valid: true, browserVersion: '160.0a1', scope: 'https://x.com/account-notifications', formatVersion: 1 };
        if (route === 'x-setup/import' && method === 'POST') { const saved = subscription(); f.current = { ...f.current, subscriptions: [saved] }; return { subscription: saved, duplicate: false }; }
        if (route.startsWith('x-setup/subscriptions/') && method === 'DELETE') { f.current = { ...f.current, subscriptions: [] }; return { deleted: true }; }
        throw new Error('PRIVATE_UNEXPECTED_API_RESPONSE');
    };
    f.renderSetup = nextActive => f.render(f.React.createElement(f.exports.XNotificationSetup, { api: f.api, active: nextActive, ...setupProps }));
    await f.renderSetup(active); await f.settle();
    f.showUpload = async () => {
        if (f.container.querySelector('input[type="file"]')) return;
        const adding = [...f.container.querySelectorAll('button')].find(item => item.textContent === '受信情報を追加・登録し直す');
        if (adding) await f.click('受信情報を追加・登録し直す');
        await f.click('ファイルを登録する');
    };
    if (opened && active) { if (!setupProps.initiallyOpen) await f.click('X通知の受信設定を始める'); await f.settle(); if (upload) await f.showUpload(); }
    f.consent = () => f.field('サーバーでX通知を受信・復号');
    f.agree = () => f.act(async () => f.consent().click());
    f.fileInput = () => f.container.querySelector('input[type="file"]');
    f.choose = async ({ bytes = Buffer.from(FILE), name = 'x-notification.json', size = bytes.byteLength, arrayBuffer, native = false } = {}) => {
        const file = native ? new f.dom.window.File([bytes], name) : { name, size, arrayBuffer: arrayBuffer || (async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
        Object.defineProperty(f.fileInput(), 'files', { configurable: true, value: [file] });
        await f.act(async () => f.fileInput().dispatchEvent(new f.dom.window.Event('change', { bubbles: true })));
        return file;
    };
    f.validate = () => f.click('ファイルの内容を確認');
    f.save = () => f.click('この受信情報を登録');
    f.review = () => f.container.querySelector('[aria-label="X通知ファイルの登録確認"]');
    f.assertPrivate = () => { assert(!f.container.innerHTML.includes(SECRET)); assert.equal(f.dom.window.localStorage.length, 0); assert.equal(f.dom.window.sessionStorage.length, 0); };
    return f;
}

test('beginner setup leads with concrete steps and clearly explains manual upload, consent, sensitive data and receiver readiness', async () => {
    const f = await fixture({ opened: false });
    try {
        assert.equal(f.calls.length, 0); await f.click('X通知の受信設定を始める');
        assert.deepEqual(f.calls.map(call => call.route), ['x-setup']);
        const text = f.container.textContent;
        for (const pattern of [/WindowsのPC/, /すべて展開/, /ダブルクリックで開始\.cmd/, /専用Firefox/, /ベルを押し/, /ウィンドウをすべて閉じ/, /ここまでの作業は、ご自身のPC内で完了/]) assert.match(text, pattern);
        assert.match(text, /PCでファイルを作成/); assert.match(text, /サーバーの受信開始待ち/); assert.doesNotMatch(text, /X CONNECTION|STEP 1/);
        assert.match(text, /ツール専用のFirefox環境を作ります。普段使いのFirefoxと分けて使えます/);
        assert.match(text, /作成したファイルは、次の手順でこの画面からアップロード/);
        assert.doesNotMatch(text, /普段使いのFirefoxのデータは選ばないで|破棄することと.*別です|ファイルの登録だけでは通知は届きません/);
        assert(!text.includes('Angelic')); assert.equal(writes(f).length, 0); assert.equal(f.fileInput(), null);
        const download = f.container.querySelector('a[download]'); assert.equal(download.getAttribute('href'), '/api/automation/x-setup/download');
        assert.match(text, /0\.1\.0-preview\.4/); assert.match(text, /SHA-256/); f.assertPrivate();
        await f.showUpload(); const uploadText = f.container.textContent;
        for (const pattern of [/Cookie、閲覧履歴、保存パスワード/, /ファイル自体は暗号化せずに保存/, /それぞれの設定で通知を解除/, /他サイトの秘密鍵は含みません/, /暗号化された通知や識別情報もサーバーへ届く/, /受信後に破棄/, /運営側でそのデータを取得することは可能/, /別途明確な許可.*復号・利用・保存を行いません/, /他サイトの通知を利用する際は、あらためて許可を確認/, /Firefoxでも受け取れなくなる/]) assert.match(uploadText, pattern);
        assert.equal(f.fileInput().disabled, true);
        assert.match(f.consent().closest('label').textContent, /サーバーでX通知を受信・復号することに同意.*他サイトの通知も届く可能性.*別途許可するまでの破棄方針/);
        assert.doesNotMatch(text, /他サイトの通知は取得・登録しません/);
    } finally { await f.close(); }
});

test('unavailable intake preserves instructions/download and own deletion but cannot select or submit a file', async () => {
    const f = await fixture({ current: status({ available: false, reasonCode: 'X_SETUP_NOT_CONFIGURED', subscriptions: [subscription()] }) });
    try {
        assert.match(f.container.textContent, /ファイルの受付は準備中/); await f.click('PCでの準備手順を確認'); assert(f.container.querySelector('a[download]')); await f.showUpload();
        assert.equal(f.consent().disabled, true); assert.equal(f.fileInput().disabled, true);
        await f.choose(); await f.validate(); assert.equal(writes(f).length, 0);
        await f.click('受信情報を削除'); assert.equal(writes(f).length, 0); await f.click('この受信情報を削除');
        assert.deepEqual(writes(f), [{ route: 'x-setup/subscriptions/sub-1', method: 'DELETE', body: { expectedRevision: 1 } }]);
    } finally { await f.close(); }
});

test('explicit consent gates read/validation; review exposes safe metadata only and final save does not enable monitoring', async () => {
    const f = await fixture();
    try {
        await f.choose(); await f.validate(); assert.equal(writes(f).length, 0); assert.equal(f.review(), null);
        await f.agree(); await f.choose(); assert.equal(writes(f).length, 0); f.assertPrivate();
        await f.validate(); assert.deepEqual(writes(f).map(call => call.route), ['x-setup/sessions', 'x-setup/validate']);
        assert.equal(f.dom.window.document.activeElement, f.review());
        assert.deepEqual(writes(f)[0].body, { consent: true }); assert.equal(writes(f)[1].body.fileText, FILE);
        assert.match(f.review().textContent, /Firefox 160\.0a1/); assert(!f.review().textContent.includes('account-notifications'));
        assert.match(f.review().textContent, /その後、監視するアカウントと通知先を設定し、サーバーの接続状態を確認/);
        assert.match(f.review().textContent, /利用枠は監視するアカウントの登録時に確保/); f.assertPrivate();
        await f.save(); assert.deepEqual(writes(f)[2], { route: 'x-setup/import', method: 'POST', body: { sessionId: '1'.padStart(64, '0'), fileText: FILE, consent: true } });
        assert.equal(f.review(), null); assert.equal(f.consent(), undefined); assert.match(f.container.textContent, /受信情報を登録しました/);
        assert.match(f.container.textContent, /次に、下の一覧で接続状態を確認/); assert.match(f.container.textContent, /保存済み/);
        assert.match(f.dom.window.document.activeElement.textContent, /受信情報を登録しました/);
        assert.equal(f.container.querySelector('[aria-label="受信情報1"]').textContent.includes('sub-1'), false); f.assertPrivate();
        assert.equal(writes(f).some(call => call.route.startsWith('x-monitors')), false);
    } finally { await f.close(); }
});

test('file limits, extension and strict UTF-8 failures never send data', async () => {
    const f = await fixture();
    try {
        await f.agree();
        for (const [selection, message] of [[{ size: 32769 }, /容量の上限を超えています/], [{ name: 'profile.zip' }, /JSONファイルを選んで/], [{ bytes: Buffer.alloc(0) }, /JSONファイルを選んで/], [{ bytes: Buffer.from([0xc3, 0x28]) }, /UTF-8/]]) {
            await f.choose(selection); assert.match(f.container.textContent, message); await f.validate(); assert.equal(writes(f).length, 0);
        }
        f.assertPrivate();
    } finally { await f.close(); }
});

test('FileReader fallback supports browser files without arrayBuffer and exposes no contents', async () => {
    const f = await fixture();
    try {
        f.set('FileReader', f.dom.window.FileReader); await f.agree(); await f.choose({ native: true });
        for (let i = 0; i < 10 && !f.container.textContent.includes('ファイルを選択しました'); i++) await f.settle();
        await f.validate(); assert.equal(writes(f).at(-1).body.fileText, FILE); f.assertPrivate();
    } finally { await f.close(); }
});

test('cancel and withdrawal of consent erase selection and require selecting the file again', async () => {
    const f = await fixture();
    try {
        await f.agree(); await f.choose(); await f.validate(); await f.click('ファイルの選択を取り消す');
        assert.equal(f.review(), null); await f.validate(); assert.equal(writes(f).length, 2);
        await f.choose(); await f.validate(); await f.agree(); assert.equal(f.review(), null); assert.equal(f.fileInput().disabled, true);
        await f.agree(); await f.validate(); assert.equal(writes(f).length, 4); f.assertPrivate();
    } finally { await f.close(); }
});

test('server validation and import errors use safe fixed messages and erase the selected secret', async () => {
    for (const routeToFail of ['x-setup/validate', 'x-setup/import']) {
        const f = await fixture({ respond: route => { if (route === routeToFail) throw Object.assign(new Error(SECRET), { status: 422, code: 'X_SETUP_INVALID_FILE' }); } });
        try {
            await f.agree(); await f.choose(); await f.validate(); if (routeToFail.endsWith('/import')) await f.save();
            assert.match(f.container.textContent, /保存ツールでX通知データを作り直してください/); assert.equal(f.review(), null); f.assertPrivate();
            const before = writes(f).length; await f.validate(); assert.equal(writes(f).length, before);
        } finally { await f.close(); }
    }
});

test('used/expired/replaced sessions provide a recovery path through fresh selection and session', async () => {
    for (const code of ['X_SETUP_SESSION_INVALID', 'X_SETUP_SESSION_EXPIRED', 'X_SETUP_SESSION_USED']) {
        let rejected = false;
        const f = await fixture({ respond: route => { if (route === 'x-setup/import' && !rejected) { rejected = true; throw { code, status: 409, message: SECRET }; } } });
        try {
            await f.agree(); await f.choose(); await f.validate(); await f.save(); assert.match(f.container.textContent, /ファイルを選び直して、もう一度内容を確認/); assert.equal(f.review(), null);
            await f.choose(); await f.validate(); await f.save(); assert.equal(f.sessions, 2); assert.match(f.container.textContent, /受信情報を登録しました/); f.assertPrivate();
        } finally { await f.close(); }
    }
});

test('client expiry stops the import before sending the secret a second time', async () => {
    const f = await fixture(); const originalNow = Date.now;
    try {
        await f.agree(); await f.choose(); await f.validate(); const now = originalNow(); Date.now = () => now + 700000;
        await f.save(); assert.equal(writes(f).length, 2); assert.match(f.container.textContent, /確認から時間が経った/); assert.equal(f.review(), null); f.assertPrivate();
    } finally { Date.now = originalNow; await f.close(); }
});

test('duplicate import is described as already stored while identity conflicts never silently replace it', async () => {
    for (const duplicate of [true, false]) {
        const f = await fixture({ respond: route => { if (route === 'x-setup/import') { if (!duplicate) throw { code: 'X_SETUP_SUBSCRIPTION_CONFLICT', message: SECRET }; return { subscription: subscription(), duplicate: true }; } } });
        try {
            await f.agree(); await f.choose(); await f.validate(); await f.save();
            assert.match(f.container.textContent, duplicate ? /同じ受信情報が登録済み.*下の一覧で接続状態を確認/ : /ご自身の登録一覧を確認.*受信情報が別の登録と重複/);
            assert.equal(f.review(), null); assert.equal(writes(f).filter(call => call.method === 'DELETE').length, 0); f.assertPrivate();
        } finally { await f.close(); }
    }
});

test('deletion asks for confirmation, uses the current revision, clears upload and explains separate X revocation', async () => {
    const f = await fixture({ current: status({ subscriptions: [subscription({ revision: 7 })] }) });
    try {
        await f.agree(); await f.choose(); await f.validate(); await f.click('受信情報を削除'); assert.equal(f.review(), null); assert.equal(writes(f).length, 2);
        assert.match(f.container.querySelector('[aria-label="受信情報の削除確認"]').textContent, /監視するアカウントと利用枠は保持.*X・Firefox側の通知を止める場合.*それぞれの設定で解除/);
        await f.click('削除を取り消す'); assert.equal(writes(f).length, 2); await f.click('受信情報を削除'); await f.click('この受信情報を削除');
        assert.deepEqual(writes(f).at(-1).body, { expectedRevision: 7 }); assert.match(f.container.textContent, /それぞれの設定から解除/); f.assertPrivate();
    } finally { await f.close(); }
});

test('stale deletion preserves safe metadata until owner refresh and list pagination keeps existing rows', async () => {
    const f = await fixture({ current: status({ subscriptions: [subscription()], nextCursor: 'sub-1' }), respond: (route, method) => {
        if (method === 'DELETE') throw { code: 'REVISION_CONFLICT', message: SECRET };
        if (route === 'x-setup?afterId=sub-1') return status({ subscriptions: [subscription({ id: 'sub-2', revision: 2 })] });
    } });
    try {
        await f.click('受信情報を削除'); await f.click('この受信情報を削除'); assert.match(f.container.textContent, /一覧を更新してから/);
        assert(f.container.querySelector('[aria-label="受信情報1"]')); await f.click('受信情報をさらに表示');
        assert(f.container.querySelector('[aria-label="受信情報2"]')); assert.equal(f.container.textContent.includes('受信情報をさらに表示'), false); f.assertPrivate();
    } finally { await f.close(); }
});

test('rapid validation/import clicks start each operation once', async () => {
    let release;
    const f = await fixture({ respond: async route => { if (route === 'x-setup/import') { await new Promise(resolve => { release = resolve; }); return { subscription: subscription(), duplicate: false }; } } });
    try {
        await f.agree(); await f.choose(); const check = [...f.container.querySelectorAll('button')].find(item => item.textContent === 'ファイルの内容を確認');
        await f.act(async () => { check.click(); check.click(); }); assert.equal(f.sessions, 1);
        const save = [...f.container.querySelectorAll('button')].find(item => item.textContent === 'この受信情報を登録');
        await f.act(async () => { save.click(); save.click(); }); assert.equal(writes(f).filter(call => call.route.endsWith('/import')).length, 1);
        await f.act(async () => release()); assert.equal(f.review(), null); f.assertPrivate();
    } finally { if (release) release(); await f.close(); }
});

test('inactive views do no work and leaving during read or validation cannot restore a secret selection', async () => {
    const idle = await fixture({ active: false });
    try { assert.equal(idle.calls.length, 0); await idle.click('X通知の受信設定を始める'); assert.equal(idle.calls.length, 0); } finally { await idle.close(); }
    for (const pending of ['read', 'validate']) {
        let release, shouldBlock = true;
        const f = await fixture({ respond: async route => { if (pending === 'validate' && route === 'x-setup/validate' && shouldBlock) { shouldBlock = false; await new Promise(resolve => { release = resolve; }); return { valid: true, browserVersion: '160.0a1', scope: 'https://x.com/', formatVersion: 1 }; } } });
        try {
            await f.agree();
            if (pending === 'read') await f.choose({ arrayBuffer: () => new Promise(resolve => { release = () => resolve(Buffer.from(FILE).buffer); }) });
            else { await f.choose(); await f.validate(); }
            await f.renderSetup(false); const before = f.calls.length; await f.act(async () => release()); assert.equal(f.calls.length, before); assert.equal(f.review(), null);
            await f.renderSetup(true); await f.settle(); assert.equal(f.consent().checked, false); assert.equal(f.fileInput().disabled, true);
            await f.agree(); await f.validate(); assert.equal(writes(f).length, pending === 'read' ? 0 : 2); f.assertPrivate();
        } finally { if (release) release(); await f.close(); }
    }
});

test('a deletion response from a previous active view cannot replace a refreshed list or announce success', async () => {
    let release;
    const f = await fixture({ current: status({ subscriptions: [subscription()] }), respond: async (route, method) => {
        if (method === 'DELETE') { await new Promise(resolve => { release = resolve; }); return { deleted: true }; }
    } });
    try {
        await f.click('受信情報を削除'); await f.click('この受信情報を削除'); await f.renderSetup(false);
        f.current = status({ subscriptions: [subscription({ revision: 2 })] }); await f.renderSetup(true); await f.settle();
        await f.act(async () => release()); assert(f.container.querySelector('[aria-label="受信情報1"]'));
        assert.equal(f.container.textContent.includes('サービス上の受信情報を削除しました'), false);
    } finally { if (release) release(); await f.close(); }
});

test('malformed metadata and unsafe download/scope responses are rejected without displaying server strings', async () => {
    const f = await fixture({ current: status({ download: { url: 'https://attacker.test/' + SECRET, version: '0.1.0-preview.4', sha256: 'a'.repeat(64) } }) });
    try {
        assert.match(f.container.textContent, /受付状態と登録一覧を取得できません/); await f.click('PCでの準備手順を確認'); assert.equal(f.container.querySelector('a[download]').getAttribute('href'), '/api/automation/x-setup/download'); assert(!f.container.innerHTML.includes('attacker.test')); f.assertPrivate();
        for (const scope of ['http://x.com/', 'https://x.com.attacker.test/', 'https://name:password@x.com/', 'https://x.com/?key=' + SECRET, 'https://x.com', 'https://X.COM/']) assert.throws(() => f.exports.parseXSetupPreview({ valid: true, scope, browserVersion: '160.0a1', formatVersion: 1 }));
        assert.throws(() => f.exports.parseXSetupSubscription(subscription({ browserVersion: '<invalid version>' })));
        assert.throws(() => f.exports.parseXSetupSubscription(subscription({ createdAtMs: Number.MAX_SAFE_INTEGER })));
        assert.equal(f.exports.parseXSetupSubscription(subscription({ browserVersion: '1'.repeat(64) })).browserVersion.length, 64);
        assert.equal(f.exports.parseXSetupPreview({ valid: true, scope: 'https://x.com/' + 'a'.repeat(3000), browserVersion: '160.0a1', formatVersion: 1 }).scope, 'https://x.com/');
        assert.equal(f.exports.parseXSetupStatus(status({ receiverEnabled: true })).receiverEnabled, true);
        assert.equal(f.exports.xSetupFeedback(new Error(SECRET)).includes(SECRET), false);
    } finally { await f.close(); }
});

test('dedicated setup route authenticates before rendering, keys its state to the session and links back to targets', async () => {
    const f = await reactFixture('export {};'); let checks = 0;
    try {
        const Page = loadDashboard('app/dashboard/automation/x/page.tsx', {
            '@/lib/server-session': { requireDashboardSession: async () => { checks++; return { user: { id: 'owner-session-id' } }; } },
            '@/components/automation/x-notification-setup-screen': { XNotificationSetupScreen: () => f.React.createElement('p', null, '受信情報の登録画面') },
            '@/lib/server-locale': { getDashboardLocale: async () => 'ja' },
            '@/components/automation/automation-page-frame': { AutomationPageFrame: props => f.React.createElement('main', null, f.React.createElement('h1', null, props.title), props.children) },
        }).default;
        const content = await Page(); assert.equal(checks, 1); const screen = content.props.children; assert.equal(screen.key, 'owner-session-id'); assert.deepEqual(screen.props, {}); assert.equal(content.props.section, 'x');
        await f.render(content); assert.match(f.container.textContent, /Xの接続/);
        const denied = new Error('LOGIN_REQUIRED');
        const BlockedPage = loadDashboard('app/dashboard/automation/x/page.tsx', {
            '@/lib/server-session': { requireDashboardSession: async () => { throw denied; } },
            '@/components/automation/x-notification-setup-screen': { XNotificationSetupScreen: () => { throw new Error('Must not render'); } },
            '@/lib/server-locale': { getDashboardLocale: async () => 'ja' },
            '@/components/automation/automation-page-frame': { AutomationPageFrame: props => f.React.createElement('main', null, props.children) },
        }).default;
        await assert.rejects(BlockedPage(), error => error === denied);
    } finally { await f.close(); }
});

test('dedicated client starts with open instructions and sends only same-origin personal API requests', async () => {
    const f = await fixture({ opened: false }); const requests = [];
    try {
        f.set('fetch', async (address, options) => {
            requests.push({ address, options }); let result = status();
            if (address.endsWith('/sessions')) result = { sessionId: 'b'.repeat(64), expiresAtMs: Date.now() + 600000 };
            if (address.endsWith('/validate')) result = { valid: true, browserVersion: '160.0a1', scope: 'https://x.com/', formatVersion: 1 };
            if (address.endsWith('/import')) result = { subscription: subscription(), duplicate: false };
            if (address.endsWith('/x-processing-settings')) result = { requestedMode: 'batch', effectiveMode: 'batch', realtimeAllowed: false, planId: 'free', planLabel: '無料', intervalMinutes: 5, configured: true, reasonCode: null, rollout: { eligible: true } };
            return new Response(JSON.stringify(result), { status: 200 });
        });
        await f.render(f.React.createElement(f.exports.XNotificationSetupScreen)); await f.settle();
        assert.match(f.container.textContent, /すべて展開/); assert.equal(f.container.textContent.includes('X通知の受信設定を始める'), false);
        await f.showUpload(); await f.agree(); await f.choose(); await f.validate(); await f.save();
        assert.deepEqual(requests.filter(item => item.options.method === 'GET').map(item => item.address).sort(), ['/api/automation/x-processing-settings', '/api/automation/x-setup']);
        assert.deepEqual(requests.filter(item => item.options.method !== 'GET').map(item => item.address), ['/api/automation/x-setup/sessions', '/api/automation/x-setup/validate', '/api/automation/x-setup/import']);
        for (const { address, options } of requests) { assert(!address.includes('guildId')); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); const body = options.body ? JSON.parse(options.body) : {}; assert.equal(Object.hasOwn(body, 'ownerUserId'), false); assert.equal(Object.hasOwn(body, 'guildId'), false); }
        assert.deepEqual(JSON.parse(requests.find(item => item.address.endsWith('/sessions')).options.body), { consent: true }); f.assertPrivate();
    } finally { await f.close(); }
});

test('automation workspace advertises the dedicated setup entry only on the personal route', async () => {
    for (const guildId of [undefined, '333333333333333333']) {
        const f = await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
        try {
            f.set('sessionStorage', f.dom.window.sessionStorage);
            f.set('fetch', async address => {
                const route = new URL(address, 'http://fixture').pathname.slice('/api/automation/'.length); let result = { items: [], nextCursor: null };
                if (route === 'catalog') result = {};
                if (route === 'providers') result = { auto: [], price: [], autoRegistration: { eligible: false } };
                if (route === 'entitlements') result = { plan: { name: '無料', dayLimit: 24, minuteLimit: 5 }, slots: { used: 0, max: 5, available: 5 }, usage: { entries: [] } };
                return new Response(JSON.stringify(result), { status: 200 });
            });
            await f.render(f.React.createElement(f.exports.AutomationWorkspace, { viewerId: '222222222222222222', guildId })); await f.settle();
            assert.equal(Boolean(f.container.querySelector('header a[href="/dashboard/automation/x"]')), !guildId);
        } finally { await f.close(); }
    }
});

test('supporter beta and disabled rollout block uploads while keeping owned receiver metadata and deletion available', async () => {
    for (const rollout of [{ mode: 'supporters', eligible: false, reasonCode: 'X_ROLLOUT_SUPPORTERS_ONLY', reason: SECRET }, { mode: 'disabled', eligible: false, reasonCode: 'X_ROLLOUT_DISABLED', reason: SECRET }]) {
        const f = await fixture({ current: status({ available: true, rollout, subscriptions: [subscription()] }) });
        try {
            assert.equal(f.consent().disabled, true); assert.equal(f.fileInput().disabled, true);
            await f.agree(); await f.choose(); await f.validate(); assert.equal(writes(f).length, 0);
            assert.match(f.container.textContent, rollout.mode === 'supporters' ? /これまでに寄付いただいた方.*ベータ版.*ベータ参加や利用枠の購入ではありません/ : /公開準備中/);
            assert(f.container.querySelector('[aria-label="受信情報1"]')); await f.click('受信情報を削除'); await f.click('この受信情報を削除');
            assert.equal(writes(f)[0].method, 'DELETE'); f.assertPrivate();
        } finally { await f.close(); }
    }
});

test('stored receiver metadata distinguishes waiting, connecting, listening, reenrollment, stop and error without delivery claims', async () => {
    const states = ['awaiting', 'connecting', 'listening', 'requires_reenrollment', 'stopped', 'error'];
    const f = await fixture({ current: status({ receiverEnabled: true, subscriptions: states.map((receiverState, index) => subscription({ id: `safe-${index}`, receiverState, boundMonitorCount: index, lastReceivedAtMs: index === 2 ? 1791921600000 : null })) }) });
    try {
        const cards = states.map((state, index) => f.container.querySelector(`[aria-label="受信情報${index + 1}"]`));
        assert.match(cards[0].textContent, /サーバー接続待ち.*保存が完了.*サーバーとの接続を待っています/);
        assert.match(cards[1].textContent, /サーバー接続中.*接続を準備.*受信記録と通知先への配信結果/);
        assert.match(cards[2].textContent, /サーバー接続を確認済み.*投稿通知が届いたら.*配信結果を確認/);
        assert.match(cards[3].textContent, /再登録が必要.*専用Firefoxで通知を設定し直し.*新しいファイルを作成.*古い受信情報を削除して新しいファイルを登録.*監視するアカウントに設定/);
        assert.match(cards[4].textContent, /サーバー受信は停止中/); assert.match(cards[5].textContent, /サーバー接続の確認が必要/);
        assert.match(cards[2].textContent, /この受信情報を使う監視：2件/);
        assert.match(cards[0].textContent, /最初の受信を待っています/); assert.match(cards[2].textContent, /サーバーが最後に通知データ.*2026.*データの受信記録.*読み取りや通知先への配信結果は、別に確認/);
        assert.match(f.container.textContent, /専用Firefoxを閉じたまま/); assert.match(f.container.textContent, /サーバー接続を確認済み.*実際のX通知が通知先に届くことを確認.*確認後は、PCの電源を切って使えます/);
        assert.equal(writes(f).length, 0); f.assertPrivate();
    } finally { await f.close(); }
});

test('absent rollout and receiver state fail closed and malformed new metadata is rejected', async () => {
    const f = await fixture({ current: status({ rollout: undefined, subscriptions: [subscription()] }) });
    try {
        assert.equal(f.consent().disabled, true); assert.match(f.container.textContent, /サーバー接続待ち/);
        assert.equal(f.exports.parseXSetupSubscription(subscription()).receiverState, 'awaiting');
        assert.equal(f.exports.parseXSetupSubscription(subscription()).lastReceivedAtMs, null);
        for (const changes of [{ receiverState: 'delivered' }, { boundMonitorCount: -1 }, { boundMonitorCount: 1.5 }, { lastReceivedAtMs: -1 }, { lastReceivedAtMs: Number.MAX_SAFE_INTEGER }, { lastReceivedAtMs: '1791921600000' }]) assert.throws(() => f.exports.parseXSetupSubscription(subscription(changes)));
        for (const rollout of [{ mode: 'unknown', eligible: true }, { mode: 'public', eligible: 'true' }]) assert.throws(() => f.exports.parseXSetupStatus(status({ rollout })));
        assert.equal(writes(f).length, 0); f.assertPrivate();
    } finally { await f.close(); }
});

test('receipt status explains quarantined and unreadable data separately from connection and delivery success', async () => {
    const f = await fixture({ current: status({ receiverEnabled: true, subscriptions: [subscription({ receiverState: 'listening',
        lastReceivedAtMs: 1791921600000, receiptCounts: { received: 2, routed: 3, unsupported: 1, decryptionFailed: 4, unmatched: 5 } })] }) });
    try {
        const card = f.container.querySelector('[aria-label="受信情報1"]');
        const receipt = card.querySelector('[aria-label="受信データの処理状況"]');
        assert(receipt); assert.match(card.textContent, /サーバー接続を確認済み/);
        for (const pattern of [/処理待ち2件/, /振り分け処理済み3件/, /形式の確認が必要1件/, /内容の読み取りに失敗4件/]) assert.match(receipt.textContent, pattern);
        assert.match(receipt.textContent, /Xからの通知データは届いています.*形式の確認が必要な通知が1件.*送信処理に進んでいません.*保管されています.*管理者による対応が必要.*確認間隔を待つだけでは送信されません/);
        assert.match(receipt.textContent, /内容を読み取れなかった通知が4件.*送信処理に進んでいません.*管理者に受信情報の確認を依頼/);
        assert.match(receipt.textContent, /監視対象との一致を確認できない受信データ5件/);
        assert.match(receipt.textContent, /監視対象との一致を確認できず、送信していない受信データ：5件.*監視するアカウントと、この受信情報の割り当てを確認/);
        assert.match(receipt.textContent, /振り分け処理済みの件数は、通知先への送信成功数とは別.*配信結果は通知履歴/);
        assert.doesNotMatch(receipt.textContent, /送信成功3件|配信済み3件|データを作り直/);
        assert.equal(writes(f).length, 0); f.assertPrivate();
        f.current = status({ subscriptions: [subscription({ receiptCounts: { received: 0, routed: 0, unsupported: 0, decryptionFailed: 0, unmatched: 0 } })] });
        await f.click('受付状態・登録一覧を更新');
        const refreshed = f.container.querySelector('[aria-label="受信データの処理状況"]');
        assert.match(refreshed.textContent, /処理待ち0件/);
        assert.doesNotMatch(refreshed.textContent, /管理者による対応が必要|内容を読み取れなかった通知が|一致を確認できず、送信していない/);
    } finally { await f.close(); }
});

test('legacy setup responses omit the unknown breakdown and invalid receipt counts are rejected', async () => {
    const f = await fixture({ current: status({ subscriptions: [subscription()] }) });
    try {
        const parse = f.exports.parseXSetupSubscription;
        assert.equal(Object.hasOwn(parse(subscription()), 'receiptCounts'), false);
        assert.equal(f.container.querySelector('[aria-label="受信データの処理状況"]'), null);
        const valid = { received: 1, routed: 2, unsupported: 3, decryptionFailed: 4 };
        assert.deepEqual({ ...parse(subscription({ receiptCounts: valid })).receiptCounts }, valid);
        assert.deepEqual({ ...parse(subscription({ receiptCounts: { ...valid, unmatched: 5 } })).receiptCounts }, { ...valid, unmatched: 5 });
        for (const value of [null, [], {}, { ...valid, received: -1 }, { ...valid, routed: 1.5 }, { ...valid, unsupported: '3' },
            { ...valid, decryptionFailed: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, decryptionFailed: undefined },
            { ...valid, unmatched: null }, { ...valid, unmatched: '5' }, { ...valid, unmatched: -1 }, { ...valid, unmatched: 0.5 }]) {
            assert.throws(() => parse(subscription({ receiptCounts: value })));
        }
        assert.equal(writes(f).length, 0); f.assertPrivate();
    } finally { await f.close(); }
});

test('an unmatched post is distinct from a format error and old four-count responses stay compatible', async () => {
    const four = { received: 0, routed: 0, unsupported: 0, decryptionFailed: 0 };
    const f = await fixture({ current: status({ subscriptions: [subscription({ receiptCounts: four })] }) });
    try {
        let receipt = f.container.querySelector('[aria-label="受信データの処理状況"]');
        assert(receipt); assert.doesNotMatch(receipt.textContent, /一致を確認/);
        assert.equal(Object.hasOwn(f.exports.parseXSetupSubscription(subscription({ receiptCounts: four })).receiptCounts, 'unmatched'), false);
        f.current = status({ subscriptions: [subscription({ receiptCounts: { ...four, unmatched: 2 } })] });
        await f.click('受付状態・登録一覧を更新');
        receipt = f.container.querySelector('[aria-label="受信データの処理状況"]');
        assert.match(receipt.textContent, /監視対象との一致を確認できず、送信していない受信データ：2件/);
        assert.match(receipt.textContent, /形式の確認が必要0件/);
        assert.doesNotMatch(receipt.textContent, /管理者による対応が必要|確認間隔を待つだけ|送信成功2件/);
        assert.equal(writes(f).length, 0); f.assertPrivate();
    } finally { await f.close(); }
});

test('returning X users see current connection and their next action before optional PC setup instructions', async () => {
    const f = await fixture({ upload: false, current: status({ receiverEnabled: true, subscriptions: [subscription({ receiverState: 'listening', boundMonitorCount: 2 })] }) });
    try {
        const summary = f.container.querySelector('[aria-label="現在のX接続"]'); assert(summary); assert.match(summary.textContent, /接続を確認済み/);
        assert(summary.querySelector('a[href="/dashboard/automation#x-notifications"]')); assert.equal(f.container.querySelector('[aria-label="X通知の接続手順"]'), null); assert.equal(f.fileInput(), null);
        assert.equal(f.container.querySelector('a[download]'), null); assert.equal(writes(f).length, 0);
        await f.click('受信情報を追加・登録し直す'); assert.match(f.container.querySelector('[aria-label="X通知の接続手順"]').textContent, /ダブルクリックで開始\.cmd/);
        assert.match(f.container.querySelector('[aria-label="X通知の接続手順"]').textContent, /追加の設定後は専用Firefoxを閉じる.*すべて閉じて.*同時接続.*受信が競合/);
        await f.showUpload(); assert(f.container.querySelector('[aria-label="登録するデータと通知の取り扱い"]')); assert.equal(f.fileInput().disabled, true); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('an unbound saved receiver leads to monitor assignment and never presents connection or delivery as complete', async () => {
    const f = await fixture({ upload: false, current: status({ receiverEnabled: true, subscriptions: [subscription({ receiverState: 'awaiting', boundMonitorCount: 0 })] }) });
    try {
        const summary = f.container.querySelector('[aria-label="現在のX接続"]'); assert.match(summary.textContent, /監視への割り当て待ち/);
        assert.match(f.container.querySelector('[aria-label="受信情報1"]').textContent, /使用する自分の受信情報.*サーバーとの接続を進められます/);
        assert.doesNotMatch(summary.textContent, /接続を確認済み|配信済み|送信成功/); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('leaving the upload step clears the private file and consent before its guide or a new upload is opened', async () => {
    const f = await fixture();
    try {
        await f.agree(); await f.choose(); await f.validate(); const before = writes(f).length;
        await f.click('PCでの準備手順を確認'); assert.equal(f.review(), null); assert.equal(f.fileInput(), null); f.assertPrivate();
        await f.showUpload(); assert.equal(f.consent().checked, false); assert.equal(f.fileInput().disabled, true); await f.validate(); assert.equal(writes(f).length, before);
        await f.agree(); await f.validate(); assert.equal(writes(f).length, before); f.assertPrivate();
    } finally { await f.close(); }
});

test('a paginated receiver overview labels visible counts and does not assume all registrations are unbound', async () => {
    const f = await fixture({ upload: false, current: status({ subscriptions: [subscription({ boundMonitorCount: 0 })], nextCursor: 'sub-1' }) });
    try { const summary = f.container.querySelector('[aria-label="現在のX接続"]'); assert.match(summary.textContent, /表示中の受信情報1件/); assert.match(summary.textContent, /表示中の接続確認済み0件/); assert.match(summary.textContent, /続きの受信情報を確認/); assert.doesNotMatch(summary.textContent, /監視への割り当て待ち|接続の準備・確認中/); assert.equal(writes(f).length, 0); }
    finally { await f.close(); }
});

test('setup step navigation moves keyboard focus to the new step and preserves an empty consent boundary', async () => {
    const f = await fixture({ upload: false });
    try {
        await f.showUpload(); assert.match(f.dom.window.document.activeElement.textContent, /JSONファイルを登録/); assert.equal(f.consent().checked, false);
        await f.click('PCでの準備手順を確認'); assert.match(f.dom.window.document.activeElement.textContent, /PCでファイルを作成/); assert.equal(f.fileInput(), null); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});

test('embedded setup explicitly selects the exact owned connection without saving or leaving the registration draft', async () => {
    const chosen = [];
    const f = await fixture({ upload: false, current: status({ subscriptions: [subscription({ id: 'owned-first' }), subscription({ id: 'owned-second', revision: 4 })] }),
        setupProps: { embedded: true, initiallyOpen: true, onChooseSubscription: item => chosen.push(item) } });
    try {
        assert.match(f.container.textContent, /Xの接続を選ぶ/);
        assert.match(f.dom.window.document.activeElement.textContent, /Xの接続を選ぶ/);
        assert.equal(f.container.querySelector('a[href*="/dashboard/automation"]'), null);
        assert.equal(chosen.length, 0); assert.equal(writes(f).length, 0);
        const choose = f.container.querySelector('[aria-label="受信情報2"] footer button');
        await f.act(async () => { choose.click(); choose.click(); });
        assert.equal(chosen.length, 1); assert.equal(chosen[0].id, 'owned-second'); assert.equal(chosen[0].revision, 4);
        assert(f.container.querySelector('[aria-label="受信情報1"] footer button').disabled);
        assert.equal(writes(f).length, 0); f.assertPrivate();
    } finally { await f.close(); }
});

test('embedded new and replayed imports return the exact saved connection once after explicit consent and review', async () => {
    for (const duplicate of [false, true]) {
        const chosen = []; let changed = 0;
        const saved = subscription({ id: duplicate ? 'existing-saved' : 'new-saved', revision: 3 });
        const f = await fixture({ current: status({ subscriptions: [subscription({ id: 'unrelated-first' })] }),
            respond: route => route === 'x-setup/import' ? { subscription: saved, duplicate } : undefined,
            setupProps: { embedded: true, initiallyOpen: true, onChooseSubscription: item => chosen.push(item), onSubscriptionsChanged: () => changed++ } });
        try {
            assert.equal(chosen.length, 0); await f.choose(); await f.validate(); assert.equal(writes(f).length, 0);
            await f.agree(); await f.choose(); await f.validate();
            assert.match(f.review().textContent, /入力中の通知設定に戻ります.*通知先と利用枠を確認してから監視を開始/);
            assert.equal(chosen.length, 0); await f.save();
            assert.equal(chosen.length, 1); assert.equal(chosen[0].id, saved.id); assert.equal(chosen[0].revision, 3); assert.equal(changed, 1);
            assert.deepEqual(writes(f).map(call => call.route), ['x-setup/sessions', 'x-setup/validate', 'x-setup/import']);
            assert.equal(f.review(), null); assert.equal(f.fileInput(), null); f.assertPrivate();
            const select = f.container.querySelector('[aria-label="受信情報1"] footer button');
            await f.act(async () => select.click()); assert.equal(chosen.length, 1);
        } finally { await f.close(); }
    }
});

test('embedded cancellation invalidates pending import callbacks and clears private selection', async () => {
    let release; const chosen = []; let cancelled = 0;
    const f = await fixture({ respond: route => route === 'x-setup/import' ? new Promise(resolve => { release = () => resolve({ subscription: subscription(), duplicate: false }); }) : undefined,
        setupProps: { embedded: true, initiallyOpen: true, onChooseSubscription: item => chosen.push(item), onCancel: () => cancelled++ } });
    try {
        await f.agree(); await f.choose(); await f.validate(); await f.save();
        assert.equal(writes(f).filter(call => call.route.endsWith('/import')).length, 1);
        await f.click('通知の設定に戻る'); assert.equal(cancelled, 1); assert.equal(f.review(), null);
        await f.act(async () => release()); assert.equal(chosen.length, 0); assert.equal(f.consent().checked, false);
        assert.equal(f.fileInput().disabled, true); assert.doesNotMatch(f.container.textContent, /受信情報を登録しました/); f.assertPrivate();
    } finally { if (release) release(); await f.close(); }
});

test('embedded owned pagination preserves earlier connections and an unusable receiver cannot be selected', async () => {
    const chosen = [];
    const f = await fixture({ upload: false, current: status({ subscriptions: [subscription({ id: 'needs-new-file', receiverState: 'requires_reenrollment' })], nextCursor: 'needs-new-file' }),
        respond: route => route === 'x-setup?afterId=needs-new-file' ? status({ subscriptions: [subscription({ id: 'owned-next-page', receiverState: 'listening' })] }) : undefined,
        setupProps: { embedded: true, initiallyOpen: true, onChooseSubscription: item => chosen.push(item) } });
    try {
        let select = f.container.querySelector('[aria-label="受信情報1"] footer button'); assert(select.disabled);
        await f.act(async () => select.click()); assert.equal(chosen.length, 0);
        await f.click('受信情報をさらに表示'); assert(f.container.querySelector('[aria-label="受信情報1"]'));
        select = f.container.querySelector('[aria-label="受信情報2"] footer button'); await f.act(async () => select.click());
        assert.equal(chosen[0].id, 'owned-next-page'); assert.equal(writes(f).length, 0);
        assert.deepEqual(f.calls.map(call => call.route), ['x-setup', 'x-setup?afterId=needs-new-file']); f.assertPrivate();
    } finally { await f.close(); }
});

test('registration parent keeps target destination rule and realtime draft when embedded setup returns or is cancelled', async () => {
    const f = await fixture({ opened: false, current: status({ subscriptions: [subscription({ id: 'exact-connection' })] }) });
    function Registration() {
        const [draft, setDraft] = f.React.useState({ handle: 'test_user', name: '登録途中の表示名', destinationId: 'owned-destination', ruleId: 'selected-rule', processingMode: 'realtime', subscriptionId: '' });
        const [connecting, setConnecting] = f.React.useState(false);
        return f.React.createElement('section', null,
            f.React.createElement('output', { 'aria-label': '入力中の通知設定' }, JSON.stringify(draft)),
            connecting ? f.React.createElement(f.exports.XNotificationSetup, { api: f.api, initiallyOpen: true, embedded: true,
                onCancel: () => setConnecting(false), onChooseSubscription: item => { setDraft(previous => ({ ...previous, subscriptionId: item.id })); setConnecting(false); } })
                : f.React.createElement('button', { onClick: () => setConnecting(true) }, '接続を選ぶ'));
    }
    try {
        await f.render(f.React.createElement(Registration)); const initial = JSON.parse(f.container.querySelector('output').textContent);
        await f.click('接続を選ぶ'); await f.settle(); await f.click('通知の設定に戻る');
        assert.deepEqual(JSON.parse(f.container.querySelector('output').textContent), initial);
        await f.click('接続を選ぶ'); await f.settle(); await f.click('この接続を使う');
        assert.deepEqual(JSON.parse(f.container.querySelector('output').textContent), { ...initial, subscriptionId: 'exact-connection' });
        assert.equal(f.container.querySelector('[aria-label="X通知の受信設定"]'), null); assert.equal(writes(f).length, 0); f.assertPrivate();
    } finally { await f.close(); }
});

test('standalone receiver links identify the exact owned connection and keep processing details collapsed', async () => {
    const f = await fixture({ upload: false, current: status({ subscriptions: [subscription({ id: 'owned-with-receipts', receiverState: 'listening', receiptCounts: { received: 1, routed: 2, unsupported: 0, decryptionFailed: 0 } })] }) });
    try {
        const card = f.container.querySelector('[aria-label="受信情報1"]');
        assert.equal(card.querySelector('footer a').getAttribute('href'), '/dashboard/automation?xSubscriptionId=owned-with-receipts#x-notifications');
        const detail = card.querySelector('details'); assert.equal(detail.open, false);
        assert(detail.querySelector('[aria-label="受信データの処理状況"]'));
        assert.doesNotMatch(card.querySelector('header').textContent, /送信成功|配信済み/); assert.equal(writes(f).length, 0);
    } finally { await f.close(); }
});
