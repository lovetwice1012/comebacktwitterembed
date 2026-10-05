'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoveryKey, encodeRecovery, decodeRecovery, MAX_AGE_MS } = require('../../src/automation/draft-recovery');
const { newWorkflow } = require('../../src/automation/schema');
const ownerId = '222222222222222222', guildId = '111111111111111111';
const record = () => ({ ownerId, guildId, scope: 'private', workflowId: null, baseRevision: null, definition: newWorkflow('編集中'), bindings: { dictionaries: {}, destinations: {} }, textDraft: { format: 'yaml', text: 'nodes: [unfinished' } });
test('session recovery preserves incomplete text and rejects other accounts, guilds and expired drafts', () => {
    const data = encodeRecovery(record(), 1000);
    assert.equal(decodeRecovery(data, ownerId, guildId, 2000).textDraft.text, 'nodes: [unfinished');
    assert.throws(() => decodeRecovery(data, '333333333333333333', guildId, 2000), /OWNER_MISMATCH/);
    assert.throws(() => decodeRecovery(data, ownerId, null, 2000), /OWNER_MISMATCH/);
    assert.throws(() => decodeRecovery(data, ownerId, guildId, MAX_AGE_MS + 1001), /EXPIRED/);
    assert.notEqual(recoveryKey(ownerId, guildId), recoveryKey(ownerId, null));
});
test('recovery never stores signed webhook URLs or known credential fields, even inside raw YAML', () => {
    for (const text of ['https://discord.com/api/v10/webhooks/123456789012345678/fixture-only-token', 'client_secret: fake-audit-value', '"access_token": "fixture-only"']) {
        const next = record(); next.textDraft.text = text;
        assert.throws(() => encodeRecovery(next), /CREDENTIALS/);
    }
    const next = record(); next.bindings.webhook_url = 'fixture-only';
    assert.throws(() => encodeRecovery(next), /CREDENTIALS/);
});
