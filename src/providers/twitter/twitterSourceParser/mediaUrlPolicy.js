'use strict';

function error(code) { return Object.assign(new Error(code), { code }); }
function validateTwitterMediaUrl(raw, kind = 'any') {
    if (typeof raw !== 'string' || raw.length > 4096 || !['any', 'photo', 'video'].includes(kind)) throw error('TWITTER_MEDIA_UNSAFE_URL');
    let url;
    try { url = new URL(raw); } catch { throw error('TWITTER_MEDIA_UNSAFE_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw error('TWITTER_MEDIA_UNSAFE_URL');
    const photo = url.hostname === 'pbs.twimg.com'
        && /^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpe?g|png|webp|gif|avif))?(?::(?:orig|large|medium|small|thumb))?$/i.test(url.pathname);
    const video = url.hostname === 'video.twimg.com'
        && /^\/(?:ext_tw_video|amplify_video|tweet_video)\/[A-Za-z0-9_./-]+\.mp4$/i.test(url.pathname)
        && !url.pathname.includes('//');
    if ((!photo && !video) || kind === 'photo' && !photo || kind === 'video' && !video) throw error('TWITTER_MEDIA_UNSAFE_URL');
    const seen = new Set();
    for (const [key, value] of url.searchParams) {
        if (seen.has(key)) throw error('TWITTER_MEDIA_UNSAFE_URL');
        seen.add(key);
        if (photo && key === 'format' && /^(?:jpe?g|png|webp|gif|avif)$/i.test(value)) continue;
        if (photo && key === 'name' && /^(?:orig|large|medium|small|thumb|\d{1,5}x\d{1,5})$/i.test(value)) continue;
        if (video && key === 'tag' && /^\d{1,6}$/.test(value)) continue;
        throw error('TWITTER_MEDIA_UNSAFE_URL');
    }
    return { url, kind: photo ? 'photo' : 'video' };
}


module.exports = { validateTwitterMediaUrl };
