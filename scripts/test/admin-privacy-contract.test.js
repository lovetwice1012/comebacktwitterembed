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
    assert.match(source, /const privacyScopeCountColumns = new Set/);
    assert.match(source, /const privacyCountColumns = new Set/);
    assert.match(source, /function hasSmallPrivacyGroup/);
    assert.match(source, /function getDetailedUserCohortBreakdown/);
    assert.match(source, /smallGroupsSuppressed: true/);
    assert.match(source, /smallGroupDetailColumns/);
    assert.match(source, /"author_user_id"/);
    assert.match(source, /"guild_id"/);
    assert.match(source, /"message_id"/);

    const privacyScopeCountColumnsSource = source.match(/const privacyScopeCountColumns = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
    const privacyCountColumnsSource = source.match(/const privacyCountColumns = new Set\(([\s\S]*?)\);/)?.[1] || '';
    const hasSmallPrivacyGroupSource = source.match(/function hasSmallPrivacyGroup\(row: Row\) \{([\s\S]*?)\n\}/)?.[1] || '';
    const protectSmallGroupRowSource = source.match(/function protectSmallGroupRow\(row: Row, extraDetailColumns: string\[] = \[]\) \{([\s\S]*?)\n\}/)?.[1] || '';

    for (const token of [
        '"guilds"',
        '"content_guilds"',
        '"shared_guilds"',
        '"target_guilds"',
        '"interest_guilds"',
        '"configured_guilds"',
        '"enabled_guilds"',
        '"disabled_guilds"',
        '"affected_guilds"',
    ]) {
        assert.match(privacyScopeCountColumnsSource, new RegExp(token));
    }
    assert.match(privacyCountColumnsSource, /\.\.\.privacyUserCountColumns/);
    assert.match(privacyCountColumnsSource, /\.\.\.privacyScopeCountColumns/);
    assert.match(hasSmallPrivacyGroupSource, /for \(const key of privacyCountColumns\)/);
    assert.match(protectSmallGroupRowSource, /privacyCountColumns\.has\(key\)[\s\S]*Number\(value\) < PRIVACY_MIN_GROUP_SIZE[\s\S]*return \[key, SMALL_GROUP_LABEL\]/);
});

test('admin analytics UI does not expose raw author user id filters', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    assert.doesNotMatch(source, /\["author_user_id",\s*filters\.authorUserId\]/);
    assert.doesNotMatch(source, /placeholder="author_user_id"/);
    assert.match(source, /匿名ユーザー/);
    assert.doesNotMatch(source, /previewSectionRows\(preview, "activeUsers"\)[\s\S]{0,500}author_user_id/);
    assert.doesNotMatch(source, /previewSectionRows\(preview, "audienceUsers"\)[\s\S]{0,500}author_user_id/);
    assert.match(source, /usage_bucket/);
    assert.match(source, /Failure reasons/);
    assert.match(source, /Value drivers/);
    assert.match(source, /URL query parameters/);
    assert.match(source, /previewSectionRows\(preview, "failureReasons"\)/);
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
    assert.match(dataSource, /const protectedUrlParameters = protectUserFacingPreviewRows\(urlParameterBreakdown, \["query_key"\]\)/);
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
    const previewStart = dataSource.indexOf('export async function getAdminProviderMarketingPreview');
    const previewEnd = dataSource.indexOf('\nasync function getAdvancedAnalytics', previewStart);

    assert.match(dataSource, /const PROVIDER_MARKETING_AXIS_SEGMENTS/);
    assert.match(dataSource, /function getDetailedProviderMarketingSegments/);
    assert.match(dataSource, /analysis_model: "provider_specific_axis_segment"/);
    assert.notEqual(previewStart, -1, 'provider marketing preview function must exist');
    assert.notEqual(previewEnd, -1, 'provider marketing preview function contract must be isolated');

    const providerPreviewSource = dataSource.slice(previewStart, previewEnd);
    assert.match(providerPreviewSource, /optionalQuery\(\[\], \(\) => getDetailedProviderMarketingSegments\(filters, window, limit\)\)/);
    assert.match(providerPreviewSource, /const protectedProviderSegments = protectUserFacingPreviewRows\(providerSegments, \["facet_value", "account_key"\]\)/);
    assert.match(providerPreviewSource, /sections: \{[\s\S]*providerSegments: protectedProviderSegments/);

    const providerSegmentsIndex = uiSource.indexOf('previewSectionRows(preview, "providerSegments")');
    const providerSegmentsEnd = uiSource.indexOf(']);', providerSegmentsIndex);
    assert.notEqual(providerSegmentsIndex, -1, 'provider marketing UI must read preview sections.providerSegments');
    assert.notEqual(providerSegmentsEnd, -1, 'providerSegments preview row mapping must be bounded');
    assert.match(uiSource, /Provider axis segments/);

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

test('user-facing analytics previews expose report readiness without row identifiers', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const helperStart = dataSource.indexOf('function userFacingPreviewReadinessRows');
    const helperEnd = dataSource.indexOf('\nexport async function getAdminGuildAnalyticsPreview', helperStart);
    const guildPreviewStart = dataSource.indexOf('export async function getAdminGuildAnalyticsPreview');
    const providerPreviewStart = dataSource.indexOf('export async function getAdminProviderMarketingPreview');
    const providerPreviewEnd = dataSource.indexOf('\nasync function getAdvancedAnalytics', providerPreviewStart);

    assert.notEqual(helperStart, -1, 'report readiness helper must exist');
    assert.notEqual(helperEnd, -1, 'report readiness helper must be isolated before preview functions');
    assert.notEqual(guildPreviewStart, -1, 'guild preview must exist');
    assert.notEqual(providerPreviewStart, -1, 'provider preview must exist');
    assert.notEqual(providerPreviewEnd, -1, 'provider preview must be isolated');

    const helperSource = dataSource.slice(helperStart, helperEnd);
    const guildPreviewSource = dataSource.slice(guildPreviewStart, providerPreviewStart);
    const providerPreviewSource = dataSource.slice(providerPreviewStart, providerPreviewEnd);

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

    assert.match(uiSource, /previewSectionRows\(preview, "reportReadiness"\)/);
    assert.match(uiSource, /previewSectionRows\(preview, "providerQualityGates"\)/);
    assert.match(uiSource, /Report readiness/);
    assert.match(uiSource, /Provider report quality gates/);
    assert.match(uiSource, /future server-admin report/);
    assert.match(uiSource, /future provider-facing reports/);

    for (const token of ['account_key', 'source', 'message_id', 'channel_id', 'author_user_id', 'url_hash', 'stack_hash', 'message_hash']) {
        assert.doesNotMatch(helperSource, new RegExp(`\\b${token}\\b`));
    }
});

test('user-facing analytics previews expose scoped advanced decision analytics', () => {
    const dataSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'lib', 'admin-data.ts'), 'utf8');
    const uiSource = fs.readFileSync(path.join(repoRoot, 'dashboard', 'components', 'admin', 'admin-console.tsx'), 'utf8');
    const helperStart = dataSource.indexOf('async function getDetailedFunnelAnalytics');
    const helperEnd = dataSource.indexOf('\nasync function getDetailedRawSamples', helperStart);
    const guildPreviewStart = dataSource.indexOf('export async function getAdminGuildAnalyticsPreview');
    const providerPreviewStart = dataSource.indexOf('export async function getAdminProviderMarketingPreview');
    const providerPreviewEnd = dataSource.indexOf('\nasync function getAdvancedAnalytics', providerPreviewStart);

    assert.notEqual(helperStart, -1, 'scoped advanced preview helpers must exist');
    assert.notEqual(helperEnd, -1, 'scoped advanced preview helpers must be isolated before raw samples');
    assert.notEqual(guildPreviewStart, -1, 'guild preview must exist');
    assert.notEqual(providerPreviewStart, -1, 'provider preview must exist');
    assert.notEqual(providerPreviewEnd, -1, 'provider preview must be isolated');

    const helperSource = dataSource.slice(helperStart, helperEnd);
    const guildPreviewSource = dataSource.slice(guildPreviewStart, providerPreviewStart);
    const providerPreviewSource = dataSource.slice(providerPreviewStart, providerPreviewEnd);

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
    assert.match(uiSource, /previewSectionRows\(preview, "settingImpact"\)/);
    assert.match(guildPreviewSource, /applyPreviewUrlPolicyRows\(protectUserFacingPreviewRows\(contentLifetime\), urlVisibility\)/);
    assert.match(providerPreviewSource, /applyPreviewUrlPolicyRows\(protectUserFacingPreviewRows\(urlReuse\), urlVisibility\)/);
    assert.match(uiSource, /Conversion funnel/);
    assert.match(uiSource, /Weekly retention cohorts/);
    assert.match(uiSource, /Content lifetime/);
    assert.match(uiSource, /URL reuse and spread/);
    assert.match(uiSource, /Setting impact/);

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
    assert.match(dataSource, /protectSmallGroupRows\(rows, \["target_account_key", "interest_account_key", "interest_content_type"\]\)/);
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
