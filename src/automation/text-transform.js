'use strict';
const LIMIT = 2 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code === 'AUTOMATION_TEXT_LIMIT' ? '通知文の変換が大きすぎます。差し込み数・置換回数・長さを減らしてください。' : code), { code, status: 400 }); };
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
    return `${display.prefix || ''}${text}${display.suffix || ''}`.slice(0, display.maxLength);
}
module.exports = { templateText, outputText, LIMIT };
