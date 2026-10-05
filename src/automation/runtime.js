'use strict';

const { hash } = require('./service');
const { scheduleDelivery } = require('./schedule');
const { SafetyError } = require('./safety');
const { DeliveryGateError } = require('./delivery-gate');
let singleton = null, timer = null, reviewTimer = null;

function createRunner(db, queue, transport, options = {}) {
    const clock = options.clock || Date.now;
    const assertAllowed = options.assertAllowed || require('../recoveryLease').assertAllowed;
    const notificationAllowed = options.notificationAllowed || require('../recoveryBootstrap').notificationAllowed;
    const isStopping = options.isStopping || (() => false);
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    async function reserve(job, now) {
        const keys = [hash('automation:discord:global'), hash(`automation:discord:destination:${job.destination_id || job.plan.context.webhookEndpointId || job.owner_user_id}`)].sort();
        return db.withDatabaseTransaction(async query => {
            let next = now;
            for (const key of keys) {
                await query('INSERT IGNORE INTO automation_counters (counter_key,used_count,expires_at_ms) VALUES (?,0,0)', [key]);
                const rows = await query('SELECT expires_at_ms FROM automation_counters WHERE counter_key=? FOR UPDATE', [key]);
                next = Math.max(next, Number(rows[0].expires_at_ms));
            }
            const reservedAt = Math.max(now, clock());
            if (next > reservedAt) return next;
            // Intentionally below Discord's global ceiling, including the
            // several permission-read requests needed to prepare each message.
            for (const key of keys) await query('UPDATE automation_counters SET expires_at_ms=? WHERE counter_key=?', [reservedAt + 2000, key]);
            return now;
        });
    }
    async function paceStep(job) {
        for (;;) {
            const now = clock();
            if (isStopping()) return { state: 'stopped', code: 'PROCESS_STOPPING', dueAtMs: now + 30000 };
            assertAllowed();
            const allowedAt = scheduleDelivery(now, job.plan.schedules, job.deadline_ms == null ? Infinity : Number(job.deadline_ms));
            if (allowedAt === null || allowedAt > now) return { state: allowedAt === null ? 'expired' : 'pending', code: 'WINDOW_CLOSED_DURING_DELIVERY', dueAtMs: allowedAt };
            if (queue.renewLease && !await queue.renewLease(job, now)) return { state: 'lease_lost' };
            const next = await reserve(job, now);
            if (next <= now) {
                // Counter/lease I/O can itself cross a quiet-hour boundary or
                // outlive our lease. Check again after those awaited operations.
                if (queue.renewLease && !await queue.renewLease(job, clock())) return { state: 'lease_lost' };
                if (isStopping()) return { state: 'stopped', code: 'PROCESS_STOPPING', dueAtMs: clock() + 30000 };
                assertAllowed();
                const time = clock(), allowed = scheduleDelivery(time, job.plan.schedules, job.deadline_ms == null ? Infinity : Number(job.deadline_ms));
                return allowed === null || allowed > time ? { state: allowed === null ? 'expired' : 'pending', code: 'WINDOW_CLOSED_DURING_DELIVERY', dueAtMs: allowed } : { state: 'ready' };
            }
            // Reserve each actual step against both durable counters. Keep a
            // short wakeup to honor shutdown, quiet hours and lease ownership;
            // a partly sent batch must never be returned to pending for pacing.
            await sleep(Math.max(1, Math.min(1000, next - clock())));
        }
    }
    async function tick() {
        if (isStopping()) return { state: 'stopped' };
        assertAllowed();
        let job = await queue.claim(clock());
        if (!job) return { state: 'idle' };
        let sending = false, confirmed = 0;
        try {
            if (queue.refreshFlowJob) {
                const refreshed = await queue.refreshFlowJob(job, clock());
                if (refreshed.state !== 'ready') {
                    if (refreshed.state !== 'lease_lost') await queue.transition(job, refreshed.state, refreshed.code, refreshed.dueAtMs);
                    return refreshed;
                }
                job = refreshed.job;
            }
            if (!notificationAllowed('automation_delivery', { id: job.id, run_id: job.run_id, target_kind: job.target_kind, target_id: job.target_id }, Number(job.created_at_ms))) {
                await queue.transition(job, 'cancelled', 'RECOVERY_QUARANTINED'); return { state: 'cancelled' };
            }
            const checked = await queue.check(job, clock());
            if (checked.state !== 'ready') {
                await queue.transition(job, checked.state, checked.code, checked.dueAtMs); return checked;
            }
            if (transport.readiness && !transport.readiness()) throw new SafetyError('SAFETY_VERIFIER_UNAVAILABLE', 'error');
            const next = await reserve(job, clock());
            if (next > clock()) {
                await queue.transition(job, 'pending', 'DISCORD_HEADROOM', next); return { state: 'paced' };
            }
            const prepared = await transport.prepare(job, checked.destination);
            if (isStopping()) { await queue.transition(job, 'pending', 'PROCESS_STOPPING', clock() + 30000); return { state: 'stopped' }; }
            assertAllowed();
            const begin = await queue.beginSend(job, clock());
            if (begin.state !== 'sending') {
                if (begin.state !== 'lease_lost') await queue.transition(job, begin.state, begin.code, begin.dueAtMs);
                return begin;
            }
            for (let index = 0; index < prepared.payloads.length; index++) {
                const paced = await paceStep(job);
                if (paced.state !== 'ready') {
                    if (paced.state === 'lease_lost') return paced;
                    const state = confirmed ? 'partial' : paced.state === 'stopped' ? 'pending' : paced.state;
                    await queue.transition(job, state, paced.code, paced.dueAtMs);
                    return { state: !confirmed && paced.state === 'stopped' ? 'stopped' : state };
                }
                sending = true;
                const id = await transport.sendStep(prepared, job, index);
                // An ACK persistence failure is unknown even when Discord
                // returned an ID; never assume it is safe to rerun the batch.
                await queue.acknowledgeStep(job, id);
                confirmed++; sending = false;
            }
            await queue.transition(job, 'sent');
            return { state: 'sent', steps: confirmed };
        } catch (error) {
            if (error instanceof DeliveryGateError) {
                if (error.state === 'lease_lost') return { state: 'lease_lost' };
                const state = confirmed ? 'partial' : error.state === 'stopped' ? 'pending' : error.state;
                await queue.transition(job, state, error.code, error.dueAtMs);
                return { state, code: error.code };
            }
            if (error instanceof SafetyError) {
                const state = confirmed ? 'partial' : error.decision === 'deny' ? 'excluded' : 'failed';
                await queue.transition(job, state, error.code);
                return { state, code: error.code };
            }
            if (error.code === 'AUTOMATION_PROVIDER_PACED') {
                await queue.transition(job, 'pending', 'PROVIDER_HEADROOM', clock() + error.retryAfterMs);
                return { state: 'paced', code: 'PROVIDER_HEADROOM' };
            }
            const status = Number(error.status);
            const throttled = status === 429 || error.name === 'RateLimitError';
            const unknown = sending && !throttled && !(status >= 400 && status < 500);
            const permanent = status >= 400 && status < 500 && !throttled;
            const terminal = unknown ? 'unknown' : confirmed ? 'partial' : permanent || Number(job.attempts) >= 9 ? 'failed' : 'pending';
            // Deliberately do not log error.message/stack/rawError. Discord
            // errors may include a signed webhook URL or message payload.
            const code = unknown ? 'DELIVERY_UNKNOWN' : confirmed ? 'PARTIAL_DELIVERY' : throttled ? 'DISCORD_RATE_LIMITED' : permanent ? 'DESTINATION_OR_POLICY_DENIED' : 'AUTOMATION_TRANSPORT_FAILED';
            const retryMs = throttled ? Math.max(60000, Number(error.retryAfter) || Number(error.retryAfterMs) || 0) : Math.min(3600000, 30000 * 2 ** Math.min(Number(job.attempts), 7));
            await db.queryDatabase('UPDATE automation_jobs SET attempts=attempts+1 WHERE id=? AND lease_token=?', [job.id, job.lease_token]);
            await queue.transition(job, terminal, code, terminal === 'pending' ? clock() + retryMs : null);
            return { state: terminal, code };
        }
    }
    return { tick };
}
function services(client) {
    if (singleton) return singleton;
    const db = require('../db');
    const service = require('./service').createService(db);
    const destinations = require('./destinations').createDestinations(db, service);
    const evaluator = require('./evaluation').createEvaluator(service.dictionaryData);
    const control = { stopped: false };
    const moderation = require('./moderation').createModeration(db, service, evaluator);
    const safety = require('./safety').createSafety({ matcher: moderation });
    const market = require('./marketplace').createMarketplace(db, { service, evaluator, moderationMatcher: moderation, safety, assertPublicationAllowed: () => {
        require('../recoveryLease').assertAllowed();
        if (control.stopped) throw new Error('PUBLICATION_REVIEW_STOPPED');
    } });
    const graphStore = require('./graph-store').createGraphStore(db);
    const queue = require('./queue').createQueue(db, evaluator, { graph: { enabled: true, store: graphStore } });
    const flow = require('./flow-runtime').createFlowRuntime(db, evaluator, graphStore, { assertEnabled: () => {
        if (control.stopped) throw new Error('FLOW_RUNTIME_STOPPED');
        require('../recoveryLease').assertAllowed();
    } });
    const transport = require('./transport').createTransport(db, destinations, client, { safety, beforeSubmit: async job => {
        if (control.stopped) throw new DeliveryGateError('stopped', 'PROCESS_STOPPING', Date.now() + 30000);
        require('../recoveryLease').assertAllowed();
        if (!await queue.renewLease(job)) throw new DeliveryGateError('lease_lost', 'SEND_LEASE_LOST');
        const checked = await queue.check(job);
        if (checked.state !== 'ready') throw new DeliveryGateError(checked.state, checked.code, checked.dueAtMs);
        if (control.stopped) throw new DeliveryGateError('stopped', 'PROCESS_STOPPING', Date.now() + 30000);
        require('../recoveryLease').assertAllowed();
    } });
    singleton = { queue, evaluator, flow, control, market, activeTick: null, activeFlowTick: null, activeReview: null, runner: createRunner(db, queue, transport, { isStopping: () => control.stopped }) };
    return singleton;
}
async function route(kind, delivery, now) {
    if (!singleton) throw Object.assign(new Error('Automation runner not started'), { code: 'AUTOMATION_NOT_STARTED' });
    return singleton.queue.route(kind, delivery, now);
}
function start(client) {
    if (timer) return;
    const runtime = services(client);
    const schedule = () => {
        if (runtime.control.stopped) return;
        timer = setTimeout(async () => {
            try {
                runtime.activeFlowTick = runtime.flow.tick(Date.now()); await runtime.activeFlowTick;
                runtime.activeTick = runtime.runner.tick(); await runtime.activeTick;
            }
            catch { console.error('[automation] durable queue tick failed; no message was retried implicitly'); }
            finally { runtime.activeFlowTick = null; runtime.activeTick = null; schedule(); }
        }, 1000);
        timer.unref?.();
    };
    schedule();
    const review = () => {
        if (runtime.control.stopped) return;
        reviewTimer = setTimeout(async () => {
            try {
                require('../recoveryLease').assertAllowed();
                runtime.activeReview = runtime.market.reviewPending(); await runtime.activeReview;
            } catch { console.error('[automation] legacy publication cleanup failed; publication remains blocked'); }
            finally { runtime.activeReview = null; review(); }
        }, 30000);
        reviewTimer.unref?.();
    };
    review();
}
async function stop() {
    const runtime = singleton;
    if (!runtime) return;
    runtime.control.stopped = true;
    clearTimeout(timer); timer = null;
    clearTimeout(reviewTimer); reviewTimer = null;
    singleton = null;
    // Keep a bounded opportunity to persist the current step ACK. If the
    // process deadline wins, the durable sending lease becomes unknown later.
    let deadline;
    try {
        if (runtime.activeTick || runtime.activeFlowTick || runtime.activeReview) await Promise.race([Promise.allSettled([runtime.activeTick, runtime.activeFlowTick, runtime.activeReview].filter(Boolean)), new Promise(resolve => { deadline = setTimeout(resolve, 8000); })]);
    } finally { clearTimeout(deadline); runtime.flow.clear(); runtime.evaluator.stop(); }
}
module.exports = { createRunner, start, stop, route };
