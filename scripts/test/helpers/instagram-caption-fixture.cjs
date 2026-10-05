'use strict';

function captionPage({ shortcode = 'DeAdSjuBvPY', caption = 'An English photo caption #rescuecat', video = false, content = '' } = {}) {
    const script = JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{
        __bbox: { define: [['PolarisCreationModalComposeCaptionLexicalInputDeferred.react', [], { color: '#0866FF' }]] },
    }]]] });
    const attribute = caption.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    return `<html><head>
      <meta property="og:url" content="https://www.instagram.com/p/${shortcode}/">
      <meta property="og:title" content="artist">
      <meta property="og:description" content="${attribute}">
      <meta property="${video ? 'og:video' : 'og:image'}" content="https://example.com/media.${video ? 'mp4' : 'jpg'}">
      </head><body><script type="application/json">${script}</script>${content}</body></html>`;
}

module.exports = { captionPage };
