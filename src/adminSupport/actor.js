'use strict';

const DEFAULT_OWNER_ID = '796972193287503913';
const DEFAULT_ALLOWED_IDS = ['933314562487386122', DEFAULT_OWNER_ID];
const SNOWFLAKE = /^\d{16,22}$/;

function allowedActorIds(env = process.env) {
    const configured = env.ADMIN_ALLOWED_USER_IDS;
    const ids = configured ? configured.split(/[\s,]+/).filter(Boolean) : DEFAULT_ALLOWED_IDS;
    const allowed = new Set(ids.filter(value => SNOWFLAKE.test(value)));
    const owner = env.ADMIN_OWNER_ID || DEFAULT_OWNER_ID;
    if (owner && SNOWFLAKE.test(owner)) allowed.add(owner);
    return allowed;
}

function actorFromRequest(request, env = process.env) {
    // Only metadata supplied by the authenticated management core is trusted.
    // Fields in request.input are target data and never identify the operator.
    const actorId = request.actorId === undefined ? DEFAULT_OWNER_ID : request.actorId;
    if (typeof actorId !== 'string' || !SNOWFLAKE.test(actorId) || !allowedActorIds(env).has(actorId)) {
        throw Object.assign(new Error('The supplied administrator is not allowed to run support actions.'), { code: 'ADMIN_ACTOR_FORBIDDEN' });
    }
    const initiatedVia = request.initiatedVia === undefined ? 'automation' : request.initiatedVia;
    if (typeof initiatedVia !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(initiatedVia)) {
        throw Object.assign(new Error('Invalid trusted action origin.'), { code: 'ADMIN_ORIGIN_INVALID' });
    }
    return { actorId, initiatedVia };
}

function currentActorId() {
    return require('./telemetry').current()?.actor_id || DEFAULT_OWNER_ID;
}

module.exports = { DEFAULT_OWNER_ID, DEFAULT_ALLOWED_IDS, allowedActorIds, actorFromRequest, currentActorId };
