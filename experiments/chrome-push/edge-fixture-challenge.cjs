'use strict';
// Research helper for synthetic values only. Product identifiers and keys are
// supplied by the test; no browser values or production credentials are stored.
const { challengeResponse } = require('../../src/automation/edge-wns-auth');
function syntheticChallengeResponse(challenge, productKey, productId) {
    try { return challengeResponse(challenge, productKey, productId); }
    catch { throw new Error('PROBE_CHALLENGE_INPUT_INVALID'); }
}
function rewriteSyntheticChallenge(frame, challenge, productKey, productId) {
    if (!Buffer.isBuffer(frame) || frame.length > 262144) throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
    const text = frame.toString('ascii');
    if (!/^PUT \d+ WNS\\CHALLENGE /.test(text)) throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
    const get = tag => {
        const values = [...text.matchAll(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'g'))];
        if (values.length !== 1) throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
        return values[0][1];
    };
    const id = get('appId'), previous = get('response');
    if (!Buffer.isBuffer(productId) || !Buffer.from(id, 'ascii').equals(productId) || !/^[0-9a-f]{32}$/i.test(previous))
        throw new Error('PROBE_CHALLENGE_FRAME_INVALID');
    const result = syntheticChallengeResponse(challenge, productKey, productId);
    try {
        let replacement = result.toString('hex');
        if (/[A-F]/.test(previous) && !/[a-f]/.test(previous)) replacement = replacement.toUpperCase();
        const output = Buffer.from(text.replace(`<response>${previous}</response>`, `<response>${replacement}</response>`), 'ascii');
        if (output.length !== frame.length) { output.fill(0); throw new Error('PROBE_CHALLENGE_FRAME_INVALID'); }
        return output;
    } finally { result.fill(0); }
}
module.exports = { syntheticChallengeResponse, rewriteSyntheticChallenge };
