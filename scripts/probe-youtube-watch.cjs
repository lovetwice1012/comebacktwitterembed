'use strict';
// Public GET-only diagnostic. It never opens the DB, registers a monitor or
// sends a Discord notification. Both optional tabs are enabled for inspection.
const { fetchSource } = require('../src/providers/autoWatch');
const channelId = process.argv[2], expectedVideo = process.argv[3];
if (!/^UC[A-Za-z0-9_-]{20,}$/.test(channelId || '') || expectedVideo && !/^[A-Za-z0-9_-]{11}$/.test(expectedVideo)) {
    throw Error('Usage: node scripts/probe-youtube-watch.cjs UC_CHANNEL_ID [EXPECTED_VIDEO_ID]');
}
(async () => {
    const source = { provider_id: 'youtube', source_key: `channel:${channelId}`, state_json: '{}',
        youtube_fetch_releases: 1, youtube_fetch_community: 1 };
    const options = { fetch: require('node-fetch'), isolate: false, config: { timeoutMs: 15000 } };
    const first = await fetchSource(source, options);
    const second = await fetchSource({ ...source, initialized_at_ms: Date.now(), state_json: JSON.stringify(first.state),
        cursor_json: JSON.stringify({ seenContentIds: first.items.map(item => item.contentId) }), etag: first.etag, last_modified: first.lastModified }, options);
    const known = new Set(first.items.map(item => item.contentId));
    const releases = first.items.filter(item => item.youtubeContentKind === 'release');
    const posts = first.items.filter(item => item.youtubeContentKind === 'community');
    const found = !expectedVideo || releases.some(item => item.contentId === expectedVideo);
    console.log(JSON.stringify({ at: new Date().toISOString(), channelId, readOnly: true, databaseWrites: 0, notificationsSent: 0,
        isolatedWorkerTest: false, publicFetch: true, releaseCount: releases.length, communityCount: posts.length,
        ...(expectedVideo ? { expectedVideo, expectedReleaseFound: found } : {}), quietBaselineCount: first.baselineItems.length,
        secondBaselineCount: second.baselineItems.length, secondNewIds: second.items.filter(item => !known.has(item.contentId)).map(item => item.contentId),
        releases: releases.map(item => ({ id: item.contentId, title: item.title, url: item.url })),
        posts: posts.slice(0, 3).map(item => ({ id: item.contentId, title: item.title.slice(0, 160), url: item.url })) }, null, 2));
    if (!found) process.exitCode = 1;
})().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name })); process.exitCode = 1; });
