'use strict';

// Chrome DevTools over inherited anonymous pipes, never a debugger TCP port.
// Only fixed commands for selecting the X page, reading its PushSubscription
// and closing this dedicated browser are exposed to the local broker.
const fault = code => Object.assign(new Error(code), { code });
function createChromePipe(chrome, { origin = 'https://x.com', timeoutMs = 10000, includeApplicationServerKey = false } = {}) {
    if (!chrome?.stdio?.[3] || !chrome?.stdio?.[4] || typeof origin !== 'string'
        || typeof includeApplicationServerKey !== 'boolean'
        || (origin !== 'https://x.com' && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin))) throw fault('X_CHROME_PIPE_INVALID');
    const input = chrome.stdio[3], output = chrome.stdio[4], waiting = new Map();
    let sequence = 0, buffer = Buffer.alloc(0), failed = false;
    function abort() {
        if (failed) return; failed = true;
        for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(fault('X_CHROME_PIPE_CLOSED')); }
        waiting.clear();
    }
    output.on('data', chunk => {
        if (failed) return;
        if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > 1024 * 1024) { abort(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            const end = buffer.indexOf(0); if (end < 0) break;
            const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
            try {
                const message = JSON.parse(frame.toString('utf8'));
                if (!Number.isSafeInteger(message.id) || !waiting.has(message.id)) continue;
                const item = waiting.get(message.id); waiting.delete(message.id); clearTimeout(item.timer);
                if (message.error || !message.result) item.reject(fault('X_CHROME_PIPE_COMMAND_FAILED'));
                else item.resolve(message.result);
            } catch { abort(); return; }
        }
    });
    output.on('error', abort); output.on('end', abort); input.on('error', abort); chrome.on('error', abort); chrome.on('exit', abort);
    function call(method, params = {}, sessionId) {
        if (failed || waiting.size >= 4 || sequence >= Number.MAX_SAFE_INTEGER) return Promise.reject(fault('X_CHROME_PIPE_CLOSED'));
        const id = ++sequence, data = Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { waiting.delete(id); reject(fault('X_CHROME_PIPE_TIMEOUT')); }, timeoutMs);
            waiting.set(id, { resolve, reject, timer });
            try { input.write(data, error => { if (error) abort(); }); } catch { abort(); }
        });
    }
    async function ready() {
        const version = await call('Browser.getVersion');
        if (typeof version.product !== 'string' || !/^Chrome\/[0-9]{1,3}(?:\.[0-9]{1,5}){3}$/.test(version.product)) throw fault('X_CHROME_PIPE_INVALID');
        return version.product.slice('Chrome/'.length);
    }
    async function capture() {
        const result = await call('Target.getTargets');
        if (!Array.isArray(result.targetInfos) || result.targetInfos.length > 256) throw fault('X_CHROME_CAPTURE_INVALID');
        const matches = result.targetInfos.filter(target => {
            try { return target && target.type === 'page' && new URL(target.url).origin === origin; } catch { return false; }
        });
        if (!matches.length) throw fault('X_CHROME_CAPTURE_NOT_FOUND');
        if (matches.length > 8 || new Set(matches.map(target => target.browserContextId || '')).size !== 1
            || matches.some(target => typeof target.targetId !== 'string' || !target.targetId || target.targetId.length > 256)
            || new Set(matches.map(target => target.targetId)).size !== matches.length) throw fault('X_CHROME_CAPTURE_AMBIGUOUS');
        const captureTarget = async target => {
            const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
            if (typeof attached.sessionId !== 'string' || attached.sessionId.length > 256) throw fault('X_CHROME_CAPTURE_INVALID');
            try {
            const expression = `(async()=>{if(location.origin!==${JSON.stringify(origin)})throw Error('origin');const found=[];` +
                `for(const r of await navigator.serviceWorker.getRegistrations()){if(new URL(r.scope).origin!==${JSON.stringify(origin)})continue;` +
                `const s=await r.pushManager.getSubscription();if(s){const v={scope:r.scope,...s.toJSON()};` +
                (includeApplicationServerKey ? `const k=s.options?.applicationServerKey;if(!k||k.byteLength!==65)throw Error('key');v.applicationServerKey=btoa(String.fromCharCode(...new Uint8Array(k))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');` : '') +
                `found.push(v);}}` +
                `if(location.origin!==${JSON.stringify(origin)}||found.length!==1)throw Error('subscription');return found[0]})()`;
            const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, attached.sessionId);
            const value = response.result?.value;
            if (response.exceptionDetails || response.result?.type !== 'object' || !value || typeof value.scope !== 'string'
                || typeof value.endpoint !== 'string' || value.scope.length > 4096 || value.endpoint.length > 4096 || !value.keys
                || typeof value.keys.p256dh !== 'string' || typeof value.keys.auth !== 'string'
                || includeApplicationServerKey && (typeof value.applicationServerKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(value.applicationServerKey)
                    || Buffer.from(value.applicationServerKey, 'base64url').toString('base64url') !== value.applicationServerKey)) throw fault('X_CHROME_CAPTURE_INVALID');
                return { scope: value.scope, endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
                    ...(includeApplicationServerKey ? { applicationServerKey: value.applicationServerKey } : {}) };
            } finally { await call('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {}); }
        };
        let selected;
        for (const target of matches) {
            let value;
            try { value = await captureTarget(target); }
            catch (error) { if (matches.length > 1) throw fault('X_CHROME_CAPTURE_AMBIGUOUS'); throw error; }
            if (selected && (value.scope !== selected.scope || value.endpoint !== selected.endpoint
                || value.keys.p256dh !== selected.keys.p256dh || value.keys.auth !== selected.keys.auth
                || includeApplicationServerKey && value.applicationServerKey !== selected.applicationServerKey))
                throw fault('X_CHROME_CAPTURE_AMBIGUOUS');
            selected = value;
        }
        return selected;
    }
    async function closeBrowser() {
        if (chrome.exitCode !== null) return;
        const exited = new Promise(resolve => chrome.once('exit', resolve));
        await call('Browser.close').catch(() => {});
        let timer;
        try { await Promise.race([exited, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(fault('X_CHROME_CAPTURE_TIMEOUT')), 15000); })]); }
        finally { clearTimeout(timer); }
    }
    return { ready, capture, closeBrowser };
}
module.exports = { createChromePipe };
