'use strict';

// Defaults also cover targets created before these settings existed.
function optionsFromRow(row = {}) {
    return { releases: row.youtube_include_releases == null || Number(row.youtube_include_releases) === 1,
        community: Number(row.youtube_include_community || 0) === 1 };
}

function normalizeOptions(value, previous = {}) {
    if (value === undefined) return optionsFromRow(previous);
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['releases', 'community'].includes(key))
        || Object.values(value).some(entry => typeof entry !== 'boolean')) {
        throw Object.assign(new Error('YouTubeの通知対象を選び直してください。'), { code: 'INVALID_YOUTUBE_OPTIONS', status: 400 });
    }
    return { ...optionsFromRow(previous), ...value };
}

function acceptsItem(target, item, discoveredAtMs) {
    const kind = item.youtubeContentKind;
    if (!['release', 'community'].includes(kind)) return true;
    const options = optionsFromRow(target), column = kind === 'release' ? 'releases' : 'community';
    return options[column] && target[`youtube_${column}_baseline_at_ms`] != null
        && Number(target[`youtube_${column}_since_ms`] || 0) < discoveredAtMs;
}

module.exports = { optionsFromRow, normalizeOptions, acceptsItem };
