'use strict';
(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.CBTEView = model;
})(globalThis, function () {
  const outcomes = { F:'完全成功', D:'代替成功', P:'部分成功', E:'処理失敗', U:'取得対象の制約', S:'設定による見送り', C:'明示的取消', I:'実行中', X:'結果不明' };
  function measurement(metrics) {
    const coverage = metrics?.coverage || {};
    const unavailable = coverage.measurementState === 'not_measured' || (!coverage.measurementState && coverage.state === 'no_root_request_records');
    const collection = { unobserved:'Botの進捗記録は未観測です。', heartbeat_stale:'Botの進捗記録が古く、現在の収集継続を確認できません。', clock_skew:'Botの記録時刻にずれがあり、情報の新しさを確認できません。', recent_heartbeat:'最近のBot進捗記録を受信しています。' }[coverage.collectionState] || '収集状態の情報はありません。';
    const reason = { no_production_request_records:'本番の展開要求がまだ記録されていません。検証用の実行履歴だけでは本番の利用件数や成功率を判断できません。', requested_period_predates_first_record:'指定期間は最初の本番要求記録より前です。未計測の期間を0件として表示しません。', no_matching_requests_and_collection_unverified:'指定期間の本番要求記録がなく、収集の継続も確認できません。処理が0件だったとは判断できません。' }[coverage.measurementReason];
    return { unavailable, countLabel: unavailable ? '未計測' : '保存記録', message: reason || '表示件数は保存できた本番要求の範囲です。未記録分を含む実際の総利用数を保証するものではありません。', collection };
  }
  function http(attempt = {}) {
    const hasStatus = Number.isInteger(attempt.status) && attempt.status >= 100 && attempt.status <= 599;
    const hasBody = Object.prototype.hasOwnProperty.call(attempt, 'body');
    return { statusLabel: hasStatus ? `HTTP ${attempt.status}${attempt.statusText ? ' '+attempt.statusText : ''}` : attempt.error ? '接続・応答前の失敗' : '応答未確認', bodyState: attempt.truncated ? 'truncated' : hasBody ? (attempt.body === '' ? 'saved_empty' : 'saved') : 'not_saved', durationMs: typeof attempt.durationMs === 'number' ? attempt.durationMs : null, truncated: attempt.truncated === true, credentialsRedacted: attempt.credentialsRedacted === true };
  }
  function event(item = {}) {
    const payload = item.payload || item;
    const details = payload.details || {};
    const kind = payload.kind || payload.type || '種別未記録';
    const stage = payload.stage || '';
    const error = details.error || payload.error;
    return { payload, details, kind: stage && !kind.includes('.') ? `${stage}.${kind}` : kind, occurredAt: payload.occurredAt || payload.occurred_at || item.occurredAt, timestampInferred:payload.timestampInferred===true, url: details.url || payload.url || details.input || '', outcome: outcomes[payload.outcome || details.outcome] || payload.outcome || details.outcome || '', errorMessage: typeof error === 'string' ? error : error?.message || '', isHTTP: stage === 'http' || kind.startsWith('http.'), id: payload.eventId || payload.event_id || payload.id || item.id || '', search: [stage,kind,details.url,payload.url,details.input,error?.message,payload.outcome,details.outcome].filter(Boolean).join(' ') };
  }
  return { measurement, http, event, outcomes };
});
