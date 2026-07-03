'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

test('admin analytics responses anonymize personal identifiers before display', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    assert.match(source, /createHash/);
    assert.match(source, /personalIdentifierColumn/);
    assert.match(source, /function anonymizeIdentifier/);
    assert.match(source, /personalIdentifierColumn\.test\(key\)/);
    assert.match(source, /PRIVACY_MIN_GROUP_SIZE = 5/);
    assert.match(source, /function protectSmallGroupRow/);
    assert.match(source, /const privacyCountColumns = new Set/);
    assert.match(source, /function hasSmallPrivacyGroup/);
    assert.match(source, /function getDetailedUserCohortBreakdown/);
    assert.match(source, /smallGroupsSuppressed: false/);
    assert.match(source, /smallGroupDetailColumns/);
    assert.match(source, /"author_user_id"/);
    assert.match(source, /"guild_id"/);
    assert.match(source, /"message_id"/);

    const privacyCountColumnsSource = source.match(/const privacyCountColumns = new Set\(([\s\S]*?)\);/)?.[1] || '';
    const hasSmallPrivacyGroupSource = source.match(/function hasSmallPrivacyGroup\(row: Row\) \{([\s\S]*?)\n\}/)?.[1] || '';
    const protectSmallGroupRowSource = source.match(/function protectSmallGroupRow\(row: Row, extraDetailColumns: string\[] = \[]\) \{([\s\S]*?)\n\}/)?.[1] || '';

    assert.match(privacyCountColumnsSource, /\.\.\.privacyUserCountColumns/);
    assert.doesNotMatch(privacyCountColumnsSource, /guilds/);
    assert.match(hasSmallPrivacyGroupSource, /for \(const key of privacyCountColumns\)/);
    assert.doesNotMatch(protectSmallGroupRowSource, /privacyCountColumns\.has\(key\)[\s\S]*return \[key, SMALL_GROUP_LABEL\]/);
    assert.match(protectSmallGroupRowSource, /protectedColumns\.has\(key\)[\s\S]*SMALL_GROUP_LABEL/);
});

test('admin analytics UI does not expose raw author user id filters', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    assert.doesNotMatch(source, /\["author_user_id",\s*filters\.authorUserId\]/);
    assert.doesNotMatch(source, /placeholder="author_user_id"/);
    assert.match(source, /匿名ユーザー/);
    assert.doesNotMatch(source, /previewSectionRows\(preview, "activeUsers"\)[\s\S]{0,500}author_user_id/);
    assert.doesNotMatch(source, /previewSectionRows\(preview, "audienceUsers"\)[\s\S]{0,500}author_user_id/);
    assert.match(source, /usage_bucket/);
    assert.match(source, /反応を伸ばしている要因/);
    assert.match(source, /流入パラメータ/);
    assert.match(source, /previewSectionRows\(preview, "valueDrivers"\)/);
    assert.match(source, /previewSectionRows\(preview, "urlParameters"\)/);
    assert.doesNotMatch(source, /failureRows[\s\S]{0,500}message_id/);
    assert.doesNotMatch(source, /failureRows[\s\S]{0,500}channel_id/);
    assert.doesNotMatch(source, /valueRows[\s\S]{0,500}message_id/);
    assert.doesNotMatch(source, /valueRows[\s\S]{0,500}channel_id/);
    assert.doesNotMatch(source, /urlParameterRows[\s\S]{0,500}message_id/);
    assert.doesNotMatch(source, /urlParameterRows[\s\S]{0,500}channel_id/);
});

test('admin analytics URL tables can display full provider URLs with parameters', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const smallGroupColumns = dataSource.match(/const smallGroupDetailColumns = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
    assert.match(dataSource, /content_url/);
    assert.match(dataSource, /raw_url/);
    assert.match(dataSource, /delete visibleRow\.url_hash/);
    assert.doesNotMatch(dataSource, /\[restricted-url\]/);
    assert.doesNotMatch(smallGroupColumns, /"content_url"/);
    assert.doesNotMatch(smallGroupColumns, /"raw_url"/);
    assert.doesNotMatch(smallGroupColumns, /"normalized_url"/);
    assert.match(uiSource, /function displayUrl/);
    assert.match(uiSource, /row\.url_display \|\| row\.content_url \|\| row\.raw_url \|\| row\.normalized_url/);
    assert.match(uiSource, /key: "content_url", format: displayUrl/);
});

test('user-facing analytics previews separate raw and normalized URL visibility', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const guildRoute = fs.readFileSync(path.join(repoRoot, 'dashboard', 'app', 'api', 'admin', 'guild-analytics-preview', 'route.ts'), 'utf8');
    const providerRoute = fs.readFileSync(path.join(repoRoot, 'dashboard', 'app', 'api', 'admin', 'provider-marketing-preview', 'route.ts'), 'utf8');

    assert.match(dataSource, /type PreviewUrlVisibility = "normalized" \| "raw"/);
    assert.match(dataSource, /function previewUrlVisibility/);
    assert.match(dataSource, /function normalizedUrlForDisplay/);
    assert.match(dataSource, /function applyPreviewUrlPolicyRow/);
    assert.match(dataSource, /rawUrlVisible: urlVisibility === "raw"/);
    assert.match(dataSource, /normalizedUrlVisible: true/);
    assert.match(dataSource, /topContent: applyPreviewUrlPolicyRows\(protectUserFacingPreviewRows\(urlBreakdown\), urlVisibility\)/);
    assert.match(dataSource, /const protectedValueDrivers = applyPreviewUrlPolicyRows\(protectUserFacingPreviewRows\(valueDrivers\), urlVisibility\)/);
    assert.match(dataSource, /valueDrivers: protectedValueDrivers/);
    assert.match(dataSource, /const protectedUrlParameters = protectUserFacingPreviewRows\(urlParameterBreakdown\)/);
    assert.match(dataSource, /urlParameters: protectedUrlParameters/);
    assert.match(dataSource, /recentSamples: \[\]/);
    assert.match(guildRoute, /urlVisibility: search\.get\("url_visibility"\)/);
    assert.match(providerRoute, /urlVisibility: search\.get\("url_visibility"\)/);
    assert.match(uiSource, /urlVisibility: "raw"/);
    assert.match(uiSource, /\["url_visibility", filters\.urlVisibility\]/);
    assert.match(uiSource, /<option value="raw">Raw URL<\/option>/);
    assert.match(uiSource, /<option value="normalized">Normalized URL<\/option>/);
});

test('user-facing analytics previews strip row-level identifiers and samples', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    assert.match(dataSource, /const previewHiddenDetailColumns = new Set/);
    for (const token of ['"author_user_id"', '"channel_id"', '"content_event_id"', '"content_id"', '"message_id"', '"source"']) {
        assert.match(dataSource, new RegExp(token));
    }
    assert.match(dataSource, /const previewAnonymizedDetailColumns = new Set\(\["guild_id"\]\)/);
    assert.match(dataSource, /function protectUserFacingPreviewRow/);
    assert.match(dataSource, /channelIdentifiers: "not_exposed"/);
    assert.match(dataSource, /messageIdentifiers: "not_exposed"/);
    assert.match(dataSource, /rowLevelSamples: "disabled"/);
    assert.match(dataSource, /const content = protectUserFacingPreviewRow\(summary\.content \|\| \{\}\)/);
    assert.match(dataSource, /const protectedAudienceRetention = protectUserFacingPreviewRow\(audienceRetention\)/);
    assert.match(dataSource, /providerReliability: protectUserFacingPreviewRows\(providerReliability\)/);
    assert.match(dataSource, /function getDetailedFailureReasons/);
    assert.match(dataSource, /function getDetailedValueDrivers/);
    assert.match(dataSource, /function getDetailedUrlParameterBreakdown/);
    assert.match(dataSource, /f\.facet_key = 'url\.query_param'/);
    assert.match(dataSource, /failureReasons: protectUserFacingPreviewRows\(failureReasons\)/);
    assert.match(dataSource, /failureReasons: protectedFailureReasons/);
    assert.match(dataSource, /analysis_model: "failure_reason_summary"/);
    assert.match(dataSource, /analysis_model: "value_driver_summary"/);
    assert.match(dataSource, /analysis_model: "url_query_param_summary"/);
    assert.match(dataSource, /values_stored: false/);
    assert.match(dataSource, /value_signal/);
    assert.match(dataSource, /COUNT\(DISTINCT e\.author_user_id\) AS users/);
    assert.match(dataSource, /COUNT\(DISTINCT a\.author_user_id\) AS users/);
    assert.match(dataSource, /currentGuilds: protectUserFacingPreviewRows\(currentGuilds\)/);
    assert.match(dataSource, /peerGuilds: protectUserFacingPreviewRows\(peerGuilds\)/);
    assert.match(dataSource, /const protectedGuildBreakdown = protectUserFacingPreviewRows\(guildBreakdown\)/);
    assert.match(dataSource, /reachByGuild: protectedGuildBreakdown/);
    assert.doesNotMatch(dataSource, /recentSamples: applyPreviewUrlPolicyRows/);
});

test('provider marketing previews expose provider axis segments without row identifiers', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const previewStart = dataSource.indexOf('async function buildAdminProviderMarketingPreview');
    const previewEnd = dataSource.indexOf('\ntype AdminGuildAnalyticsPreviewSnapshot', previewStart);

    assert.match(dataSource, /const PROVIDER_MARKETING_AXIS_SEGMENTS/);
    assert.match(dataSource, /function getDetailedProviderMarketingSegments/);
    assert.match(dataSource, /analysis_model: "provider_specific_axis_segment"/);
    assert.notEqual(previewStart, -1, 'provider marketing preview function must exist');
    assert.notEqual(previewEnd, -1, 'provider marketing preview function contract must be isolated');

    const providerPreviewSource = dataSource.slice(previewStart, previewEnd);
    assert.match(providerPreviewSource, /optionalQuery\(\[\], \(\) => getDetailedProviderMarketingSegments\(filters, window, limit\)\)/);
    assert.match(providerPreviewSource, /const protectedProviderSegments = protectUserFacingPreviewRows\(providerSegments\)/);
    assert.match(providerPreviewSource, /sections: \{[\s\S]*providerSegments: protectedProviderSegments/);

    const providerSegmentsIndex = uiSource.indexOf('previewSectionRows(preview, "providerSegments")');
    const providerSegmentsEnd = uiSource.indexOf(']);', providerSegmentsIndex);
    assert.notEqual(providerSegmentsIndex, -1, 'provider marketing UI must read preview sections.providerSegments');
    assert.notEqual(providerSegmentsEnd, -1, 'providerSegments preview row mapping must be bounded');
    assert.match(uiSource, /マーケティング軸別の反応/);

    const providerSegmentsUi = uiSource.slice(providerSegmentsIndex, providerSegmentsEnd);
    for (const token of ['message_id', 'channel_id', 'author_user_id']) {
        assert.doesNotMatch(providerSegmentsUi, new RegExp(`\\b${token}\\b`));
    }
});

test('provider marketing analytics declare provider-specific metric schema coverage', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    assert.match(source, /PROVIDER_METRIC_SCHEMA_REGISTRY/);
    for (const provider of ['twitter', 'youtube', 'instagram', 'tiktok', 'github', 'twitch', 'pixiv', 'niconico', 'booth', 'amazon', 'spotify', 'steam']) {
        assert.match(source, new RegExp(`${provider}: \\{`));
    }
    for (const metric of [
        'twitter.has_quote',
        'twitter.has_article',
        'youtube.channel',
        'youtube.video_count',
        'instagram.location',
        'instagram.audio',
        'tiktok.type',
        'github.topics',
        'twitch.broadcaster',
        'pixiv.ugoira_media_count',
        'niconico.genre',
        'booth.sale_status',
        'amazon.genre',
        'spotify.preview_available',
        'steam.discount_percent',
    ]) {
        assert.match(source, new RegExp(metric.replace(/[.]/g, '\\.')));
    }
    assert.match(source, /providerMetricSchemaCoverage/);
    assert.match(source, /metricSchemaSummary/);
    assert.match(source, /metricSchemaCoverage/);
});

test('analytics quality dashboard exposes metric observation metadata quality', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const schemaSource = fs.readFileSync(path.join(repoRoot, 'src', 'db_schema.js'), 'utf8');

    for (const token of ['metric_stage', 'metric_source', 'collected_at_ms', 'schema_version', 'collection_success', 'collection_timeout_ms']) {
        assert.match(schemaSource, new RegExp(token));
        assert.match(dataSource, new RegExp(token));
    }
    assert.match(dataSource, /getProviderMetricObservationQuality/);
    assert.match(dataSource, /metricObservationQuality/);
    assert.match(uiSource, /Metric observation quality/);
    assert.match(uiSource, /analyticsQuality\.metricObservationQuality/);
});

test('analytics quality dashboard exposes provider metric readiness contracts', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const qualityStart = dataSource.indexOf('async function getAnalyticsQualityDashboard');
    const qualityEnd = dataSource.indexOf('\nasync function getDerivedAggregateStatus', qualityStart);

    assert.notEqual(qualityStart, -1, 'analytics quality dashboard helper must exist');
    assert.notEqual(qualityEnd, -1, 'analytics quality dashboard contract must be isolated');

    const qualitySource = dataSource.slice(qualityStart, qualityEnd);
    const qualityReturn = qualitySource.slice(qualitySource.lastIndexOf('return {'));

    for (const symbol of [
        'getProviderRequiredMetricCoverage',
        'getProviderMetricSchemaDrift',
        'getProviderEnrichmentSloDashboard',
    ]) {
        assert.match(dataSource, new RegExp(`function ${symbol}`));
    }

    assert.match(qualitySource, /optionalQuery\(\[\], \(\) => getProviderMetricSchemaDrift\(startMs\)\)/);
    assert.match(qualitySource, /optionalQuery\(\[\], \(\) => getProviderEnrichmentSloDashboard\(startMs\)\)/);
    assert.match(qualitySource, /const requiredMetricCoverage = getProviderRequiredMetricCoverage\(metricNullRates\)/);

    for (const key of ['requiredMetricCoverage', 'metricSchemaDrift', 'enrichmentSlo']) {
        assert.match(qualityReturn, new RegExp(`\\b${key},`));
        assert.match(dataSource, new RegExp(`${key}: \\[\\]`));
        assert.match(uiSource, new RegExp(`${key}: Row\\[\\];`));
        assert.match(uiSource, new RegExp(`analyticsQuality\\.${key}`));
    }

    const requiredMetricCard = uiSource.slice(
        uiSource.indexOf('<CardTitle>Required metric readiness</CardTitle>'),
        uiSource.indexOf('<CardTitle>Metric schema drift</CardTitle>'),
    );
    const metricSchemaDriftCard = uiSource.slice(
        uiSource.indexOf('<CardTitle>Metric schema drift</CardTitle>'),
        uiSource.indexOf('<CardTitle>Enrichment SLO monitor</CardTitle>'),
    );
    const enrichmentSloCard = uiSource.slice(
        uiSource.indexOf('<CardTitle>Enrichment SLO monitor</CardTitle>'),
        uiSource.indexOf('<CardTitle>Metric observation quality</CardTitle>'),
    );

    assert.match(uiSource, /Required metric readiness/);
    assert.match(uiSource, /Metric schema drift/);
    assert.match(uiSource, /Enrichment SLO monitor/);
    assert.match(requiredMetricCard, /withPercentRows\(analyticsQuality\.requiredMetricCoverage, \["required_coverage_rate", "observation_coverage_rate", "null_or_missing_rate"\]\)/);
    assert.match(metricSchemaDriftCard, /<DataTable rows=\{analyticsQuality\.metricSchemaDrift\} maxColumns=\{10\} \/>/);
    assert.match(enrichmentSloCard, /withPercentRows\(analyticsQuality\.enrichmentSlo, \["success_rate", "failure_rate", "slo_breach_rate"\]\)/);
});

test('stakeholder analytics previews keep internal readiness checks out of report panels', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const helperStart = dataSource.indexOf('function userFacingPreviewReadinessRows');
    const helperEnd = dataSource.indexOf('\nfunction normalizeGuildAnalyticsPreviewFilters', helperStart);
    const guildPreviewStart = dataSource.indexOf('async function buildAdminGuildAnalyticsPreview');
    const providerPreviewStart = dataSource.indexOf('async function buildAdminProviderMarketingPreview');
    const providerPreviewEnd = dataSource.indexOf('\ntype AdminGuildAnalyticsPreviewSnapshot', providerPreviewStart);
    const guildPanelStart = uiSource.indexOf('function GuildAdminPreviewPanel');
    const providerPanelStart = uiSource.indexOf('function ProviderMarketingPreviewPanel');
    const providerPanelEnd = uiSource.indexOf('\nfunction LogsPanel', providerPanelStart);

    assert.notEqual(helperStart, -1, 'report readiness helper must exist');
    assert.notEqual(helperEnd, -1, 'report readiness helper must be isolated before preview functions');
    assert.notEqual(guildPreviewStart, -1, 'guild preview must exist');
    assert.notEqual(providerPreviewStart, -1, 'provider preview must exist');
    assert.notEqual(providerPreviewEnd, -1, 'provider preview must be isolated');
    assert.notEqual(guildPanelStart, -1, 'guild preview panel must exist');
    assert.notEqual(providerPanelStart, -1, 'provider preview panel must exist');
    assert.notEqual(providerPanelEnd, -1, 'provider preview panel must be isolated');

    const helperSource = dataSource.slice(helperStart, helperEnd);
    const guildPreviewSource = dataSource.slice(guildPreviewStart, providerPreviewStart);
    const providerPreviewSource = dataSource.slice(providerPreviewStart, providerPreviewEnd);
    const guildPanelSource = uiSource.slice(guildPanelStart, providerPanelStart);
    const providerPanelSource = uiSource.slice(providerPanelStart, providerPanelEnd);

    assert.match(helperSource, /privacy_controls/);
    assert.match(helperSource, /small_group_privacy/);
    assert.match(helperSource, /url_visibility_policy/);
    assert.match(helperSource, /operational_success/);
    assert.match(helperSource, /provider_metric_schema/);
    assert.match(helperSource, /provider_quality_gates/);
    assert.match(helperSource, /provider_extract_quality/);
    assert.match(helperSource, /provider_enrichment_quality/);
    assert.match(helperSource, /provider_failure_pressure/);
    assert.match(helperSource, /protectUserFacingPreviewRows\(rows\)/);
    assert.match(helperSource, /PRIVACY_MIN_GROUP_SIZE/);

    assert.match(guildPreviewSource, /const reportReadiness = userFacingPreviewReadinessRows\("guild_admin", content, analytics, urlVisibility\)/);
    assert.match(providerPreviewSource, /const providerQualityGates = await optionalQuery\(\[\], \(\) => getProviderPreviewQualityGates\(filters, window, metricSchemaSummary, limit\)\)/);
    assert.match(providerPreviewSource, /const reportReadiness = userFacingPreviewReadinessRows\("provider_marketing", content, analytics, urlVisibility, metricSchemaSummary, providerQualityGates\)/);
    assert.match(guildPreviewSource, /sections: \{[\s\S]*reportReadiness,/);
    assert.match(providerPreviewSource, /sections: \{[\s\S]*reportReadiness,/);
    assert.match(providerPreviewSource, /sections: \{[\s\S]*providerQualityGates,/);
    assert.match(dataSource, /function providerMetricObservationRowKey/);
    assert.match(dataSource, /observed\.get\(providerMetricObservationRowKey\(providerId, metric\.key\)\)/);
    assert.doesNotMatch(dataSource, /observed\.get\(metric\.key\)/);

    for (const panelSource of [guildPanelSource, providerPanelSource]) {
        assert.doesNotMatch(panelSource, /previewSectionRows\(preview, "reportReadiness"\)/);
        assert.doesNotMatch(panelSource, /公開前チェック/);
        assert.doesNotMatch(panelSource, /レポート品質チェック/);
        assert.doesNotMatch(panelSource, /取得指標のそろい具合/);
        assert.doesNotMatch(panelSource, /指標ごとの取得状況/);
        assert.doesNotMatch(panelSource, /失敗理由/);
        assert.doesNotMatch(panelSource, /HTTP/);
        assert.doesNotMatch(panelSource, /Discord/);
    }

    assert.doesNotMatch(providerPanelSource, /previewSectionRows\(preview, "providerQualityGates"\)/);
    assert.doesNotMatch(providerPanelSource, /達成条件/);
    for (const serverOnlyForbidden of [
        /他サーバーとの比較/,
        /反応を伸ばしている要因/,
        /流入パラメータ/,
        /マーケティング軸別の反応/,
        /興味トピック/,
        /操作ランキング/,
        /設定変更の影響/,
        /あわせて反応される興味/,
    ]) {
        assert.doesNotMatch(guildPanelSource, serverOnlyForbidden);
    }
    for (const marketingForbidden of [/インフラ成功率/, /品質ゲート/, /quality_status/, /recommended_action/, /http_status/, /discord_code/]) {
        assert.doesNotMatch(providerPanelSource, marketingForbidden);
    }
    assert.match(guildPanelSource, /サーバーレポート要約/);
    assert.match(guildPanelSource, /表示の安定性/);
    assert.match(providerPanelSource, /マーケティングレポート要約/);
    assert.match(providerPanelSource, /反応を伸ばしている要因/);
    assert.match(providerPanelSource, /流入パラメータ/);
    assert.match(providerPanelSource, /マーケティング軸別の反応/);
    assert.match(providerPanelSource, /カード表示率/);
    assert.match(providerPanelSource, /表示完了率/);

    for (const token of ['account_key', 'source', 'message_id', 'channel_id', 'author_user_id', 'url_hash', 'stack_hash', 'message_hash']) {
        assert.doesNotMatch(helperSource, new RegExp(`\\b${token}\\b`));
    }
});

test('user-facing analytics previews expose scoped advanced decision analytics', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const helperStart = dataSource.indexOf('async function getDetailedFunnelAnalytics');
    const helperEnd = dataSource.indexOf('\nasync function getDetailedRawSamples', helperStart);
    const guildPreviewStart = dataSource.indexOf('async function buildAdminGuildAnalyticsPreview');
    const providerPreviewStart = dataSource.indexOf('async function buildAdminProviderMarketingPreview');
    const providerPreviewEnd = dataSource.indexOf('\ntype AdminGuildAnalyticsPreviewSnapshot', providerPreviewStart);
    const guildPanelStart = uiSource.indexOf('function GuildAdminPreviewPanel');
    const providerPanelStart = uiSource.indexOf('function ProviderMarketingPreviewPanel');
    const providerPanelEnd = uiSource.indexOf('\nfunction LogsPanel', providerPanelStart);

    assert.notEqual(helperStart, -1, 'scoped advanced preview helpers must exist');
    assert.notEqual(helperEnd, -1, 'scoped advanced preview helpers must be isolated before raw samples');
    assert.notEqual(guildPreviewStart, -1, 'guild preview must exist');
    assert.notEqual(providerPreviewStart, -1, 'provider preview must exist');
    assert.notEqual(providerPreviewEnd, -1, 'provider preview must be isolated');
    assert.notEqual(guildPanelStart, -1, 'guild preview panel must exist');
    assert.notEqual(providerPanelStart, -1, 'provider preview panel must exist');
    assert.notEqual(providerPanelEnd, -1, 'provider preview panel must be isolated');

    const helperSource = dataSource.slice(helperStart, helperEnd);
    const guildPreviewSource = dataSource.slice(guildPreviewStart, providerPreviewStart);
    const providerPreviewSource = dataSource.slice(providerPreviewStart, providerPreviewEnd);
    const guildPanelSource = uiSource.slice(guildPanelStart, providerPanelStart);
    const providerPanelSource = uiSource.slice(providerPanelStart, providerPanelEnd);

    for (const name of [
        'getDetailedFunnelAnalytics',
        'getDetailedWeeklyCohorts',
        'getDetailedContentLifetime',
        'getDetailedUrlReuse',
        'getDetailedSettingImpact',
    ]) {
        assert.match(helperSource, new RegExp(`async function ${name}`));
    }

    for (const model of [
        'scoped_user_facing_funnel',
        'scoped_user_facing_weekly_cohort',
        'scoped_user_facing_content_lifetime',
        'scoped_user_facing_url_reuse',
        'scoped_user_facing_setting_impact',
    ]) {
        assert.match(helperSource, new RegExp(`analysis_model: "${model}"`));
    }

    assert.match(helperSource, /protectSmallGroupRows/);
    assert.match(helperSource, /COUNT\(DISTINCT [^)]+author_user_id\) AS users/);
    assert.match(guildPreviewSource, /getDetailedFunnelAnalytics\(filters, window, limit\)/);
    assert.match(guildPreviewSource, /getDetailedWeeklyCohorts\(filters, window, limit\)/);
    assert.match(guildPreviewSource, /getDetailedContentLifetime\(filters, window, limit\)/);
    assert.match(guildPreviewSource, /getDetailedUrlReuse\(filters, window, limit\)/);
    assert.match(guildPreviewSource, /getDetailedSettingImpact\(filters, window, limit\)/);
    assert.match(providerPreviewSource, /getDetailedFunnelAnalytics\(filters, window, limit\)/);
    assert.match(providerPreviewSource, /getDetailedWeeklyCohorts\(filters, window, limit\)/);
    assert.match(providerPreviewSource, /getDetailedContentLifetime\(filters, window, limit\)/);
    assert.match(providerPreviewSource, /getDetailedUrlReuse\(filters, window, limit\)/);

    for (const section of ['funnelAnalytics', 'weeklyCohorts', 'contentLifetime', 'urlReuse']) {
        assert.match(guildPreviewSource, new RegExp(`${section}:`));
        assert.match(providerPreviewSource, new RegExp(`${section}:`));
        assert.match(uiSource, new RegExp(`previewSectionRows\\(preview, "${section}"\\)`));
    }
    assert.match(guildPreviewSource, /settingImpact: protectedSettingImpact/);
    assert.doesNotMatch(guildPanelSource, /previewSectionRows\(preview, "settingImpact"\)/);
    assert.doesNotMatch(guildPanelSource, /設定変更の影響/);
    assert.doesNotMatch(providerPanelSource, /previewSectionRows\(preview, "settingImpact"\)/);
    assert.match(guildPreviewSource, /applyPreviewUrlPolicyRows\(protectUserFacingPreviewRows\(contentLifetime\), urlVisibility\)/);
    assert.match(providerPreviewSource, /applyPreviewUrlPolicyRows\(protectUserFacingPreviewRows\(urlReuse\), urlVisibility\)/);
    for (const panelSource of [guildPanelSource, providerPanelSource]) {
        assert.match(panelSource, /反応までの流れ/);
        assert.match(panelSource, /週別の継続反応/);
        assert.match(panelSource, /長く見られるコンテンツ/);
        assert.match(panelSource, /URLの再利用と広がり/);
    }

    for (const token of ['message_id', 'channel_id', 'url_hash', 'stack_hash', 'message_hash', 'content_event_id']) {
        assert.doesNotMatch(helperSource, new RegExp(`\\b${token}\\b`));
    }
});

test('admin advanced analytics exposes derived aggregate health', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');

    assert.match(dataSource, /getDerivedAggregateStatus/);
    assert.match(dataSource, /bot_provider_hourly_aggregates/);
    assert.match(dataSource, /bot_provider_hourly_unique_keys/);
    assert.match(dataSource, /latest_raw_analytics_ms/);
    assert.match(dataSource, /latest_raw_content_ms/);
    assert.match(dataSource, /aggregate_lag_hours/);
    assert.match(dataSource, /aggregate_stale/);
    assert.match(dataSource, /getAggregateOperationalTrend/);
    assert.match(dataSource, /operationalTrend/);
    assert.match(dataSource, /unique_data_source: "bot_provider_hourly_unique_keys"/);
    assert.match(dataSource, /providerRateLimits/);
    assert.match(dataSource, /enrichmentQueueOutcomes/);
    assert.match(uiSource, /Derived aggregate health/);
    assert.match(uiSource, /Aggregate provider coverage/);
    assert.match(uiSource, /Aggregate operational trend 7d/);
    assert.match(uiSource, /Hourly aggregate reach/);
    assert.match(uiSource, /Provider\/account aggregate volume/);
    assert.match(uiSource, /Provider content type reach/);
    assert.match(uiSource, /Provider API rate limits/);
    assert.match(uiSource, /Enrichment queue outcomes/);
    assert.match(uiSource, /aggregate lag/);
});

test('admin advanced analytics exposes funnel, cohort, attribution, and account health analysis', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');

    for (const symbol of [
        'getFunnelAnalytics',
        'getSettingChangeImpact',
        'getSettingAttributionSummary',
        'getWeeklyCohortAnalytics',
        'getContentLifetimeAnalytics',
        'getUrlReuseAnalytics',
        'getProviderAccountHealth',
        'getMediaDeliveryAnalytics',
        'getProviderAnomalySignals',
        'getAggregateSeasonalityAnalytics',
        'getAggregateEventDaySpikes',
        'getAggregateAudienceCorrelation',
        'getProviderMetricNullRates',
        'buildDecisionInsights',
    ]) {
        assert.match(dataSource, new RegExp(symbol));
    }
    assert.match(dataSource, /bot_provider_hourly_unique_keys/);
    assert.match(dataSource, /analysis_model: "audience_correlation"/);
    assert.match(dataSource, /analysis_model: "seasonality"/);
    assert.match(dataSource, /analysis_model: "event_day_seasonality"/);
    assert.match(dataSource, /analysis_model: "setting_attribution_summary"/);
    assert.match(dataSource, /provider_enabled/);
    assert.match(dataSource, /unique_data_source: "bot_provider_hourly_unique_keys"/);
    assert.match(dataSource, /event_day_lift/);
    assert.match(dataSource, /protectSmallGroupRows\(decorateEventDaySpikeRows/);
    assert.match(dataSource, /"target_users"/);
    assert.match(dataSource, /"interest_users"/);
    assert.match(dataSource, /"total_users"/);
    assert.match(dataSource, /return protectSmallGroupRows\(rows\);/);
    for (const label of [
        'Funnel analytics 7d',
        'Media delivery value 7d',
        'Provider account health',
        'Provider anomaly signals',
        'Decision insights',
        'Setting change impact',
        'Setting attribution summary 30d',
        'Weekly cohorts',
        'Content lifetime 30d',
        'URL reuse 30d',
        'Seasonality 30d',
        'Audience correlation 7d',
        'Provider weekday seasonality',
        'Event-day spikes 30d',
        'Provider event-day spike candidates',
        'Metric null and coverage rates',
    ]) {
        assert.match(uiSource, new RegExp(label));
    }
});

test('admin analytics snapshots are produced by background batches instead of regular GET fallback work', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const adminPageSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'app', 'admin', 'page.tsx'), 'utf8');
    const instrumentationSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'instrumentation.ts'), 'utf8');
    const adminLoaderSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console-loader.tsx'), 'utf8');
    const adminCatalogRouteSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'app', 'api', 'admin', 'catalog', 'route.ts'), 'utf8');
    const overviewBody = dataSource.match(/export async function getAdminOverview\([\s\S]*?\n\}/)?.[0] || '';
    const detailedBody = dataSource.match(/export async function getAdminDetailedAnalytics\([\s\S]*?export type AdminGuildAnalyticsPreviewFilters/)?.[0] || '';
    const guildPreviewBody = dataSource.match(/export async function getAdminGuildAnalyticsPreview\([\s\S]*?export async function getAdminProviderMarketingPreview/)?.[0] || '';
    const providerPreviewBody = dataSource.match(/export async function getAdminProviderMarketingPreview\([\s\S]*?\n\}/)?.[0] || '';

    assert.match(dataSource, /ADMIN_ANALYTICS_BATCH_INTERVAL_MS = 5 \* 60 \* 1000/);
    assert.match(dataSource, /ADMIN_ANALYTICS_QUERY_CONCURRENCY = 2/);
    assert.match(dataSource, /function enqueueAdminAnalyticsBuild/);
    assert.match(dataSource, /function ensureAdminOverviewBatchRefresh\(\)[\s\S]*setInterval/);
    assert.match(dataSource, /function ensureAdminDetailedAnalyticsBatchRefresh\(\)[\s\S]*setInterval/);
    assert.match(dataSource, /function ensureAdminGuildAnalyticsPreviewBatchRefresh\(\)[\s\S]*setInterval/);
    assert.match(dataSource, /function ensureAdminProviderMarketingPreviewBatchRefresh\(\)[\s\S]*setInterval/);
    assert.match(dataSource, /refreshPromise = enqueueAdminAnalyticsBuild\(\(\) => buildAdminOverview\(\)\)/);
    assert.match(dataSource, /refreshPromise = enqueueAdminAnalyticsBuild\(\(\) => buildAdminDetailedAnalytics\(entry\.filters\)\)/);
    assert.match(dataSource, /refreshPromise = enqueueAdminAnalyticsBuild\(\(\) => buildAdminGuildAnalyticsPreview\(entry\.filters\)\)/);
    assert.match(dataSource, /refreshPromise = enqueueAdminAnalyticsBuild\(\(\) => buildAdminProviderMarketingPreview\(entry\.filters\)\)/);
    assert.match(dataSource, /async function buildAdminDetailedAnalytics[\s\S]*await runLimited/);
    assert.match(dataSource, /async function buildAdminGuildAnalyticsPreview[\s\S]*await runLimited/);
    assert.match(dataSource, /async function buildAdminProviderMarketingPreview[\s\S]*await runLimited/);
    assert.match(dataSource, /async function getAdvancedAnalytics[\s\S]*await runLimited/);
    assert.match(dataSource, /ADMIN_ANALYTICS_CACHE_MAX_ENTRIES = 12/);
    assert.match(dataSource, /ADMIN_ANALYTICS_CACHE_ACTIVE_MS = 60 \* 60 \* 1000/);
    assert.match(dataSource, /function emptyAdminOverviewSnapshot/);
    assert.match(dataSource, /function emptyAdminDetailedAnalyticsSnapshot/);
    assert.match(dataSource, /function emptyGuildAnalyticsPreviewSnapshot/);
    assert.match(dataSource, /function emptyProviderMarketingPreviewSnapshot/);
    assert.match(overviewBody, /emptyAdminOverviewSnapshot\(\)/);
    assert.equal((overviewBody.match(/await refreshAdminOverviewCache\(\)/g) || []).length, 1);
    assert.match(detailedBody, /emptyAdminDetailedAnalyticsSnapshot\(filters\)/);
    assert.doesNotMatch(detailedBody, /buildAdminDetailedAnalytics\(filters\)/);
    assert.match(guildPreviewBody, /emptyGuildAnalyticsPreviewSnapshot\(filters\)/);
    assert.doesNotMatch(guildPreviewBody, /buildAdminGuildAnalyticsPreview\(filters\)/);
    assert.match(providerPreviewBody, /emptyProviderMarketingPreviewSnapshot\(filters\)/);
    assert.doesNotMatch(providerPreviewBody, /buildAdminProviderMarketingPreview\(filters\)/);
    assert.doesNotMatch(adminPageSource, /getAdminProviderCatalog/);
    assert.match(adminPageSource, /AdminConsoleLoader/);
    assert.doesNotMatch(adminPageSource, /warmAdminOverviewCache/);
    assert.match(adminLoaderSource, /dynamic\(/);
    assert.match(adminLoaderSource, /ssr: false/);
    assert.match(adminCatalogRouteSource, /getAdminProviderCatalog/);
    assert.match(instrumentationSource, /warmAdminOverviewCache\(\)/);
    assert.match(instrumentationSource, /warmAdminDetailedAnalyticsCache\(\)/);
    assert.match(instrumentationSource, /warmAdminGuildAnalyticsPreviewCache\(\)/);
    assert.match(instrumentationSource, /warmAdminProviderMarketingPreviewCache\(\)/);
});

test('media delivery routes record non-blocking analytics events', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'media-delivery.ts'), 'utf8');
    const youtubeStore = fs.readFileSync(path.join(repoRoot, 'src', 'youtubeDownloadStore.js'), 'utf8');
    const niconicoStore = fs.readFileSync(path.join(repoRoot, 'src', 'niconicoDownloadStore.js'), 'utf8');
    assert.match(source, /recordMediaDeliveryEvent/);
    assert.match(source, /recordAnalyticsEvent\?\.\("media_delivery"/);
    assert.match(source, /dashboard\.media_delivery/);
    assert.match(source, /Analytics recording must never affect media delivery/);
    assert.match(youtubeStore, /recordAnalyticsEvent\('media_delivery'/);
    assert.match(youtubeStore, /express\.media_delivery/);
    assert.match(niconicoStore, /recordAnalyticsEvent\('media_delivery'/);
    assert.match(niconicoStore, /express\.media_delivery/);
});
