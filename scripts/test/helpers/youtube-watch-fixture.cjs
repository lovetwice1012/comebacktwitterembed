'use strict';
const channel = 'UCvhViFXvb5Y83YGEpRX1cvg';
const video = 'aqVt_zlAwK8', oldVideo = 'VP0n-6NbSf4';
const playlist = 'OLAK5uy_kZ9e27IKOzhFrYyKZRM-gWENj64u2ze6I';
const postId = 'UgkxkBbh6RX5JCtF4qdd2_apG645e5hQ_luB';
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300,
    headers: { get: () => null }, text: async () => body });
function page(lane, entries = [], options = {}) {
    const suffix = lane === 'community' ? 'posts' : 'releases';
    return `<script>var ytInitialData = ${JSON.stringify({ metadata: { channelMetadataRenderer: { externalId: options.owner || channel } },
        contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true,
            endpoint: { commandMetadata: { webCommandMetadata: { url: `/@millsage_ofc/${suffix}` } } },
            content: { richGridRenderer: { contents: entries.length ? entries : [{ messageRenderer: { text: { runs: [{ text: 'No items' }] } } }] } } } }] } },
        unrelated: options.unrelated })};</script>`;
}
function release(id = video, list = playlist) {
    return { playlistRenderer: { playlistId: list, videoCount: '1', title: { runs: [{ text: 'Odd Dice' }] }, navigationEndpoint: { watchEndpoint: { videoId: id } } } };
}
function post(id = postId, owner = channel) {
    return { backstagePostThreadRenderer: { post: { backstagePostRenderer: { postId: id,
        authorEndpoint: { browseEndpoint: { browseId: owner } }, contentText: { runs: [{ text: '新着のお知らせ 😀\n本文とURL https://example.org/' }] } } } } };
}
const rss = ids => `<feed><yt:channelId>${channel}</yt:channelId>${ids.map(id => `<entry><yt:videoId>${id}</yt:videoId><title>Video ${id}</title></entry>`).join('')}</feed>`;
function fetchFixture({ videos = [oldVideo], releases = [], posts = [], status = 200, calls = [] } = {}) {
    return async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('/feeds/')) return response(status === 304 ? '' : rss(videos), status);
        if (String(url).includes('/releases')) return response(page('releases', releases));
        if (String(url).includes('/posts')) return response(page('community', posts));
        throw new Error('Unexpected YouTube fixture URL');
    };
}
module.exports = { channel, video, oldVideo, playlist, postId, response, page, release, post, rss, fetchFixture };
