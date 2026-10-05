'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const add = require('../../src/commands/handlers/autoextract/add');
const { autoextractAction } = require('../../src/adminSupport/operations');

test('autoextract add is paused and leaves existing Twitter registrations untouched', async () => {
    const replies = [];
    await add({
        locale: 'ja',
        editReply: async payload => replies.push(payload),
    });

    assert.equal(replies.length, 1);
    assert.match(replies[0].embeds[0].description, /停止中/);
    assert.match(replies[0].embeds[0].description, /既存の登録は変更されません/);
});

test('admin autoextract add is paused before it can write a Twitter registration', async () => {
    await assert.rejects(
        autoextractAction('autoextract.add', {}),
        error => error?.code === 'TWITTER_AUTOEXTRACT_REGISTRATION_PAUSED'
    );
});
