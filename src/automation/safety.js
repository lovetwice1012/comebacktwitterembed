'use strict';

const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const POLICY_VERSION = 'automation-mechanical-v1';
class SafetyError extends Error {
    constructor(code, decision = 'deny') {
        super(code); this.name = 'SafetyError'; this.code = code;
        this.decision = decision === 'deny' ? 'deny' : 'error'; this.beforeSubmission = true;
    }
}
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function checkTree(value, limit, state = { size: 0, nodes: 0, ancestors: new Set() }, depth = 0) {
    if (depth > 32 || ++state.nodes > limit) throw new SafetyError('SAFETY_INPUT_LIMIT');
    state.size += typeof value === 'string' ? Buffer.byteLength(value) + 2 : 8;
    if (state.size > limit) throw new SafetyError('SAFETY_INPUT_LIMIT');
    if (value === undefined || value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !plain(value) || state.ancestors.has(value)) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    state.ancestors.add(value);
    for (const [key, child] of Object.entries(value)) {
        state.size += Buffer.byteLength(key) + 3;
        checkTree(child, limit, state, depth + 1);
    }
    state.ancestors.delete(value);
}
function snapshotCandidate(candidate, limit) {
    // Bound depth, cycles, non-JSON objects and size before cloning/stringifying.
    checkTree(candidate, limit);
    const serialized = JSON.stringify(candidate);
    if (Buffer.byteLength(serialized) > limit) throw new SafetyError('SAFETY_INPUT_LIMIT');
    return { candidate: JSON.parse(serialized), fingerprint: digest(serialized) };
}
function checkBody(body, hasFiles) {
    if (body.content != null && typeof body.content !== 'string') throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    for (const key of ['embeds', 'components', 'attachments']) if (body[key] != null && (!Array.isArray(body[key]) || Array.from(body[key]).some(item => !plain(item)))) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    if (!body.content && !body.embeds?.length && !body.components?.length && !hasFiles) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    for (const embed of body.embeds || []) {
        for (const key of ['title', 'description', 'url', 'timestamp', 'type']) if (embed[key] != null && typeof embed[key] !== 'string') throw new SafetyError('SAFETY_INVALID_PAYLOAD');
        for (const key of ['author', 'footer', 'image', 'thumbnail', 'video', 'provider']) if (embed[key] != null && !plain(embed[key])) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
        if (embed.fields != null && (!Array.isArray(embed.fields) || Array.from(embed.fields).some(field => !plain(field) || typeof field.name !== 'string' || typeof field.value !== 'string'))) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
        if (!embed.title && !embed.description && !embed.fields?.length && !embed.image?.url && !embed.thumbnail?.url && !embed.video?.url && !embed.author?.name && !embed.footer?.text) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    }
}
function notificationCandidate(prepared, job) {
    if (!Array.isArray(prepared?.payloads) || !prepared.payloads.length || prepared.payloads.length > 128) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    if (!plain(job?.plan) || job.plan.event !== undefined && !plain(job.plan.event)) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    if (job.plan.members !== undefined && (!Array.isArray(job.plan.members) || job.plan.members.some(member => !plain(member) || member.event !== undefined && !plain(member.event)))) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
    const files = [];
    const payloads = Array.from(prepared.payloads, payload => {
        if (!plain(payload) || !plain(payload.body) || payload.files != null && !Array.isArray(payload.files)) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
        checkBody(payload.body, payload.files?.length > 0);
        if (payload.files?.length > 10) throw new SafetyError('SAFETY_INPUT_LIMIT');
        let bytes = 0;
        const metadata = Array.from(payload.files || [], file => {
            if (!file || !Buffer.isBuffer(file.data) && !(file.data instanceof Uint8Array)) throw new SafetyError('SAFETY_UNINSPECTABLE_ATTACHMENT');
            bytes += file.data.byteLength;
            if (bytes > 25 * 1024 * 1024) throw new SafetyError('SAFETY_INPUT_LIMIT');
            if (file.name != null && typeof file.name !== 'string' || file.key != null && typeof file.key !== 'string' || file.contentType != null && typeof file.contentType !== 'string') throw new SafetyError('SAFETY_INVALID_ATTACHMENT');
            files.push(file);
            return { name: file.name || file.key || '', key: file.key || null, contentType: file.contentType || null, bytes: file.data.byteLength, sha256: digest(file.data) };
        });
        return { body: payload.body, files: metadata };
    });
    const event = { ...job.plan.event };
    if (job.plan.members?.some(member => member.event?.sensitive === true)) event.sensitive = true;
    const destination = { kind: prepared.webhook ? 'webhook' : 'dm', channelId: prepared.channelId };
    if (prepared.webhook) {
        if (typeof prepared.webhook.id !== 'string' || typeof prepared.webhook.token !== 'string') throw new SafetyError('SAFETY_INVALID_PAYLOAD');
        destination.webhookId = prepared.webhook.id; destination.tokenHash = digest(prepared.webhook.token);
    }
    const candidate = { purpose: 'notification', policyVersion: POLICY_VERSION, targetKind: job.target_kind,
        event, destination, channelNsfw: prepared.channelNsfw === true, payloads };
    return { ...snapshotCandidate(candidate, 2 * 1024 * 1024), files };
}
function createSafety(options = {}) {
    const clock = options.clock || Date.now;
    const verifier = Object.hasOwn(options, 'verifier') ? options.verifier : require('./mechanical-safety').createMechanicalVerifier({ matcher: options.matcher, clock });
    async function inspectSnapshot(snapshot) {
        // Approval means only that the declared mechanical checks passed.
        // An unavailable checker fails this operation; it never queues review.
        let timer;
        try {
            if (typeof verifier?.inspect !== 'function') throw new SafetyError('SAFETY_VERIFIER_UNAVAILABLE', 'error');
            const { candidate, fingerprint, files = [] } = snapshot();
            const timeoutMs = options.timeoutMs ?? 10000;
            if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new SafetyError('SAFETY_CHECK_FAILED', 'error');
            const result = await Promise.race([
                verifier.inspect({ candidate, fingerprint, files }),
                new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new SafetyError('SAFETY_CHECK_TIMEOUT', 'error')), timeoutMs); }),
            ]);
            const now = clock();
            if (!Number.isFinite(now) || !result || result.fingerprint !== fingerprint || result.policyVersion !== POLICY_VERSION || typeof result.detectorVersion !== 'string' || !result.detectorVersion || !Number.isFinite(result.expiresAtMs) || result.expiresAtMs <= now || result.expiresAtMs > now + 60000) throw new SafetyError('SAFETY_INVALID_ASSESSMENT', 'error');
            if (result.decision !== 'allow') throw new SafetyError(result.decision === 'deny' ? 'SAFETY_CONTENT_DENIED' : 'SAFETY_INVALID_ASSESSMENT', result.decision === 'deny' ? 'deny' : 'error');
            // Async inspectors may not mutate the object subsequently sent.
            if (snapshot().fingerprint !== fingerprint) throw new SafetyError('SAFETY_PAYLOAD_CHANGED');
            return { fingerprint, detectorVersion: result.detectorVersion, policyVersion: POLICY_VERSION };
        } catch (error) {
            if (error instanceof SafetyError) throw error;
            throw new SafetyError('SAFETY_CHECK_FAILED', 'error');
        } finally { clearTimeout(timer); }
    }
    const assertNotification = (prepared, job) => inspectSnapshot(() => notificationCandidate(prepared, job));
    const assertPublication = pack => inspectSnapshot(() => {
        if (!plain(pack)) throw new SafetyError('SAFETY_INVALID_PAYLOAD');
        const candidate = { purpose: 'publication', policyVersion: POLICY_VERSION, packageId: pack.id, version: pack.version,
            title: pack.title, description: pack.description, category: pack.category, changelog: pack.changelog, ownerUserId: pack.owner_user_id, bundle: pack.bundle };
        return snapshotCandidate(candidate, 128 * 1024 * 1024);
    });
    return { assertNotification, assertPublication, status: () => ({ available: typeof verifier?.inspect === 'function', mode: 'mechanical', policyVersion: POLICY_VERSION, reviewRequired: false, semanticAccuracyClaimed: false }) };
}
module.exports = { createSafety, SafetyError, POLICY_VERSION, notificationCandidate };
