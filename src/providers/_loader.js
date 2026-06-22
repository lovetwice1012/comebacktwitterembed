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
 *
 * `_` で始まるエントリと `index.js` (トップレベル) はスキップ。
 */

const fs = require('fs');
const path = require('path');

const PROVIDERS_DIR = __dirname;

/** @type {import('./_types').Provider[] | null} */
let _providers = null;

function loadProviders() {
    if (_providers) return _providers;
    const list = [];
    for (const entry of fs.readdirSync(PROVIDERS_DIR, { withFileTypes: true })) {
        if (entry.name.startsWith('_')) continue;
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

function _resetForTest() { _providers = null; }

function extractAllUrls(content) {
    const out = [];
    for (const p of loadProviders()) {
        const re = new RegExp(p.urlPattern.source, p.urlPattern.flags);
        const matches = content.match(re);
        if (!matches) continue;
        for (const url of matches) out.push({ provider: p, url });
    }
    return out;
}

function cleanContent(content) {
    let out = content;
    for (const p of loadProviders()) {
        const cleanRe = p.cleanPattern || buildDefaultCleanPattern(p.urlPattern);
        out = out.replace(cleanRe, '');
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
