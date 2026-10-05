'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const add = require('../../src/commands/handlers/autoextract/add');
const { autoextractAction } = require('../../src/adminSupport/operations');

test('autoextract add explains technical unavailability without attempting registration', async () => {
    const replies = [];
    await add({
        locale: 'ja',
        options: { getString: () => assert.fail('Paused registration must not consume registration input') },
        editReply: async payload => replies.push(payload),
    });

    assert.equal(replies.length, 1);
    assert.match(replies[0].embeds[0].description, /現在対応できない/);
    assert.match(replies[0].embeds[0].description, /登録を停止/);
});

test('admin autoextract add is paused before it can write a Twitter registration', async () => {
    await assert.rejects(
        autoextractAction('autoextract.add', {}),
        error => error?.code === 'TWITTER_AUTOEXTRACT_REGISTRATION_PAUSED'
    );
});
