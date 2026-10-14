'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NODE_TYPES, newWorkflow } = require('../../src/automation/schema');
const { evaluateWorkflow } = require('../../src/automation/engine');
const { template } = require('../../src/automation/catalog');

test('existing notification defaults stay expanded while explicit normal output remains available', () => {
    const event = { providerId: 'youtube', kind: 'new', sourceKey: 'fixture', contentId: 'fixture', url: 'https://www.youtube.com/watch?v=fixture', observedAtMs: 1000 };
    assert.equal(NODE_TYPES.transform.defaults.format, 'expanded');
    assert.equal(evaluateWorkflow(newWorkflow(), event, { now: 1000 }).outputs[0].display.format, 'expanded');
    assert.equal(template().nodes.find(node => node.type === 'transform').config.format, 'expanded');
    const explicit = evaluateWorkflow(template('all', 'now', 'normal'), event, { now: 1000 }).outputs[0];
    assert.equal(explicit.display.format, 'normal');
    assert.ok(explicit.text.includes(event.url));
});
