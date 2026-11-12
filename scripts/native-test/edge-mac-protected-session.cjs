'use strict';
// Unpublished experiment: the caller supplies an already loaded research addon.
// It does not verify signing, establish legacy-version exclusion, or load code.
const { isMainThread } = require('node:worker_threads');
const fail = code => Object.assign(new Error(code), { code });
async function runProtectedExperiment({ base, addon, execute }) {
    if (!isMainThread || typeof base !== 'string' || !addon || typeof execute !== 'function'
        || ['acquire', 'begin', 'end', 'release'].some(name => typeof addon[name] !== 'function')) throw fail('RESEARCH_SESSION_INVALID');
    let acquired;
    try { acquired = addon.acquire(base); } catch { throw fail('RESEARCH_SESSION_INVALID'); }
    if (acquired === 'BUSY') throw fail('RESEARCH_SESSION_BUSY');
    if (acquired !== 'OK') throw fail('RESEARCH_SESSION_INVALID');
    let started;
    try { started = addon.begin(); } catch { throw fail('RESEARCH_SESSION_GUARD_UNCERTAIN'); }
    // Without a successful begin there is no proof that release is safe.
    if (started !== 'OK') throw fail('RESEARCH_SESSION_GUARD_UNCERTAIN');
    let value;
    // An error may represent deferred browser/listener cleanup. Do not infer
    // from a rejected Promise that the side effects are finished.
    try { value = await execute(); } catch { throw fail('RESEARCH_SESSION_WORK_UNCERTAIN'); }
    let ended;
    try { ended = addon.end(); } catch { ended = 'INVALID'; }
    if (ended !== 'OK') throw fail('RESEARCH_SESSION_GUARD_UNCERTAIN');
    let released;
    try { released = addon.release(); } catch { released = 'INVALID'; }
    if (released !== 'OK') throw fail('RESEARCH_SESSION_RELEASE_UNCERTAIN');
    return value;
}
module.exports = { runProtectedExperiment };
