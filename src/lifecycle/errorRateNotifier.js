'use strict';

const crypto = require('crypto');
const { TABLES } = require('../db_schema');
const { queryDatabase } = require('../db');

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const CURRENT_WINDOW_MS = 60 * 60 * 1000;
const BASELINE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
const BASELINE_GAP_MS = 2 * 60 * 60 * 1000;
const MIN_CURRENT_ATTEMPTS = 20;
const MIN_CURRENT_ERRORS = 5;
const MIN_BASELINE_ATTEMPTS = 100;
const MIN_ABSOLUTE_RATE = 0.10;
const MIN_RATE_INCREASE = 0.05;
const RATE_MULTIPLIER = 3;
const DOMINANT_ERROR_SHARE_THRESHOLD = 0.5;
const ALERT_COLOR = 0xD97706;
const RESOLUTION_COLOR = 0x16A34A;
const UNKNOWN_INCIDENT_ID = 'unknown';

const PROVIDER_LABELS = {
    twitter: 'Twitter / X',
    pixiv: 'pixiv',
    booth: 'booth.pm',
    spotify: 'Spotify',
    youtube: 'YouTube',
    twitch: 'Twitch',
    instagram: 'Instagram',
    tiktok: 'TikTok',
    niconico: 'Niconico',
    steam: 'Steam',
};

const ALERT_KINDS = [
    {
        key: 'provider_extract',
        attemptMetric: 'provider_extract_attempt',
        errorMetric: 'provider_extract_error',
        title: '異常検知: リンク展開失敗率上昇',
    },
    {
        key: 'discord_send',
        attemptMetric: 'discord_send_attempt',
        errorMetric: 'discord_send_error',
        title: '異常検知: 展開結果送信失敗率上昇',
    },
];

let timer = null;
let running = false;

function providerLabel(providerId) {
    return PROVIDER_LABELS[providerId] || providerId || '一部のリンク';
}

function rate(errors, attempts) {
    return attempts > 0 ? errors / attempts : 0;
}

function shouldAlert(currentErrors, currentAttempts, baselineErrors, baselineAttempts) {
    if (currentAttempts < MIN_CURRENT_ATTEMPTS) return false;
    if (currentErrors < MIN_CURRENT_ERRORS) return false;
    if (baselineAttempts < MIN_BASELINE_ATTEMPTS) return false;

    const currentRate = rate(currentErrors, currentAttempts);
    const baselineRate = rate(baselineErrors, baselineAttempts);
    const threshold = Math.max(
        MIN_ABSOLUTE_RATE,
        baselineRate * RATE_MULTIPLIER,
        baselineRate + MIN_RATE_INCREASE,
    );
    return currentRate >= threshold;
}

function dominantErrorType(alert) {
    const dominantErrorShare = Number.isFinite(alert.dominantErrorShare)
        ? alert.dominantErrorShare
        : (alert.dominantErrorType ? 1 : 0);
    return dominantErrorShare >= DOMINANT_ERROR_SHARE_THRESHOLD
        ? alert.dominantErrorType
        : 'mixed';
}

function shouldSuppressAlert(alert) {
    return alert.kind === 'discord_send'
        && dominantErrorType(alert) === 'discord_missing_permissions';
}

function classifyCause(alert) {
    const errorType = dominantErrorType(alert);
    const kind = alert.kind;

    if (errorType === 'provider_api_json_decode_error') {
        return {
            title: '異常検知: リンク展開失敗率上昇',
            problemArea: '外部API側',
            cause: '外部API応答異常',
            impact: '展開結果の非表示',
        };
    }
    if (errorType === 'provider_api_http_error') {
        return {
            title: '異常検知: リンク展開失敗率上昇',
            problemArea: '外部API側',
            cause: '応答失敗の増加',
            impact: '展開遅延・非表示',
        };
    }
    if (kind === 'discord_send') {
        return {
            title: '異常検知: 展開結果送信失敗率上昇',
            problemArea: 'CBTEシステム側',
            cause: 'Discord送信処理の失敗増加',
            impact: '展開結果メッセージの非表示',
        };
    }
    return {
        title: '異常検知: リンク展開失敗率上昇',
        problemArea: '外部API側',
        cause: '取得失敗の複合増加',
        impact: '展開遅延・非表示',
    };
}

function formatPercent(value) {
    if (!Number.isFinite(value)) return null;
    return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const totalMinutes = Math.max(1, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
}

function createIncidentId(nowMs = Date.now()) {
    const timestamp = Math.max(0, Math.floor(nowMs)).toString(36).toUpperCase().padStart(8, '0');
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `CBTE-${timestamp}-${random}`;
}

function targetLabel(alert) {
    return alert.kind === 'discord_send'
        ? '展開結果送信'
        : 'リンク展開';
}

function buildDetectionSummary(alert) {
    const currentRate = formatPercent(alert.currentRate);
    const baselineRate = formatPercent(alert.baselineRate);
    if (currentRate && baselineRate) {
        return `失敗率 ${currentRate} / 通常 ${baselineRate}`;
    }
    return '失敗率 通常範囲超過';
}

function buildNotificationEmbed(alert) {
    const cause = classifyCause(alert);
    const incidentId = alert.incidentId || alert.incident_id || null;
    return {
        title: cause.title || alert.title,
        description: '通常範囲超過 / 直近1時間',
        color: ALERT_COLOR,
        fields: [
            ...(incidentId ? [{
                name: '障害ID',
                value: incidentId,
            }] : []),
            {
                name: 'プロバイダ',
                value: providerLabel(alert.providerId),
            },
            {
                name: '検知対象',
                value: targetLabel(alert),
            },
            {
                name: '検知内容',
                value: buildDetectionSummary(alert),
            },
            {
                name: '問題箇所',
                value: cause.problemArea,
            },
            {
                name: '推定原因',
                value: cause.cause,
            },
            {
                name: '推定影響',
                value: cause.impact,
            },
            {
                name: '開発者連携',
                value: '共有済み',
            },
        ],
        timestamp: new Date(alert.detectedAtMs || Date.now()).toISOString(),
        footer: { text: 'ComebackTwitterEmbed 異常検知システム' },
    };
}

function buildResolutionEmbed(incident) {
    const resolvedAtMs = Number.isFinite(incident.resolvedAtMs) ? incident.resolvedAtMs : Date.now();
    const detectedAtMs = Number(incident.detectedAtMs);
    const duration = Number.isFinite(detectedAtMs)
        ? formatDuration(resolvedAtMs - detectedAtMs)
        : null;
    const fields = [
        {
            name: '障害ID',
            value: incident.incidentId || UNKNOWN_INCIDENT_ID,
        },
        {
            name: 'プロバイダ',
            value: providerLabel(incident.providerId),
        },
        {
            name: '監視対象',
            value: targetLabel(incident),
        },
    ];
    if (duration) {
        fields.push({
            name: '継続時間',
            value: duration,
        });
    }
    return {
        title: '障害解消',
        description: '異常条件を満たさなくなりました。',
        color: RESOLUTION_COLOR,
        fields,
        timestamp: new Date(resolvedAtMs).toISOString(),
        footer: { text: 'ComebackTwitterEmbed incident monitor' },
    };
}

function buildNotificationMessage(alert) {
    const embed = buildNotificationEmbed(alert);
    const lines = [
        `【${embed.title}】`,
        embed.description,
        ...embed.fields.map(field => `${field.name}: ${field.value}`),
    ];
    return lines.join('\n');
}

function alertKey(kind, providerId) {
    return `${kind}:${providerId || 'all'}`;
}

function mapRowsByProvider(rows) {
    const out = new Map();
    for (const row of rows) {
        out.set(row.provider_id || '', Number(row.count) || 0);
    }
    return out;
}

async function loadMetricCounts(metricName, startMs, endMs) {
    return await queryDatabase(
        `SELECT provider_id, SUM(count) AS count
        FROM ${TABLES.botMetricBuckets}
        WHERE metric_name = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?
        GROUP BY provider_id`,
        [metricName, startMs, endMs],
    );
}

async function loadDominantErrorSummary(providerId, startMs, endMs, totalErrors) {
    const rows = await queryDatabase(
        `SELECT error_type, SUM(count) AS count
        FROM ${TABLES.botErrorBuckets}
        WHERE provider_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?
        GROUP BY error_type
        ORDER BY count DESC
        LIMIT 1`,
        [providerId || '', startMs, endMs],
    );
    const count = Number(rows[0]?.count) || 0;
    return {
        errorType: rows[0]?.error_type || null,
        count,
        share: totalErrors > 0 ? count / totalErrors : 0,
    };
}

function alertStateFromRow(row) {
    if (!row) return null;
    return {
        key: row.alert_key,
        providerId: row.provider_id || '',
        kind: row.alert_kind,
        dominantErrorType: row.dominant_error_type || null,
        incidentId: row.incident_id || UNKNOWN_INCIDENT_ID,
        active: row.active === 1 || row.active === true,
        detectedAtMs: Number(row.detected_at_ms ?? row.last_sent_at_ms),
        lastSeenAtMs: Number(row.last_seen_at_ms ?? row.last_sent_at_ms),
        resolvedAtMs: Number(row.resolved_at_ms),
        currentRate: Number(row.last_current_rate) || 0,
        baselineRate: Number(row.last_baseline_rate) || 0,
        currentErrors: Number(row.last_current_errors) || 0,
        currentAttempts: Number(row.last_current_attempts) || 0,
    };
}

async function loadActiveIncidentStates() {
    const rows = await queryDatabase(
        `SELECT alert_key, provider_id, alert_kind, dominant_error_type, incident_id, active,
            detected_at_ms, last_seen_at_ms, resolved_at_ms, last_sent_at_ms,
            last_current_rate, last_baseline_rate, last_current_errors, last_current_attempts
        FROM ${TABLES.botErrorAlerts}
        WHERE active = 1`,
    );
    return rows.map(alertStateFromRow).filter(Boolean);
}

async function markIncidentDetected(alert, nowMs) {
    await queryDatabase(
        `INSERT INTO ${TABLES.botErrorAlerts} (
            alert_key, provider_id, alert_kind, incident_id, active, detected_at_ms,
            last_seen_at_ms, resolved_at_ms, dominant_error_type, last_sent_at_ms,
            last_current_rate, last_baseline_rate, last_current_errors, last_current_attempts
        ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            provider_id = VALUES(provider_id),
            alert_kind = VALUES(alert_kind),
            incident_id = VALUES(incident_id),
            active = 1,
            detected_at_ms = VALUES(detected_at_ms),
            last_seen_at_ms = VALUES(last_seen_at_ms),
            resolved_at_ms = NULL,
            dominant_error_type = VALUES(dominant_error_type),
            last_sent_at_ms = VALUES(last_sent_at_ms),
            last_current_rate = VALUES(last_current_rate),
            last_baseline_rate = VALUES(last_baseline_rate),
            last_current_errors = VALUES(last_current_errors),
            last_current_attempts = VALUES(last_current_attempts),
            updated_at = CURRENT_TIMESTAMP`,
        [
            alert.key,
            alert.providerId || '',
            alert.kind,
            alert.incidentId,
            nowMs,
            nowMs,
            alert.dominantErrorType,
            nowMs,
            alert.currentRate,
            alert.baselineRate,
            alert.currentErrors,
            alert.currentAttempts,
        ],
    );
}

async function markIncidentStillActive(alert, nowMs) {
    await queryDatabase(
        `UPDATE ${TABLES.botErrorAlerts}
        SET provider_id = ?,
            alert_kind = ?,
            dominant_error_type = ?,
            last_seen_at_ms = ?,
            last_current_rate = ?,
            last_baseline_rate = ?,
            last_current_errors = ?,
            last_current_attempts = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE alert_key = ? AND active = 1`,
        [
            alert.providerId || '',
            alert.kind,
            alert.dominantErrorType,
            nowMs,
            alert.currentRate,
            alert.baselineRate,
            alert.currentErrors,
            alert.currentAttempts,
            alert.key,
        ],
    );
}

async function markIncidentResolved(incident, nowMs) {
    await queryDatabase(
        `UPDATE ${TABLES.botErrorAlerts}
        SET active = 0,
            resolved_at_ms = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE alert_key = ? AND active = 1`,
        [nowMs, incident.key],
    );
}

async function collectCurrentAlerts(nowMs = Date.now()) {
    const currentStart = nowMs - CURRENT_WINDOW_MS;
    const baselineEnd = nowMs - BASELINE_GAP_MS;
    const baselineStart = baselineEnd - BASELINE_WINDOW_MS;
    const alerts = [];

    for (const kind of ALERT_KINDS) {
        const [
            currentAttemptRows,
            currentErrorRows,
            baselineAttemptRows,
            baselineErrorRows,
        ] = await Promise.all([
            loadMetricCounts(kind.attemptMetric, currentStart, nowMs),
            loadMetricCounts(kind.errorMetric, currentStart, nowMs),
            loadMetricCounts(kind.attemptMetric, baselineStart, baselineEnd),
            loadMetricCounts(kind.errorMetric, baselineStart, baselineEnd),
        ]);

        const currentAttempts = mapRowsByProvider(currentAttemptRows);
        const currentErrors = mapRowsByProvider(currentErrorRows);
        const baselineAttempts = mapRowsByProvider(baselineAttemptRows);
        const baselineErrors = mapRowsByProvider(baselineErrorRows);
        const providerIds = new Set([...currentAttempts.keys(), ...currentErrors.keys()]);

        for (const providerId of providerIds) {
            const cAttempts = currentAttempts.get(providerId) || 0;
            const cErrors = currentErrors.get(providerId) || 0;
            const bAttempts = baselineAttempts.get(providerId) || 0;
            const bErrors = baselineErrors.get(providerId) || 0;
            if (!shouldAlert(cErrors, cAttempts, bErrors, bAttempts)) continue;

            const key = alertKey(kind.key, providerId);
            const dominantError = await loadDominantErrorSummary(providerId, currentStart, nowMs, cErrors);
            const alert = {
                key,
                kind: kind.key,
                title: kind.title,
                providerId,
                dominantErrorType: dominantError.errorType,
                dominantErrorShare: dominantError.share,
                currentErrors: cErrors,
                currentAttempts: cAttempts,
                baselineErrors: bErrors,
                baselineAttempts: bAttempts,
                currentRate: rate(cErrors, cAttempts),
                baselineRate: rate(bErrors, bAttempts),
            };
            if (shouldSuppressAlert(alert)) continue;
            alerts.push(alert);
        }
    }

    return alerts;
}

async function collectIncidentNotifications(nowMs = Date.now()) {
    const [currentAlerts, activeIncidents] = await Promise.all([
        collectCurrentAlerts(nowMs),
        loadActiveIncidentStates(),
    ]);
    const activeIncidentByKey = new Map(activeIncidents.map(incident => [incident.key, incident]));
    const currentKeys = new Set(currentAlerts.map(alert => alert.key));
    const detections = [];
    const ongoing = [];
    const resolutions = activeIncidents
        .filter(incident => !currentKeys.has(incident.key))
        .map(incident => ({ ...incident, resolvedAtMs: nowMs }));

    for (const alert of currentAlerts) {
        const activeIncident = activeIncidentByKey.get(alert.key);
        if (activeIncident) {
            ongoing.push({
                ...alert,
                incidentId: activeIncident.incidentId,
                detectedAtMs: activeIncident.detectedAtMs,
            });
            continue;
        }
        detections.push({
            ...alert,
            incidentId: createIncidentId(nowMs),
            detectedAtMs: nowMs,
        });
    }

    return { detections, ongoing, resolutions };
}

async function sendDetectionAlert(webhookClient, alert, nowMs = Date.now()) {
    await webhookClient.send({
        embeds: [buildNotificationEmbed({ ...alert, detectedAtMs: nowMs })],
        username: 'ComebackTwitterEmbed 異常検知システム',
        allowedMentions: { parse: [] },
    });
    await markIncidentDetected(alert, nowMs);
}

async function sendResolutionAlert(webhookClient, incident, nowMs = Date.now()) {
    await webhookClient.send({
        embeds: [buildResolutionEmbed({ ...incident, resolvedAtMs: nowMs })],
        username: 'ComebackTwitterEmbed incident monitor',
        allowedMentions: { parse: [] },
    });
    await markIncidentResolved(incident, nowMs);
}

async function tick(webhookClient, nowMs = Date.now()) {
    if (!webhookClient || running) return;
    running = true;
    try {
        const { detections, ongoing, resolutions } = await collectIncidentNotifications(nowMs);
        for (const alert of ongoing) {
            await markIncidentStillActive(alert, nowMs);
        }
        for (const alert of detections) {
            await sendDetectionAlert(webhookClient, alert, nowMs);
        }
        for (const incident of resolutions) {
            await sendResolutionAlert(webhookClient, incident, nowMs);
        }
    } catch (err) {
        console.warn('[errorRateNotifier] check failed:', err?.message || err);
    } finally {
        running = false;
    }
}

function start(webhookClient) {
    if (!webhookClient) return;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
        tick(webhookClient).catch(err => console.warn('[errorRateNotifier] tick failed:', err?.message || err));
    }, CHECK_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
    start,
    tick,
    _internal: {
        BASELINE_GAP_MS,
        BASELINE_WINDOW_MS,
        CHECK_INTERVAL_MS,
        CURRENT_WINDOW_MS,
        buildNotificationEmbed,
        buildNotificationMessage,
        buildResolutionEmbed,
        classifyCause,
        collectCurrentAlerts,
        collectIncidentNotifications,
        createIncidentId,
        shouldSuppressAlert,
        shouldAlert,
    },
};
