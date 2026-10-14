'use strict';
const LIMIT = 2 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code === 'AUTOMATION_TEXT_LIMIT' ? '通知文の変換が大きすぎます。差し込み数・置換回数・長さを減らしてください。' : code), { code, status: 400 }); };
function truncateText(text, maxLength) {
    let end = maxLength;
    // Discord limits use UTF-16 length; keep a complete Unicode character at
    // the cut while staying within that same limit.
    const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
    if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--;
    return text.slice(0, end);
}
function hasExpansionUrl(text, url) {
    for (let from = 0, at; (at = text.indexOf(url, from)) !== -1; from = at + url.length) {
        // Ordinary Bot expansion deliberately ignores these wrappers.
        const angle = text[at - 1] === '<' && text[at + url.length] === '>';
        const spoiler = text.slice(Math.max(0, at - 2), at) === '||' && text.slice(at + url.length, at + url.length + 2) === '||';
        if (!angle && !spoiler) return true;
    }
    return false;
}
function templateText(template, event, code = 'AUTOMATION_TEXT_LIMIT') {
    let length = template.length;
    if (length > LIMIT) fail(code);
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, key) => {
        const value = event[key], text = value == null ? '' : Array.isArray(value) ? value.join(', ') : String(value);
        length += text.length - whole.length;
        if (length > LIMIT) fail(code);
        return text;
    });
}
function outputText(display, event, code = 'AUTOMATION_TEXT_LIMIT') {
    let text = display.format === 'url' ? event.url || '' : templateText(display.template, event, code);
    if (text.length > LIMIT) fail(code);
    for (const { from, to } of display.replacements || []) {
        if (!from) fail(code);
        if (from === to) continue;
        let count = 0, offset = 0, found;
        while ((found = text.indexOf(from, offset)) !== -1) { count++; offset = found + from.length; }
        if (text.length + count * (to.length - from.length) > LIMIT) fail(code);
        // A callback preserves the literal $&, $$, $1 semantics of split/join.
        if (count) text = text.replaceAll(from, () => to);
    }
    if (text.length + (display.prefix?.length || 0) + (display.suffix?.length || 0) > LIMIT) fail(code);
    text = `${display.prefix || ''}${text}${display.suffix || ''}`;
    const maxLength = Math.min(display.maxLength, 1900);
    const output = truncateText(text, maxLength);
    if (display.format !== 'normal' || !event.url) return output;
    const url = String(event.url);
    if (url.length > maxLength) fail(code);
    if (hasExpansionUrl(output, url)) return output;
    // A long title, replacement, or custom template must not remove the URL
    // that the normal Bot path needs. Remove full hidden/truncated copies
    // before reserving room for one plain canonical URL.
    const body = text.replaceAll(url, '').trimEnd();
    const prefix = truncateText(body, Math.max(0, maxLength - url.length - 1)).trimEnd();
    return prefix ? `${prefix}\n${url}` : url;
}
module.exports = { templateText, outputText, LIMIT };
