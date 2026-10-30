'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');
const React = require('../../dashboard/node_modules/react');
const { renderToStaticMarkup } = require('../../dashboard/node_modules/react-dom/server');
const { InvestigationList, investigationSummary } = load('components/admin/investigation-view.tsx');

test('recovered non-X history displays source, reason and preserved result', () => {
    const row = { id: 'fixture-run', firstAt: '2026-10-12T12:00:00.000Z', outcome: 'E',
        input: { provider: 'niconico', url: 'https://www.nicovideo.jp/watch/sm9', guildId: '123',
            details: { recovery: { source: 'mysql_expansion_trace', detailCompleteness: 'partial' } } },
        completion: { outcome: 'E', details: { reason: 'Botの保存記録から復元（詳細の一部は未記録）' } } };
    const summary = investigationSummary(row, 'runs');
    assert.equal(summary.provider, 'niconico');
    assert.equal(summary.url, 'https://www.nicovideo.jp/watch/sm9');
    assert.match(summary.reason, /復元/);
    const html = renderToStaticMarkup(React.createElement(InvestigationList, { items: [row], source: 'runs', onOpen() {} }));
    assert.match(html, /niconico/);
    assert.match(html, /復元/);
    assert.match(html, /nicovideo\.jp\/watch\/sm9/);
});
