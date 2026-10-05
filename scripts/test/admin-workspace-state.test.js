'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
const { readAdminLocation, adminLocationUrl, buildInvestigationQuery, parseMessageLink, verifyInvestigationFilters } = load('lib/admin-workspace.ts');
const { investigationSummary } = load('components/admin/investigation-view.tsx');

test('all investigation filters survive a bookmark and only supported filters reach each endpoint', () => {
  const url = adminLocationUrl('/admin?unrelated=keep', { section: 'investigation', tab: 'search', guildId: '111', channelId: '222', userId: '333', messageId: '444', from: '2026-09-22T10:00', to: '2026-09-22T11:00', outcome: 'E', source: 'runs', selected: 'run:123', selectedSource: 'runs' });
  assert.match(url, /unrelated=keep/);
  const state = readAdminLocation(url), query = buildInvestigationQuery(state);
  assert.equal(state.selected, 'run:123');
  assert.deepEqual(Object.fromEntries(query), { limit: '100', guildId: '111', channelId: '222', userId: '333', messageId: '444', from: '2026-09-22T01:00:00.000Z', to: '2026-09-22T02:00:00.000Z', outcome: 'E' });
  assert.equal(buildInvestigationQuery(state, 'actions').has('outcome'), false);
  assert.deepEqual(Object.fromEntries(buildInvestigationQuery(state, 'incidents')), { limit: '100' });
  assert.deepEqual(Object.fromEntries(buildInvestigationQuery(state, 'notifications')), { limit: '100' });
  assert.throws(() => buildInvestigationQuery({ ...state, to: state.from }), /終了日時/);
});

test('old routes open their intended tools and malformed navigation falls back safely', () => {
  assert.equal(readAdminLocation('/admin/url-inspector').tab, 'inspect');
  assert.equal(readAdminLocation('/admin/send-message').tab, 'send');
  assert.equal(readAdminLocation('/admin/support-console').tab, 'search');
  assert.equal(readAdminLocation('/admin?section=servers&tab=recovery').tab, 'settings');
  assert.equal(readAdminLocation('/admin?section=invalid&tab=invalid').tab, 'home');
});

test('older agents cannot silently discard narrowed investigation filters', () => {
  const query = new URLSearchParams({ guildId: '111', channelId: '222' });
  assert.throws(() => verifyInvestigationFilters('runs', query, { items: [] }), /検索条件に対応していません/);
  assert.doesNotThrow(() => verifyInvestigationFilters('runs', query, { items: [], appliedFilters: { channelId: '222' } }));
  assert.throws(() => verifyInvestigationFilters('actions', query, { items: [], appliedFilters: { channelId: '222' } }), /検索条件/);
  assert.doesNotThrow(() => verifyInvestigationFilters('runs', new URLSearchParams({ guildId: '111' }), { items: [] }));
});

test('Discord links populate exact guild/channel/message identities, not lookalike domains', () => {
  assert.deepEqual(parseMessageLink('https://discord.com/channels/123/456/789'), { guildId: '123', channelId: '456', messageId: '789' });
  assert.equal(parseMessageLink('https://discord.com.evil.test/channels/123/456/789'), null);
  assert.equal(parseMessageLink('https://discord.com/channels/@me/456/789'), null);
});

test('root request completion supplies the result/reason/duration, without inferring missing evidence', () => {
  const summary = investigationSummary({ id: 'r1', firstAt: '2026-09-22T01:00:00Z', outcome: 'E', input: { url: 'https://example.test/post', guildId: '111', provider: 'twitter' }, completion: { durationMs: 1200, details: { reason: 'HTTP 429', failureStage: 'fetch' } } });
  assert.equal(summary.reason, 'HTTP 429'); assert.equal(summary.stage, 'fetch'); assert.equal(summary.duration, '1.20 秒');
  assert.equal(summary.url, 'https://example.test/post');
  assert.equal(investigationSummary({ id: 'old' }).reason, '未記録');
  const detail = investigationSummary({ id: 'r1', events: [{ payload: { kind: 'request.started', guildId: '111', url: 'https://example.test' } }, { payload: { kind: 'request.completed', outcome: 'P', durationMs: 100 } }] });
  assert.equal(detail.result, '部分成功'); assert.equal(detail.guildId, '111');
});
