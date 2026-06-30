'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const notifier = require('../../src/lifecycle/errorRateNotifier');

function fieldValue(embed, name) {
    return embed.fields.find(field => field.name === name)?.value;
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
