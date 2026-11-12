'use strict';
// Research-only composition; no production entry point imports this file.
// A lost OS lock is not itself a fence for work already in progress.
const fail = code => Object.assign(new Error(code), { code });
async function runResearchSession({ acquire, readIndex, work, settleTimeoutMs = 1000 }) {
    if (typeof acquire !== 'function' || typeof readIndex !== 'function' || typeof work !== 'function'
        || !Number.isInteger(settleTimeoutMs) || settleTimeoutMs < 1 || settleTimeoutMs > 10000) throw fail('RESEARCH_INVALID');
    const lease = await acquire();
    let release, lostNotifier;
    try { release = lease?.release; } catch { throw fail('RESEARCH_INVALID'); }
    if (typeof release !== 'function') throw fail('RESEARCH_INVALID');
    async function releaseLease() {
        let timer;
        const releasing = Promise.resolve().then(() => release.call(lease)).then(() => 'done', () => 'failed');
        const status = await Promise.race([releasing, new Promise(resolve => { timer = setTimeout(() => resolve('pending'), settleTimeoutMs); })]);
        clearTimeout(timer);
        if (status !== 'done') throw fail(status === 'pending' ? 'RESEARCH_RELEASE_PENDING' : 'RESEARCH_RELEASE_FAILED');
    }
    try { lostNotifier = lease.lost; if (!lostNotifier || typeof lostNotifier.then !== 'function') throw fail('RESEARCH_INVALID'); }
    catch { await releaseLease(); throw fail('RESEARCH_INVALID'); }
    const controller = new AbortController();
    const running = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw fail('RESEARCH_LOCK_LOST');
        const index = await readIndex({ signal: controller.signal });
        if (controller.signal.aborted) throw fail('RESEARCH_LOCK_LOST');
        return work({ index, signal: controller.signal });
    }).then(value => ({ kind: 'done', value }), () => ({ kind: 'work_failed' }));
    const lost = Promise.resolve(lostNotifier).then(() => ({ kind: 'lost' }), () => ({ kind: 'lost' }));
    try {
        const result = await Promise.race([running, lost]);
        if (result.kind === 'lost') {
            controller.abort(); let timer;
            const settled = await Promise.race([running.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), settleTimeoutMs); })]);
            clearTimeout(timer);
            throw fail(settled ? 'RESEARCH_LOCK_LOST' : 'RESEARCH_CLEANUP_PENDING');
        }
        if (result.kind !== 'done') throw fail('RESEARCH_WORK_FAILED');
        return result.value;
    } finally {
        controller.abort(); await releaseLease();
    }
}
module.exports = { runResearchSession };
