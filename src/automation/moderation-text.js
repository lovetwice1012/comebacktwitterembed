'use strict';

// Additional screening views, never a rewrite of stored/displayed text.
// This is a deliberately limited lookalike table, NOT full UTS #39 conformance
// or a semantic safety classifier. Keep the original view for real languages.
const lookalikes = Object.freeze({ 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ӏ': 'l', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i' });
const { normalize } = require('./dictionary');
const TEXT_LIMIT = 2 * 1024 * 1024;
// A term has at most 255 source UTF-16 units. Leave room for compatibility
// expansion and case folding, including a containing allow-span on either side.
const CONTEXT = 255 * 36;
function moderationViews(text, normalization = {}) {
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) throw new Error('MODERATION_TEXT_LIMIT');
    const original = normalize(text, normalization);
    const visible = normalize(original.replace(/\p{Default_Ignorable_Code_Point}/gu, ''), normalization);
    // Fold mixed Latin/lookalike tokens only. Transliteration of whole Greek or
    // Cyrillic words manufactures Latin dictionary hits in ordinary language.
    const folded = visible.replace(/[\p{L}\p{M}\p{N}_]+/gu, token => /[a-z]/i.test(token)
        ? token.replace(/[аеорсхуіјѕӏԁԛԝαορνι]/gu, character => lookalikes[character]) : token);
    if ([original, visible, folded].some(view => view.length > TEXT_LIMIT)) throw new Error('MODERATION_TEXT_LIMIT');
    return [...new Set([original, visible, folded])];
}
function* windows(text) {
    for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + 65536);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        yield { text: text.slice(start, end), start, end };
        if (end === text.length) break;
        start = end - 2 * CONTEXT - 2;
        if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
    }
}
function* chunks(text) { for (const window of windows(text)) yield window.text; }
async function screenText(text, match, normalization = {}) {
    for (const view of moderationViews(text, normalization)) for (const part of windows(view)) {
        const hits = await match(part.text);
        if (!Array.isArray(hits) || hits.some(hit => !hit || typeof hit.term !== 'string' || !Number.isInteger(hit.start)
            || !Number.isInteger(hit.end) || hit.start < 0 || hit.end <= hit.start || hit.end > part.text.length)) throw new Error('MODERATION_INVALID_RESULT');
        // A hit near an artificial boundary may be a truncated word/exception
        // or a prefix/suffix/exact rule evaluated against the wrong boundary.
        // The overlap places every real span inside a neighboring window.
        const certain = hits.filter(hit => (part.start === 0 || hit.start >= CONTEXT)
            && (part.end === view.length || hit.end <= part.text.length - CONTEXT));
        if (certain.length) return certain;
        // The evaluator returns at most five hits. Do not mistake a truncated
        // boundary-only result for evidence that the rest of this window passed.
        if (hits.length >= 5) throw new Error('MODERATION_MATCH_LIMIT');
    }
    return [];
}
const staticOutput = config => require('./text-transform').outputText(config, {}, 'MODERATION_TEXT_LIMIT');
function publicationText(input, bundle) {
    const values = new Set(); let length = 0;
    function add(text) {
        if (typeof text !== 'string' || !text || values.has(text)) return;
        length += text.length + (values.size ? 1 : 0);
        if (length > TEXT_LIMIT) throw new Error('MODERATION_TEXT_LIMIT');
        values.add(text);
    }
    for (const key of ['title', 'description', 'category', 'changelog']) add(input[key]);
    add(bundle.description); add(bundle.license);
    const rule = bundle.workflow;
    add(rule?.name); add(rule?.description);
    for (const group of rule?.layout?.groups || []) add(group.label);
    for (const node of rule?.nodes || []) {
        const c = node.config;
        if (node.type === 'stop') add(c.reason);
        if (node.type === 'transform') {
            add(c.template); add(c.prefix); add(c.suffix);
            for (const replacement of c.replacements || []) add(replacement.to);
            // Dynamic events require an additional final-payload check. This
            // static preview catches literal joins/replacements only.
            add(staticOutput(c));
        }
    }
    for (const dictionary of Object.values(bundle.dictionaries || {})) {
        add(dictionary.name); add(dictionary.source); add(dictionary.license);
        for (const entry of dictionary.entries) if (typeof entry === 'object') { add(entry.category); add(entry.replacement); }
        // Terms and predicate operands are filter data, not publication copy.
        // Structural, link and credential checks still inspect these values.
    }
    return [...values].join('\n');
}
module.exports = { moderationViews, chunks, screenText, publicationText };
