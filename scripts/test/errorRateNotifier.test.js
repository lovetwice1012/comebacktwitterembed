'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const notifier = require('../../src/lifecycle/errorRateNotifier');

function fieldValue(embed, name) {
    return embed.fields.find(field => field.name === name)?.value;
}

function loadNotifierWithQuery(queryDatabase) {
    const notifierPath = require.resolve('../../src/lifecycle/errorRateNotifier');
    const dbPath = require.resolve('../../src/db');
    const originalNotifierModule = require.cache[notifierPath];
    const originalDbModule = require.cache[dbPath];

    delete require.cache[notifierPath];
    require.cache[dbPath] = {
        id: dbPath,
        filename: dbPath,
        loaded: true,
        exports: { queryDatabase },
    };

    const loadedNotifier = require(notifierPath);
    return {
        notifier: loadedNotifier,
        restore() {
            delete require.cache[notifierPath];
            if (originalNotifierModule) require.cache[notifierPath] = originalNotifierModule;
            if (originalDbModule) require.cache[dbPath] = originalDbModule;
            else delete require.cache[dbPath];
        },
    };
}

test('error rate notifier triggers only on meaningful spikes', () => {
    const { shouldAlert } = notifier._internal;

    assert.equal(shouldAlert(2, 100, 10, 1000), false);
    assert.equal(shouldAlert(30, 200, 20, 2000), true);
    assert.equal(shouldAlert(12, 19, 20, 2000), false);
    assert.equal(shouldAlert(4, 200, 20, 2000), false);
    assert.equal(shouldAlert(12, 200, 0, 50), false);
});

test('error rate notification embed is an anomaly detection report', () => {
    const embed = notifier._internal.buildNotificationEmbed({
        title: '異常検知: リンク展開失敗率上昇',
        kind: 'provider_extract',
        providerId: 'twitter',
        dominantErrorType: 'provider_api_json_decode_error',
        dominantErrorShare: 0.8,
        currentRate: 0.32,
        baselineRate: 0.04,
        detectedAtMs: Date.UTC(2026, 5, 30, 0, 0, 0),
    });
    const message = JSON.stringify(embed);

    assert.equal(embed.title, '異常検知: リンク展開失敗率上昇');
    assert.equal(embed.description, '通常範囲超過 / 直近1時間');
    assert.equal(fieldValue(embed, 'プロバイダ'), 'Twitter / X');
    assert.equal(fieldValue(embed, '検知対象'), 'リンク展開');
    assert.match(fieldValue(embed, '検知内容'), /32\.0%/);
    assert.match(fieldValue(embed, '検知内容'), /通常 4\.0%/);
    assert.equal(fieldValue(embed, '問題箇所'), '外部API側');
    assert.equal(fieldValue(embed, '推定原因'), '外部API応答異常');
    assert.equal(fieldValue(embed, '推定影響'), '展開結果の非表示');
    assert.equal(fieldValue(embed, '開発者連携'), '共有済み');
    assert.equal(embed.footer.text, 'ComebackTwitterEmbed 異常検知システム');
    assert.doesNotMatch(message, /お知らせ|ご案内|対応のお願い|お試しください|ご確認ください|現在、|です。|ます。|可能性|場合/);
    assert.doesNotMatch(message, /<@|@everyone|@here/);
    assert.doesNotMatch(message, /JSON|provider_api|stack|HTTP|500|discord_missing_permissions/i);
    assert.doesNotMatch(message, /NSFW|ログイン必須|年齢制限|センシティブ|非公開/);
});

test('error rate notification embed includes incident id when assigned', () => {
    const embed = notifier._internal.buildNotificationEmbed({
        title: '逡ｰ蟶ｸ讀懃衍: 繝ｪ繝ｳ繧ｯ螻暮幕螟ｱ謨礼紫荳頑・',
        kind: 'provider_extract',
        providerId: 'twitter',
        dominantErrorType: 'provider_api_http_error',
        dominantErrorShare: 0.9,
        currentRate: 0.25,
        baselineRate: 0.02,
        incidentId: 'CBTE-TEST-001',
    });

    assert.equal(fieldValue(embed, '障害ID'), 'CBTE-TEST-001');
});

test('error rate resolution embed identifies the resolved incident', () => {
    const embed = notifier._internal.buildResolutionEmbed({
        key: 'provider_extract:twitter',
        kind: 'provider_extract',
        providerId: 'twitter',
        incidentId: 'CBTE-TEST-002',
        detectedAtMs: Date.UTC(2026, 6, 5, 0, 0, 0),
        resolvedAtMs: Date.UTC(2026, 6, 5, 1, 5, 0),
    });

    assert.equal(embed.color, 0x16A34A);
    assert.equal(fieldValue(embed, '障害ID'), 'CBTE-TEST-002');
    assert.equal(fieldValue(embed, 'プロバイダ'), 'Twitter / X');
    assert.equal(fieldValue(embed, '継続時間'), '1h 5m');
});

test('error rate notification labels CBTE-side send failures clearly', () => {
    const embed = notifier._internal.buildNotificationEmbed({
        title: '異常検知: 展開結果送信失敗率上昇',
        kind: 'discord_send',
        providerId: 'youtube',
        dominantErrorType: 'discord_unknown_message',
        dominantErrorShare: 0.9,
        currentRate: 0.18,
        baselineRate: 0.02,
    });

    assert.equal(embed.title, '異常検知: 展開結果送信失敗率上昇');
    assert.equal(fieldValue(embed, 'プロバイダ'), 'YouTube');
    assert.equal(fieldValue(embed, '検知対象'), '展開結果送信');
    assert.equal(fieldValue(embed, '問題箇所'), 'CBTEシステム側');
    assert.equal(fieldValue(embed, '推定原因'), 'Discord送信処理の失敗増加');
});

test('error rate notifier suppresses server-scoped permission spikes', () => {
    assert.equal(notifier._internal.shouldSuppressAlert({
        kind: 'discord_send',
        providerId: 'pixiv',
        dominantErrorType: 'discord_missing_permissions',
        dominantErrorShare: 0.9,
        currentRate: 0.2,
        baselineRate: 0.03,
    }), true);
    assert.equal(notifier._internal.shouldSuppressAlert({
        kind: 'discord_send',
        providerId: 'pixiv',
        dominantErrorType: 'discord_missing_permissions',
        dominantErrorShare: 0.3,
        currentRate: 0.2,
        baselineRate: 0.03,
    }), false);
    assert.equal(notifier._internal.shouldSuppressAlert({
        kind: 'provider_extract',
        providerId: 'twitter',
        dominantErrorType: 'provider_api_http_error',
        dominantErrorShare: 0.9,
        currentRate: 0.2,
        baselineRate: 0.03,
    }), false);
});

test('error rate notifier creates a new incident for a new outage', async () => {
    const nowMs = Date.UTC(2026, 6, 5, 0, 0, 0);
    const { notifier: loadedNotifier, restore } = loadNotifierWithQuery(async (sql, params = []) => {
        if (sql.includes('FROM bot_metric_buckets')) {
            const [metricName,, endMs] = params;
            const current = endMs === nowMs;
            if (current && metricName === 'provider_extract_attempt') return [{ provider_id: 'twitter', count: 100 }];
            if (current && metricName === 'provider_extract_error') return [{ provider_id: 'twitter', count: 30 }];
            if (!current && metricName === 'provider_extract_attempt') return [{ provider_id: 'twitter', count: 1000 }];
            if (!current && metricName === 'provider_extract_error') return [{ provider_id: 'twitter', count: 20 }];
            return [];
        }
        if (sql.includes('FROM bot_error_buckets')) {
            return [{ error_type: 'provider_api_http_error', count: 30 }];
        }
        if (sql.includes('FROM bot_error_alerts') && sql.includes('WHERE active = 1')) {
            return [];
        }
        throw new Error(`Unexpected query: ${sql}`);
    });

    try {
        const notifications = await loadedNotifier._internal.collectIncidentNotifications(nowMs);

        assert.equal(notifications.detections.length, 1);
        assert.equal(notifications.ongoing.length, 0);
        assert.equal(notifications.resolutions.length, 0);
        assert.equal(notifications.detections[0].key, 'provider_extract:twitter');
        assert.match(notifications.detections[0].incidentId, /^CBTE-[0-9A-Z]+-[0-9A-F]{6}$/);
    } finally {
        restore();
    }
});

test('error rate notifier resolves active incident when alert condition clears', async () => {
    const nowMs = Date.UTC(2026, 6, 5, 2, 0, 0);
    const detectedAtMs = Date.UTC(2026, 6, 5, 0, 0, 0);
    const { notifier: loadedNotifier, restore } = loadNotifierWithQuery(async (sql) => {
        if (sql.includes('FROM bot_metric_buckets')) return [];
        if (sql.includes('FROM bot_error_alerts') && sql.includes('WHERE active = 1')) {
            return [{
                alert_key: 'provider_extract:twitter',
                provider_id: 'twitter',
                alert_kind: 'provider_extract',
                dominant_error_type: 'provider_api_http_error',
                incident_id: 'CBTE-ACTIVE-1',
                active: 1,
                detected_at_ms: detectedAtMs,
                last_seen_at_ms: detectedAtMs + 15 * 60 * 1000,
                resolved_at_ms: null,
                last_sent_at_ms: detectedAtMs,
                last_current_rate: 0.3,
                last_baseline_rate: 0.02,
                last_current_errors: 30,
                last_current_attempts: 100,
            }];
        }
        throw new Error(`Unexpected query: ${sql}`);
    });

    try {
        const notifications = await loadedNotifier._internal.collectIncidentNotifications(nowMs);

        assert.equal(notifications.detections.length, 0);
        assert.equal(notifications.ongoing.length, 0);
        assert.equal(notifications.resolutions.length, 1);
        assert.equal(notifications.resolutions[0].incidentId, 'CBTE-ACTIVE-1');
        assert.equal(notifications.resolutions[0].resolvedAtMs, nowMs);
    } finally {
        restore();
    }
});

test('error rate notification avoids over-specific causes when errors are mixed', () => {
    const embed = notifier._internal.buildNotificationEmbed({
        title: '異常検知: リンク展開失敗率上昇',
        kind: 'provider_extract',
        providerId: 'youtube',
        dominantErrorType: 'provider_api_http_error',
        dominantErrorShare: 0.3,
        currentRate: 0.12,
        baselineRate: 0.02,
    });

    assert.equal(fieldValue(embed, '推定原因'), '取得失敗の複合増加');
    assert.doesNotMatch(fieldValue(embed, '推定原因'), /応答形式/);
});
