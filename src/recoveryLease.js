'use strict';

// Defense in depth for each workload process. The independent guardian and its
// systemd cgroup fence remain responsible when the Node event loop is stalled.
const fs = require('node:fs');
let monitor;

function assertAllowed(env = process.env, now = Date.now()) {
    const filename = env.CBTE_FLEET_LEASE_FILE;
    if (!filename) return null; // Existing development/unenrolled installations.
    try {
        const bytes = fs.readFileSync(filename);
        if (bytes.length > 16384) throw new Error('Lease file exceeds its limit.');
        const lease = JSON.parse(bytes.toString('utf8'));
        if (!['active', 'renewal_unconfirmed'].includes(lease.state)
            || lease.node !== env.CBTE_FLEET_NODE
            || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
            || (env.CBTE_FLEET_EPOCH !== undefined && String(lease.epoch) !== String(env.CBTE_FLEET_EPOCH))
            || !Number.isFinite(lease.validUntilUnixMs) || lease.validUntilUnixMs <= now) {
            throw new Error('This process has no current fleet activation lease.');
        }
        return lease;
    } catch (cause) {
        throw Object.assign(new Error('The recovery guardian has not authorized this workload to run.', { cause }), {
            code: 'FLEET_LEASE_INVALID',
        });
    }
}

function install() {
    const lease = assertAllowed();
    if (lease && process.env.CBTE_FLEET_EPOCH === undefined) process.env.CBTE_FLEET_EPOCH = String(lease.epoch);
    if (!process.env.CBTE_FLEET_LEASE_FILE || monitor) return;
    monitor = setInterval(() => {
        try { assertAllowed(); }
        catch {
            process.stderr.write('Recovery lease expired; stopping this workload.\n');
            clearInterval(monitor);
            process.kill(process.pid, 'SIGTERM');
            setTimeout(() => process.exit(75), 1000).unref();
        }
    }, 1000);
    monitor.unref();
}

function guardDiscord(discord) {
    if (!process.env.CBTE_FLEET_LEASE_FILE || !discord.REST?.prototype?.queueRequest) return;
    const prototype = discord.REST.prototype;
    const marker = Symbol.for('cbte.recoveryLease.discordGuard');
    if (prototype[marker]) return;
    const original = prototype.queueRequest;
    prototype.queueRequest = function (...args) {
        assertAllowed();
        return original.apply(this, args);
    };
    prototype[marker] = true;
}

module.exports = { assertAllowed, install, guardDiscord };
