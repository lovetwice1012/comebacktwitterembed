'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planLastDetails } = require('../../src/providers/twitter/lastDetailsPlan');
const groupId = 'a'.repeat(32);

function makeParts() {
    return [{ files: ['1', '2'], embeds: [{ description: 'text' }], components: [{ type: 1 }],
        send: 'reply-source', deleteSource: true, twitterGrid: { imageUrls: ['1', '2'], sequence: 0, totalParts: 2, embedStart: 0, embedEnd: 1 } },
    { files: ['3'], send: 'channel', requiresPreviousSuccess: true, twitterGrid: { imageUrls: ['3'], sequence: 1, totalParts: 2 } }];
}

test('split photo messages keep their order and put details on the final anchor', () => {
    const input = makeParts(), output = planLastDetails(input, groupId);
    assert.deepEqual(output.map(part => part.files), [['1', '2'], ['3']]);
    assert.equal(output[0].send, 'reply-source');
    assert.equal(output[0].deleteSource, true);
    assert.equal(output[0].embeds, undefined);
    assert.deepEqual(output[0].twitterGridLead, { groupId, imageUrls: ['1', '2'] });
    assert.deepEqual(output[1].embeds, [{ description: 'text' }]);
    assert.deepEqual(output[1].components, [{ type: 1 }]);
    assert.equal(output[1].twitterGrid.sequence, 0);
    assert.equal(output[1].twitterGrid.embedEnd, 1);
    assert.equal(input[0].embeds[0].description, 'text');
});

test('unrelated or unconfirmed continuation contents cannot be moved into a different post', () => {
    const parts = makeParts();
    assert.equal(planLastDetails(parts.slice(0, 1), groupId), null);
    assert.equal(planLastDetails(parts, 'bad-id'), null);
    parts[1].content = 'another post';
    assert.equal(planLastDetails(parts, groupId), null);
    delete parts[1].content;
    parts[1].twitterGrid.sequence = 9;
    assert.equal(planLastDetails(parts, groupId), null);
});
