'use strict';

const { StringDecoder } = require('node:string_decoder');
const { monitorError } = require('../autoWatch/_shared');

function escapeXml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function decodeXmlScalar(value) {
    return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
        .replaceAll('&#39;', "'").replaceAll('&quot;', '"');
}

// Retain only the Atom metadata used by automatic watching. Descriptions,
// media groups and unrelated document text are consumed without accumulating
// the complete response in memory.
async function readFeedProjection(response) {
    let mode = 'text', tag = '', tagOverflow = false, sectionTail = '';
    let feedSeen = false, feedClosed = false, entry = null, field = null, raw = '';
    let channelId = null, entryCount = 0;
    const entries = [];
    const invalid = () => monitorError('AUTO_WATCH_INVALID_RESPONSE', 'YouTube did not return a complete channel feed.');
    const append = character => {
        if (!field) return;
        raw += character;
        if (raw.length > 65536) throw invalid();
    };
    const finishTag = value => {
        if (feedClosed && /^<\/?[A-Za-z]/.test(value)) throw invalid();
        if (!feedSeen && /^<[A-Za-z]/.test(value) && !/^<feed(?:\s[^>]*)?>$/i.test(value)) throw invalid();
        if (/^<feed(?:\s[^>]*)?>$/i.test(value)) {
            if (feedSeen) throw invalid();
            feedSeen = true;
        }
        else if (/^<\/feed\s*>$/i.test(value)) feedClosed = true;
        else if (/^<entry\s*>$/i.test(value) && feedSeen && !feedClosed) {
            if (entry || ++entryCount > 5000) throw invalid();
            entry = {};
        } else if (/^<\/entry\s*>$/i.test(value) && entry) {
            if (field) throw invalid();
            entries.push(`<entry>${['yt:videoId', 'title', 'published'].map(name => entry[name] == null ? '' : `<${name}>${escapeXml(entry[name])}</${name}>`).join('')}</entry>`);
            entry = null;
        } else {
            const closing = value.match(/^<\/(yt:videoId|yt:channelId|title|published)>$/i)?.[1];
            if (field && closing?.toLowerCase() === field.toLowerCase()) {
                const decoded = decodeXmlScalar(raw.slice(0, -value.length));
                if (field === 'yt:channelId') { if (channelId == null) channelId = decoded; }
                else if (entry && entry[field] == null) entry[field] = decoded;
                field = null; raw = '';
                return;
            }
            const opening = value.match(/^<(yt:videoId|yt:channelId|title|published)>$/i)?.[1]?.toLowerCase();
            if (opening && !field && feedSeen && !feedClosed && (entry || opening === 'yt:channelid')) {
                field = ({ 'yt:videoid': 'yt:videoId', 'yt:channelid': 'yt:channelId', title: 'title', published: 'published' })[opening] || null;
                raw = '';
            }
        }
    };
    const consume = text => {
        for (const character of text) {
            append(character);
            if (mode === 'cdata' || mode === 'comment') {
                sectionTail = (sectionTail + character).slice(-3);
                if (sectionTail === (mode === 'cdata' ? ']]>' : '-->')) { mode = 'text'; sectionTail = ''; }
            } else if (mode === 'tag') {
                if (!tagOverflow) {
                    tag += character;
                    if (tag.length > 1024) { tag = ''; tagOverflow = true; }
                }
                if (tag === '<![CDATA[') { mode = 'cdata'; tag = ''; }
                else if (tag === '<!--') { mode = 'comment'; tag = ''; }
                else if (character === '>') {
                    if (!tagOverflow) finishTag(tag);
                    mode = 'text'; tag = ''; tagOverflow = false;
                }
            } else if (character === '<') { mode = 'tag'; tag = '<'; }
        }
    };
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        const decoder = new StringDecoder('utf8');
        for await (const chunk of response.body) consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
        consume(decoder.end());
    } else consume(await response.text());
    if (!feedSeen || !feedClosed || entry || field || mode !== 'text') throw invalid();
    return `<feed>${channelId == null ? '' : `<yt:channelId>${escapeXml(channelId)}</yt:channelId>`}${entries.join('')}</feed>`;
}

module.exports = { readFeedProjection };
