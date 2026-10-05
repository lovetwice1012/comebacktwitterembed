'use strict';

function reelPoster(shortcode = 'Ddmd-UrRH2B') {
    return `<meta property="og:url" content="https://www.instagram.com/reel/${shortcode}/">
      <meta property="og:image" content="https://example.com/${shortcode}.jpg">
      <meta property="og:description" content="Reel caption #cat">`;
}

function reelVideoNode(shortcode = 'Ddmd-UrRH2B') {
    return { __typename: 'GraphVideo', shortcode, owner: { username: 'artist' },
        display_url: `https://example.com/${shortcode}.jpg`,
        video_url: `https://example.com/${shortcode}.mp4?sig=fixture`,
        edge_media_to_caption: { edges: [{ node: { text: 'Reel caption #cat' } }] } };
}

function reelVideoHtml(shortcode = 'Ddmd-UrRH2B') {
    return `<script>window.data=${JSON.stringify({ shortcode_media: reelVideoNode(shortcode) })};</script>`;
}

module.exports = { reelPoster, reelVideoNode, reelVideoHtml };
