'use strict';

const words = require('naughty-words');
const version = require('naughty-words/package.json').version;
const { normalize, validateDictionary } = require('./dictionary');
const { AutomationError, requireActor } = require('./service');
const { screenText } = require('./moderation-text');
const source = `Shutterstock, Inc. and contributors; LDNOOBW / naughty-words ${version}; https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words . Changes: NFKC/case folding deduplication, language categories and word/substring matching metadata.`;
function starterDictionary(language = 'all') {
    if (language !== 'all' && !Object.hasOwn(words, language)) throw new AutomationError('STARTER_LANGUAGE', '未対応の言語です。');
    const entries = new Map();
    for (const [locale, list] of Object.entries(words)) if (language === 'all' || locale === language) for (const raw of list) {
        const term = String(raw).trim(), key = normalize(term);
        if (!term || !key || term.length > 255) continue;
        if (!entries.has(key)) entries.set(key, { term, kind: 'deny', mode: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(term) ? 'contains' : 'word', category: locale, severity: 3 });
    }
    return { schemaVersion: 1, name: `LDNOOBW スターター (${language})`, mode: 'word', normalization: { form: 'NFKC', caseFold: true, spaces: 'collapse' }, source, license: 'CC-BY-4.0 — https://creativecommons.org/licenses/by/4.0/', entries: [...entries.values()] };
}
function starterInfo() {
    return { version, source, license: 'CC-BY-4.0', uniqueEntries: starterDictionary().entries.length,
        languages: Object.entries(words).map(([id, list]) => ({ id, entryCount: list.length })),
        caveat: '機械的な語句照合です。文脈や権利・適法性は判定できません。内容と公開先は利用者が確認してください。' };
}
function createModeration(db, service, evaluator) {
    let metadataKey, metadata;
    async function row() {
        const rows = await db.queryDatabase('SELECT * FROM automation_moderation_policy WHERE id=1');
        return rows[0] || { revision: 0, use_starter: 1, dictionary_id: null, dictionary_revision: null };
    }
    async function matchText(text, limit, publication) {
        limit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(1000, limit)) : 5;
        const policy = await row();
        if (![0, 1, false, true].includes(policy.use_starter) || policy.dictionary_id && (!Number.isSafeInteger(Number(policy.dictionary_revision)) || Number(policy.dictionary_revision) < 1)) throw new Error('MODERATION_INVALID_POLICY');
        if (!publication && !policy.dictionary_id) return [];
        if (publication && policy.use_starter) {
            // Keep the starter gate separate: an operator allow-span or custom
            // normalization must not overwrite a starter prohibition.
            const hits = await screenText(text, part => evaluator.matchModeration({ useStarter: true, id: null, revision: 0 }, part), { form: 'NFKC', caseFold: true, spaces: 'collapse' });
            if (hits.length) return hits.slice(0, Math.max(1, limit));
        }
        if (policy.dictionary_id) {
            const key = `${policy.dictionary_id}:${policy.dictionary_revision}`;
            if (metadataKey !== key) {
                // Only normalization metadata is retained; the large compiled
                // matcher remains in the evaluator worker. Normalize the whole
                // view before chunking so whitespace removal cannot hide joins.
                const dictionary = await service.dictionaryData(policy.dictionary_id, Number(policy.dictionary_revision));
                validateDictionary({ ...dictionary, entries: [] });
                metadata = { ...dictionary.normalization }; metadataKey = key;
            }
            const normalization = metadata;
            const hits = await screenText(text, part => evaluator.matchModeration({ useStarter: false, id: policy.dictionary_id, revision: Number(policy.dictionary_revision) }, part), normalization);
            if (hits.length) return hits.slice(0, Math.max(1, limit));
        }
        if (publication && !policy.use_starter && !policy.dictionary_id) throw new Error('MODERATION_INVALID_POLICY');
        return [];
    }
    const match = (text, limit = 5) => matchText(text, limit, true);
    const matchNotification = (text, limit = 5) => matchText(text, limit, false);
    async function get(actor) {
        requireActor(actor);
        if (!actor.isAdmin) throw new AutomationError('FORBIDDEN', '公開審査の権限が必要です。', 403);
        const policy = await row();
        return { revision: Number(policy.revision), useStarter: !!policy.use_starter, dictionaryId: policy.dictionary_id, dictionaryRevision: policy.dictionary_revision == null ? null : Number(policy.dictionary_revision), starter: starterInfo() };
    }
    async function save(actor, input) {
        requireActor(actor);
        if (!actor.isAdmin) throw new AutomationError('FORBIDDEN', '公開審査の権限が必要です。', 403);
        if (input.dictionaryId) {
            await service.getRow('dictionary', actor, input.dictionaryId);
            await service.dictionaryData(input.dictionaryId, Number(input.dictionaryRevision));
        }
        if (!input.useStarter && !input.dictionaryId) throw new AutomationError('MODERATION_REQUIRED', '公開用辞書を最低1つ選んでください。');
        await evaluator.matchModeration({ id: input.dictionaryId, revision: Number(input.dictionaryRevision), useStarter: !!input.useStarter }, '');
        return db.withDatabaseTransaction(async query => {
            await query('INSERT IGNORE INTO automation_moderation_policy (id,use_starter,revision,updated_at_ms,actor_user_id) VALUES (1,1,0,?,?)', [Date.now(), actor.userId]);
            const current = (await query('SELECT * FROM automation_moderation_policy WHERE id=1 FOR UPDATE'))[0];
            if (Number(current.revision) !== input.expectedRevision) throw new AutomationError('REVISION_CONFLICT', '審査設定が変更されています。', 409);
            await query('UPDATE automation_moderation_policy SET dictionary_id=?,dictionary_revision=?,use_starter=?,revision=revision+1,updated_at_ms=?,actor_user_id=? WHERE id=1', [input.dictionaryId || null, input.dictionaryId ? Number(input.dictionaryRevision) : null, input.useStarter ? 1 : 0, Date.now(), actor.userId]);
            await service.audit(query, actor, 'moderation', 'moderation.update', { dictionaryId: input.dictionaryId || null, dictionaryRevision: input.dictionaryRevision || null, useStarter: !!input.useStarter }, null);
            return { revision: Number(current.revision) + 1 };
        });
    }
    return { match, matchNotification, get, save };
}
module.exports = { starterDictionary, starterInfo, createModeration };
