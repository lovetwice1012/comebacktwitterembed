'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../../dashboard/node_modules/react');
const { renderToStaticMarkup } = require('../../dashboard/node_modules/react-dom/server');
const load = require('./helpers/load-dashboard.cjs');
const { MetricsView, HttpAttemptCard, readableHttpBody } = load('components/admin/management-console.tsx');

test('unmeasured production telemetry displays unavailable values rather than false zero counts', () => {
  const data = { requestCount: 0, problemRequestCount: 0, skippedRequestCount: 0, affectedGuildCount: 0,
    outcomes: { F: 0, E: 0 }, fullSuccess: { numerator: 0, denominator: 0, ratio: null },
    coverage: { measurementState: 'not_measured', collectionState: 'unobserved' } };
  const html = renderToStaticMarkup(React.createElement(MetricsView, { data, onDrill: () => {} }));
  assert.ok((html.match(/未計測/g) || []).length >= 6);
  assert.doesNotMatch(html, /0\.00%/);
  assert.doesNotMatch(html, /<p[^>]*>0<\/p>/);
  assert.match(html, /disabled=""/);
  // Raw details are loaded only when expanded, so megabytes of evidence are not duplicated at first render.
  assert.doesNotMatch(html, /&quot;requestCount&quot;/);
});

test('a verified empty interval still displays observed zero requests', () => {
  const data = { requestCount: 0, problemRequestCount: 0, skippedRequestCount: 0, affectedGuildCount: 0,
    outcomes: { F: 0 }, fullSuccess: { numerator: 0, denominator: 0, ratio: null },
    coverage: { measurementState: 'no_matching_requests', collectionState: 'recent_heartbeat' } };
  const html = renderToStaticMarkup(React.createElement(MetricsView, { data, onDrill: () => {} }));
  assert.match(html, /<p[^>]*>0<\/p>/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('HTTP attempts expose readable JSON body and metadata without escaping it inside a second JSON string', () => {
  const attempt = { method: 'GET', url: 'https://example.test/api', status: 200, durationMs: 12, bytes: 42,
    bodyEncoding: 'utf8', bodyState: 'complete', headers: { 'content-type': 'application/json' }, body: '{"answer":{"value":42}}' };
  assert.equal(readableHttpBody(attempt).text, '{\n  "answer": {\n    "value": 42\n  }\n}');
  const html = renderToStaticMarkup(React.createElement(HttpAttemptCard, { value: attempt, index: 0 }));
  assert.match(html, /HTTP 200/);
  assert.match(html, /応答本文/);
  assert.match(html, /&quot;answer&quot;: \{/);
  assert.doesNotMatch(html, /\\&quot;answer/);
  assert.match(html, /本文保存済み/);
});

test('HTML remains inert text and truncated or binary evidence is explicitly marked', () => {
  const html = renderToStaticMarkup(React.createElement(HttpAttemptCard, { value: { url: 'https://example.test', status: 502,
    body: '<script>danger()</script>', bodyEncoding: 'utf8', truncated: true, bodyState: 'truncated' }, index: 0 }));
  assert.match(html, /本文は一部のみ保存/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(readableHttpBody({ body: 'AAE=', bodyEncoding: 'base64' }).format, 'バイナリ（Base64）');
  assert.equal(readableHttpBody({ bodyState: 'not_consumed' }).available, false);
});
