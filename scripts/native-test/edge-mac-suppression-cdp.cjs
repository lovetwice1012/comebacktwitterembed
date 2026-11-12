'use strict';
// Hosted fixture CDP over the already-owned pipe. No general product API.
async function withFixtureCdp(child, work) {
    if (!child?.stdio?.[3] || !child?.stdio?.[4] || typeof work !== 'function') throw new Error('FIXTURE_CDP_INVALID');
    const input = child.stdio[3], output = child.stdio[4], pending = new Map();
    let sequence = 1000000000, buffer = Buffer.alloc(0), stopped = false;
    const fail = () => {
        if (stopped) return; stopped = true;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('FIXTURE_CDP_CLOSED')); }
        pending.clear();
    };
    const onData = chunk => {
        if (stopped) return;
        if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > 1024 * 1024) return fail();
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            const end = buffer.indexOf(0); if (end < 0) return;
            const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1); let message;
            try { message = JSON.parse(frame.toString('utf8')); } catch { return fail(); }
            const item = pending.get(message.id); if (!item) continue;
            pending.delete(message.id); clearTimeout(item.timer);
            if (message.error || !message.result) item.reject(new Error('FIXTURE_CDP_FAILED')); else item.resolve(message.result);
        }
    };
    output.on('data', onData); output.on('error', fail); input.on('error', fail); child.on('exit', fail); child.on('error', fail);
    const call = (method, params = {}, sessionId) => {
        if (stopped || pending.size >= 4 || sequence >= 1000000100) {
            const rejected = Promise.reject(new Error('FIXTURE_CDP_INVALID')); rejected.catch(() => {}); return rejected;
        }
        const id = ++sequence;
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('FIXTURE_CDP_TIMEOUT')); }, 10000);
            pending.set(id, { resolve, reject, timer });
            try { input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) fail(); }); }
            catch { fail(); }
        });
        // Observe even a caller-abandoned fixture request; callers awaiting the
        // original promise still receive its rejection.
        response.catch(() => {}); return response;
    };
    try {
        const value = await work(call);
        if (pending.size) throw new Error('FIXTURE_CDP_PENDING');
        return value;
    }
    finally {
        fail(); buffer.fill(0); output.removeListener('data', onData); output.removeListener('error', fail);
        input.removeListener('error', fail); child.removeListener('exit', fail); child.removeListener('error', fail);
    }
}
module.exports = { withFixtureCdp };
