'use strict';

/**
 * プロバイダレジストリ。
 *
 * 新しい展開対象サイトを追加するには次のいずれかの方法でファイルを置く:
 *   - 単一ファイル: `src/providers/<id>.js`
 *   - ディレクトリ: `src/providers/<id>/index.js` (専用 commands/ などを併設できる)
 *
 * いずれも `module.exports` に以下を含める:
 *   - id: string
 *   - urlPattern: RegExp (g フラグ必須)
 *   - extract: (message, url, settings, opts?) => SendStep[] | null
 *   - commands?: Array<{ definition, execute }>   // 任意。プロバイダ専用 slash コマンド
 *   - autoWatch.js (任意): 公開アカウントの新着監視アダプター。存在する場合は
 *     `src/providers/autoWatch/` の共通ランナーが自動的に検出する。
 *
 * `_` で始まるエントリ、`index.js` (トップレベル)、共通基盤の
 * `autoWatch/` と `priceWatch/` は通常の URL 展開プロバイダーとしてはスキップ。
 */

const fs = require('fs');
const path = require('path');
const { urlIdentity } = require('./_url_identity');

const PROVIDERS_DIR = __dirname;

/** @type {import('./_types').Provider[] | null} */
let _providers = null;
let _patterns = null;

function loadProviders() {
    if (_providers) return _providers;
    const list = [];
    for (const entry of fs.readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
        if (entry.name.startsWith('_') || entry.name === 'autoWatch' || entry.name === 'priceWatch') continue;
        let modPath = null;
        if (entry.isFile()) {
            if (!entry.name.endsWith('.js')) continue;
            if (entry.name === 'index.js') continue;
            modPath = path.join(PROVIDERS_DIR, entry.name);
        } else if (entry.isDirectory()) {
            const idx = path.join(PROVIDERS_DIR, entry.name, 'index.js');
            if (!fs.existsSync(idx)) continue;
            modPath = idx;
        } else {
            continue;
        }
        /** @type {import('./_types').Provider} */
        const provider = require(modPath);
        if (!provider || typeof provider !== 'object') {
            throw new Error(`Provider ${entry.name} does not export an object`);
        }
        if (typeof provider.id !== 'string' || !provider.id) {
            throw new Error(`Provider ${entry.name} is missing string property "id"`);
        }
        if (!(provider.urlPattern instanceof RegExp) || !provider.urlPattern.global) {
            throw new Error(`Provider ${provider.id} requires a global RegExp "urlPattern"`);
        }
        if (typeof provider.extract !== 'function') {
            throw new Error(`Provider ${provider.id} requires an "extract(message, url, settings, opts?)" function`);
        }
        list.push(provider);
    }
    _providers = list;
    return list;
}

function _resetForTest() { _providers = null; _patterns = null; }

function patterns() {
    if (!_patterns) {
        _patterns = loadProviders().map(provider => ({
            provider,
            url: new RegExp(provider.urlPattern.source, provider.urlPattern.flags),
            clean: provider.cleanPattern || buildDefaultCleanPattern(provider.urlPattern),
        }));
    }
    return _patterns;
}

// URL schemes and authorities are case-insensitive, but paths and identifiers
// may not be. Map the normalized shadow back to the exact original text.
function normalizeUrlAuthorities(text) {
    const matches = [...text.matchAll(/https?:\/\/[^\s<>"'|/?#]+/gi)];
    if (!matches.some(match => /[A-Z]/.test(match[0]) || /:(?:0*443|0*80)$/.test(match[0]))) {
        return { shadow: text, positions: null };
    }
    let shadow = '', previous = 0;
    const positions = [];
    const append = (start, end, lower = false) => {
        for (let index = start; index < end; index++) {
            const code = text.charCodeAt(index);
            shadow += lower && code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[index];
            positions.push(index);
        }
    };
    for (const match of matches) {
        const start = match.index, end = start + match[0].length;
        append(previous, start);
        const authority = match[0], schemeEnd = authority.indexOf('://') + 3;
        const host = authority.slice(schemeEnd), scheme = authority.slice(0, schemeEnd).toLowerCase();
        const port = !host.includes('@') && /:(\d+)$/.exec(host);
        const defaultPort = port && (scheme === 'https://' && Number(port[1]) === 443
            || scheme === 'http://' && Number(port[1]) === 80) ? port[0].length : 0;
        append(start, end - defaultPort, true);
        previous = end;
    }
    append(previous, text.length);
    positions.push(text.length);
    return { shadow, positions };
}

function extractAllUrls(content) {
    const original = String(content ?? ''), { shadow, positions } = normalizeUrlAuthorities(original);
    const out = [];
    for (const { provider: p, url: re } of patterns()) {
        re.lastIndex = 0;
        for (const match of shadow.matchAll(re)) {
            if (match[0]) {
                const start = positions ? positions[match.index] : match.index;
                const end = positions ? positions[match.index + match[0].length] : match.index + match[0].length;
                out.push({ provider: p, url: original.slice(start, end), index: start });
            }
        }
    }
    out.sort((a, b) => a.index - b.index);
    const seen = new Set();
    return out.filter(({ provider, url }) => {
        const key = urlIdentity(provider.id, url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(({ provider, url }) => ({ provider, url }));
}

function cleanContent(content) {
    let out = String(content ?? '');
    let normalized = normalizeUrlAuthorities(out);
    for (const { clean: cleanRe } of patterns()) {
        cleanRe.lastIndex = 0;
        const ranges = [];
        const { shadow, positions } = normalized;
        shadow.replace(cleanRe, (...args) => {
            const offset = typeof args.at(-1) === 'object' ? args.at(-3) : args.at(-2);
            ranges.push(positions ? [positions[offset], positions[offset + args[0].length]] : [offset, offset + args[0].length]);
            return args[0];
        });
        for (const [start, end] of ranges.reverse()) out = out.slice(0, start) + out.slice(end);
        if (ranges.length) normalized = normalizeUrlAuthorities(out);
    }
    return out;
}

function buildDefaultCleanPattern(urlPattern) {
    const body = urlPattern.source;
    const flags = urlPattern.flags.includes('g') ? urlPattern.flags : urlPattern.flags + 'g';
    return new RegExp(`<${body}>|\\|\\|${body}\\|\\|`, flags);
}

/**
 * 全プロバイダが宣言する slash コマンドを集約して返す。
 * 各エントリは { definition, execute } の形を期待する (= core 側と同じ形)。
 */
function loadProviderCommands() {
    const out = [];
    for (const p of loadProviders()) {
        const cmds = /** @type {any} */ (p).commands;
        if (!Array.isArray(cmds)) continue;
        for (const c of cmds) {
            if (!c || !c.definition || typeof c.execute !== 'function') {
                throw new Error(`Provider ${p.id} declared an invalid command (need { definition, execute })`);
            }
            out.push(c);
        }
    }
    return out;
}

module.exports = {
    loadProviders,
    loadProviderCommands,
    extractAllUrls,
    cleanContent,
    _resetForTest,
};
