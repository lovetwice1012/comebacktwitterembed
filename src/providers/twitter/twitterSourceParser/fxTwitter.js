'use strict';

const { validateTwitterMediaUrl } = require('./mediaUrlPolicy');

// The fallback API nests its post under `tweet`, while the extractor consumes
// the Vx-style flat representation. Never infer media order by concatenating
// different type-specific arrays: `media.all` is the ordered source.
function invalid() { throw new Error('Twitter fallback returned an incomplete post.'); }
function statusIdentity(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value), match = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d+)(?:\/|$)/i.exec(url.pathname);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !['twitter.com', 'x.com'].includes(url.hostname.toLowerCase()) || !match) return null;
        return match[1];
    } catch { return null; }
}
function mediaUrl(value, kind) {
    try { validateTwitterMediaUrl(value, kind); return value; }
    catch { return null; }
}
function markedSensitive(value) {
    return value === true || typeof value === 'number' && value > 0
        || typeof value === 'string' && /^(true|yes|1|sensitive|nsfw|adult)$/i.test(value.trim());
}
function hasSensitiveFlag(value) {
    return value && typeof value === 'object' && ['possibly_sensitive', 'possiblySensitive', 'sensitive', 'is_sensitive',
        'isSensitive', 'nsfw', 'adult_content', 'adultContent'].some(key => markedSensitive(value[key]));
}
function blocked() {
    throw Object.assign(new Error('Twitter fallback post is sensitive, protected, or cannot be verified.'),
        { name: 'ExpectedNonExpandableTweetError', expectedNonExpandable: true });
}
// The legacy Fx API omits undefined `possibly_sensitive` and also omits an
// empty media object. Only admit the observed, unambiguous text-only shape;
// never interpret a missing sensitivity value as `false` for analytics.
const LEGACY_TEXT_FIELDS = new Set(['url', 'id', 'text', 'raw_text', 'author', 'replies', 'retweets', 'likes',
    'bookmarks', 'quotes', 'created_at', 'created_timestamp', 'views', 'is_note_tweet', 'community_note', 'lang',
    'replying_to', 'replying_to_status', 'twitter_card', 'color', 'provider', 'reposted_by']);
function isUnambiguousLegacyTextOnly(tweet) {
    if (Object.keys(tweet).some(key => !LEGACY_TEXT_FIELDS.has(key)) || tweet.provider !== 'twitter'
        || tweet.twitter_card !== 'tweet' || tweet.is_note_tweet !== false) return false;
    if (['community_note', 'replying_to', 'replying_to_status', 'reposted_by'].some(key => tweet[key] != null)) return false;
    const raw = tweet.raw_text;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).some(key => !['text', 'display_text_range', 'facets'].includes(key))
        || raw.text !== tweet.text || !Array.isArray(raw.facets) || raw.facets.length !== 0
        || !Array.isArray(raw.display_text_range) || raw.display_text_range.length !== 2
        || raw.display_text_range[0] !== 0 || raw.display_text_range[1] !== tweet.text.length) return false;
    // Links or shortened media links are deliberately not treated as proof of
    // a text-only item when the sensitivity flag is absent.
    return !/(?:https?:\/\/|www\.|\b(?:t\.co|pic\.twitter\.com|x\.com|twitter\.com)\/)/i.test(tweet.text);
}
function orderedMedia(media) {
    if (media == null) return [];
    if (typeof media !== 'object' || Array.isArray(media)) return invalid();
    if (media.all !== undefined) {
        if (!Array.isArray(media.all)) return invalid();
        const identities = new Set(media.all.map(item => item && typeof item === 'object' ? String(item.id || item.url || '') : ''));
        for (const key of ['photos', 'videos']) {
            if (media[key] !== undefined && (!Array.isArray(media[key]) || media[key].length > media.all.length)) return invalid();
            if (Array.isArray(media[key]) && media[key].some(item => !item || typeof item !== 'object'
                || !identities.has(String(item.id || item.url || '')))) return invalid();
        }
        if (!media.all.length && media.external) return invalid();
        return media.all;
    }
    const candidates = ['photos', 'videos'].filter(key => media[key] !== undefined);
    if (candidates.some(key => !Array.isArray(media[key])) || candidates.length > 1) return invalid();
    if (!candidates.length && media.external) return invalid();
    return candidates.length ? media[candidates[0]] : [];
}
function normalizeFxTwitter(payload, expectedUrl) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'tweet')) return null;
    if (payload.code !== 200 || !payload.tweet || typeof payload.tweet !== 'object' || Array.isArray(payload.tweet)) return invalid();
    const tweet = payload.tweet, id = typeof tweet.id === 'string' ? tweet.id : '', fromUrl = statusIdentity(tweet.url);
    if (!/^\d{1,22}$/.test(id) || fromUrl !== id || expectedUrl && statusIdentity(expectedUrl) !== id) return invalid();
    if (!tweet.author || typeof tweet.author !== 'object' || Array.isArray(tweet.author)
        || typeof tweet.author.name !== 'string' || typeof tweet.author.screen_name !== 'string'
        || !/^[A-Za-z0-9_]{1,15}$/.test(tweet.author.screen_name) || typeof tweet.text !== 'string') return invalid();
    // A fallback must not turn a denied/unknown sensitive or protected post
    // into a public attachment merely because a different provider responds.
    const unknownTextOnly = !Object.hasOwn(tweet, 'possibly_sensitive') && isUnambiguousLegacyTextOnly(tweet);
    if (tweet.possibly_sensitive !== false && !unknownTextOnly || hasSensitiveFlag(tweet)
        || tweet.author.protected !== false || markedSensitive(tweet.community?.is_nsfw)) return blocked();
    const extended = orderedMedia(tweet.media);
    const urls = extended.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !['photo', 'video', 'gif'].includes(item.type)) return invalid();
        if (hasSensitiveFlag(item)) return blocked();
        const url = mediaUrl(item.url, item.type === 'photo' ? 'photo' : 'video');
        if (!url) return invalid();
        if (item.type !== 'photo') {
            // Never substitute a preview image for a playable video/GIF.
            const parsed = new URL(url);
            if (!/\.mp4$/i.test(parsed.pathname)) return invalid();
        }
        return url;
    });
    let quote = null;
    if (tweet.quote != null) {
        if (typeof tweet.quote !== 'object' || Array.isArray(tweet.quote)) return invalid();
        if (tweet.quote.url != null) {
            if (!statusIdentity(tweet.quote.url)) return invalid();
            quote = tweet.quote.url;
        }
    }
    let article = null;
    if (tweet.article != null) {
        if (typeof tweet.article !== 'object' || Array.isArray(tweet.article)) return invalid();
        const image = tweet.article.image ?? tweet.article.cover_media?.media_info?.original_img_url;
        if (image != null && !mediaUrl(image, 'photo')) return invalid();
        article = { ...tweet.article, image: image || null };
    }
    const normalized = { ...tweet, tweetID: id, tweetURL: tweet.url, user_name: tweet.author.name,
        user_screen_name: tweet.author.screen_name, date: tweet.created_at, retweets: tweet.retweets ?? tweet.reposts,
        mediaURLs: urls, media_extended: extended, qrtURL: quote, article };
    Object.defineProperty(normalized, Symbol.for('cbte.twitter.fx.media'), { value: true });
    if (unknownTextOnly) Object.defineProperty(normalized, Symbol.for('cbte.twitter.fx.sensitivity.unknown'), { value: true });
    return normalized;
}
module.exports = { normalizeFxTwitter, _internal: { statusIdentity, mediaUrl, orderedMedia } };
