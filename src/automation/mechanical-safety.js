'use strict';

// A deterministic check, not a legal/semantic certification service. No network
// calls, ML inference, external tokens or human review are required.
const { SafetyError, POLICY_VERSION } = require('./safety');
const { publicationText, screenText } = require('./moderation-text');
let defaultMatcher;
const SECRET = /https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/|\b(?:access_token|refresh_token|client_secret|webhook_token|bot_token|api_key|authorization)\s*["']?\s*[:=]\s*["']?\S+|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i;
const EXECUTABLE = /\.(?:exe|dll|com|scr|msi|msp|cpl|bat|cmd|ps1|psm1|vbs|vbe|wsf|wsh|js|jse|hta|html?|xhtml|svg|jar|lnk|sh|py|pyw|appx|apk)(?:[.\s]*)$/i;
const canonical = value => value.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
async function builtinMatch(text) {
    if (!defaultMatcher) defaultMatcher = new (require('./dictionary').DictionaryMatcher)(require('./moderation').starterDictionary());
    return screenText(text, part => defaultMatcher.match(part, 5), defaultMatcher.options);
}
function checkUrl(value) {
    value = canonical(value);
    if (/^attachment:\/\/[^/\\:\s\p{Cc}]+$/u.test(value)) return;
    let url;
    try { url = new URL(value); } catch { throw new SafetyError('SAFETY_INVALID_LINK'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SafetyError('SAFETY_UNSAFE_LINK');
    let decoded;
    try { decoded = decodeURIComponent(url.href); } catch { throw new SafetyError('SAFETY_INVALID_LINK'); }
    if (SECRET.test(canonical(decoded))) throw new SafetyError('SAFETY_CREDENTIAL_DISCLOSURE');
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host || host.endsWith('.') || host.includes('..')) throw new SafetyError('SAFETY_INVALID_LINK');
    if (/^(?:[\w-]+\.)?discord(?:app)?\.com$/i.test(host) && /^\/api(?:\/v\d+)?\/webhooks\/\d+\//i.test(canonical(decodeURIComponent(url.pathname)))) throw new SafetyError('SAFETY_CREDENTIAL_DISCLOSURE');
    const net = require('node:net');
    if (host === 'localhost' || !host.includes('.') && !net.isIP(host) || /\.(?:localhost|local|internal|home|lan)$/i.test(host) || net.isIP(host) && !require('./transport').publicAddress(host)) throw new SafetyError('SAFETY_PRIVATE_LINK');
}
function stringsOf(value, parts = [], state = { size: 0 }, depth = 0) {
    if (depth > 32) throw new SafetyError('SAFETY_INPUT_LIMIT');
    if (typeof value === 'string') {
        state.size += value.length;
        if (state.size > (state.limit || 2 * 1024 * 1024)) throw new SafetyError('SAFETY_INPUT_LIMIT');
        parts?.push(value);
        const visible = canonical(value);
        if (SECRET.test(visible)) throw new SafetyError('SAFETY_CREDENTIAL_DISCLOSURE');
        if (/(?:\]\(\s*<?|<)(?:javascript|data|file|vbscript):/i.test(visible)) throw new SafetyError('SAFETY_UNSAFE_LINK');
        for (const link of visible.matchAll(/https?:[/\\]+[^\s<>"'`)]+/gi)) {
            checkUrl(link[0].replace(/[.,;!]+$/, ''));
        }
    } else if (Array.isArray(value)) for (const child of value) stringsOf(child, parts, state, depth + 1);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        if (/(?:^|_)url$/i.test(key) && typeof child === 'string' && child) checkUrl(child);
        stringsOf(child, parts, state, depth + 1);
    }
    return parts;
}
function createMechanicalVerifier(options = {}) {
    const matcher = options.matcher === undefined ? { match: builtinMatch, matchNotification: async () => [] } : options.matcher;
    const clock = options.clock || Date.now;
    return {
        async inspect({ candidate, fingerprint, files }) {
            let text;
            if (candidate.purpose === 'publication') {
                try { require('./bundle').validateBundle(candidate.bundle); }
                catch (error) {
                    if (error.code === 'AUTOMATION_RULE_INVALID' || /^BUNDLE_|^DICTIONARY_/.test(error.message)) throw new SafetyError('SAFETY_INVALID_BUNDLE');
                    throw error;
                }
                // Dictionary terms and predicate operands are exempt from word
                // moderation, never from link/credential checks on exported data.
                stringsOf(candidate.bundle, null, { size: 0, limit: 128 * 1024 * 1024 });
                text = publicationText(candidate, candidate.bundle);
                stringsOf(text);
            } else if (candidate.purpose === 'notification') {
                if (candidate.event?.sensitive === true && candidate.channelNsfw !== true) throw new SafetyError('SAFETY_SENSITIVE_DESTINATION');
                text = stringsOf(candidate.payloads.map(p => p.body)).join('\n');
                for (const file of files || []) {
                    const data = file.data, name = canonical(String(file.name || file.key || ''));
                    if (/[/\\:\p{Cc}]/u.test(name)) throw new SafetyError('SAFETY_INVALID_ATTACHMENT');
                    const magic = data?.length >= 4 ? Buffer.from(data.buffer, data.byteOffset, 4).toString('hex') : '';
                    if (EXECUTABLE.test(name) || data?.length >= 2 && (data[0] === 0x4d && data[1] === 0x5a || data[0] === 0x23 && data[1] === 0x21)
                        || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic)) throw new SafetyError('SAFETY_EXECUTABLE_ATTACHMENT');
                    stringsOf(name); text += `\n${name}`;
                }
            } else throw new SafetyError('SAFETY_INVALID_PURPOSE');
            const check = candidate.purpose === 'notification' ? matcher?.matchNotification : matcher?.match;
            if (typeof check !== 'function') throw new SafetyError('SAFETY_CHECK_FAILED', 'error');
            const hits = await check.call(matcher, text, 5);
            if (!Array.isArray(hits)) throw new SafetyError('SAFETY_CHECK_FAILED', 'error');
            if (hits.length) throw new SafetyError('SAFETY_WORD_DENIED');
            return { fingerprint, policyVersion: POLICY_VERSION, detectorVersion: 'mechanical-v1', decision: 'allow', expiresAtMs: clock() + 30000 };
        },
    };
}
module.exports = { createMechanicalVerifier, builtinMatch, stringsOf, checkUrl };
