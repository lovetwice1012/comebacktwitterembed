'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NODE_TYPES, newWorkflow } = require('../../src/automation/schema');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { template } = require('../../src/automation/catalog');

test('current main defaults stay normal while explicit expanded output remains available', () => {
    const event = { providerId: 'youtube', kind: 'new', sourceKey: 'fixture', contentId: 'fixture', url: 'https://www.youtube.com/watch?v=fixture', observedAtMs: 1000 };
    assert.equal(NODE_TYPES.transform.defaults.format, 'normal');
    assert.equal(evaluateWorkflow(newWorkflow(), event, { now: 1000 }).outputs[0].display.format, 'normal');
    assert.equal(template().nodes.find(node => node.type === 'transform').config.format, 'normal');
    const explicit = evaluateWorkflow(template('all', 'now', 'expanded'), event, { now: 1000 }).outputs[0];
    assert.equal(explicit.display.format, 'expanded');
    assert.ok(explicit.text.includes(event.url));
});

test('Push fixtures preserve leading zeroes in the fixed-width P-256 JWK scalar', () => {
    const { fixture } = require('./helpers/x-push-fixture.cjs');
    const { identifyTransfer } = require('../../src/automation/x-setup-transfer');
    for (const scalar of [Buffer.from([1]), Buffer.from([255]), Buffer.from([1, 0])]) {
        const value = fixture({ privateKey: scalar });
        const encoded = Buffer.from(value.push.p256dhPrivateKey.d, 'base64url');
        assert.equal(encoded.length, 32);
        assert.deepEqual(encoded.subarray(32 - scalar.length), scalar);
        assert.ok(encoded.subarray(0, 32 - scalar.length).every(octet => octet === 0));
        assert.match(identifyTransfer(value).contentHash, /^[0-9a-f]{64}$/);
    }
});
