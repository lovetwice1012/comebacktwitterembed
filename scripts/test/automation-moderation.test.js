'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { moderationViews, publicationText, chunks, screenText } = require('../../src/automation/moderation-text');
const { createModeration } = require('../../src/automation/moderation');
const { createMarketplace } = require('../../src/automation/marketplace');
const { newWorkflow, NODE_TYPES } = require('../../src/automation/schema');
const { DictionaryMatcher } = require('../../src/automation/dictionary');
const marker = 'AUDIT_SENTINEL';
const matcher = new DictionaryMatcher({ schemaVersion: 1, name: 'Benign marker', entries: [marker] });
function moderation() { return createModeration({ queryDatabase: async () => [] }, {}, { matchModeration: async (_policy, text) => matcher.match(text) }); }
function fixture() {
    const workflow = newWorkflow('中立名');
    workflow.nodes.splice(1, 0, { id: 'format', type: 'transform', config: { ...structuredClone(NODE_TYPES.transform.defaults), format: 'text', template: 'neutral' } });
    workflow.edges = [{ id: 'a', source: 'start', target: 'format', port: 'out' }, { id: 'b', source: 'format', target: 'send', port: 'out' }];
    return { title: '中立的な名称', visibility: 'public', rightsConfirmed: true, bundle: { schemaVersion: 1, kind: 'workflow', workflow, dictionaries: {}, license: 'CC0-1.0' } };
}
test('screening detects benign Unicode evasion markers without rewriting originals or user dictionary rules', async () => {
    const service = moderation();
    for (const text of [marker, 'ＡＵＤＩＴ＿ＳＥＮＴＩＮＥＬ', 'AUDIT_\u200bSENTINEL', 'AUDIT_\u2066SENTINEL\u2069', '\u0410UDIT_SENTINEL']) assert((await service.match(text)).length, text);
    assert.equal(moderationViews('Привет')[0], 'привет');
    assert.equal(matcher.match('AUDIT_\u200bSENTINEL').length, 0, 'user dictionaries retain their own semantics');
});
test('publication checks replacements, concatenation, group labels, categories and dictionary metadata before DB writes', async () => {
    const query = async () => { assert.fail('Rejected publication must not write'); };
    const market = createMarketplace({ queryDatabase: query, withDatabaseTransaction: work => work(query) }, { moderationMatcher: moderation() });
    const cases = [
        data => { data.bundle.workflow.nodes[1].config.replacements = [{ from: 'neutral', to: marker }]; },
        data => { Object.assign(data.bundle.workflow.nodes[1].config, { template: 'AUDIT_', suffix: 'SENTINEL' }); },
        data => { data.bundle.workflow.layout = { groups: [{ id: 'sample', label: marker }] }; },
        data => { data.category = marker; },
        data => { data.bundle.dictionaries.words = { schemaVersion: 1, name: marker, source: 'fixture', license: 'CC0-1.0', entries: [] }; },
    ];
    for (const alter of cases) { const data = fixture(); alter(data); await assert.rejects(market.save({ userId: '123' }, data), { code: 'PUBLICATION_REJECTED' }); }
    const unavailable = createMarketplace({ queryDatabase: query, withDatabaseTransaction: work => work(query) }, { safety: require('../../src/automation/safety').createSafety({ verifier: null }) });
    await assert.rejects(unavailable.save({ userId: '123' }, fixture()), { code: 'PUBLICATION_CHECK_FAILED' });
});
test('filter terms are not publication copy, and long text is screened through the end and across chunk boundaries', async () => {
    const data = fixture(); data.bundle.dictionaries.words = { schemaVersion: 1, name: 'filter', source: 'fixture', license: 'CC0-1.0', entries: [marker] };
    assert(!publicationText(data, data.bundle).includes(marker));
    const service = moderation();
    assert((await service.match('x'.repeat(65530) + marker + 'x'.repeat(65530))).length);
    assert((await service.match('x'.repeat(140000) + marker)).length);
    assert([...chunks('a'.repeat(140000))].every(chunk => chunk.length <= 65536));
    await assert.rejects(service.match('x'.repeat(2 * 1024 * 1024 + 1)), /LIMIT/);
});

test('chunk boundaries do not invent words, anchors or truncated allow-span denials', async () => {
    for (const mode of ['word', 'prefix', 'suffix', 'exact']) {
        const dictionary = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', mode, entries: [marker] });
        for (const offset of [47174, 65536 - marker.length, 65536]) {
            const text = 'x'.repeat(offset) + marker + 'x'.repeat(70000);
            assert.deepEqual(await screenText(text, part => dictionary.match(part, 5)), [], `${mode} at ${offset}`);
        }
    }
    const exceptions = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', entries: [marker, { term: `safe ${marker} ending`, kind: 'allow' }] });
    assert.deepEqual(await screenText('x'.repeat(65520) + `safe ${marker} ending` + 'x'.repeat(70000), part => exceptions.match(part, 5)), []);
    const words = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', mode: 'word', entries: [marker] });
    for (const offset of [0, 47174, 65530, 140000]) assert((await screenText('x'.repeat(offset) + ` ${marker} `, part => words.match(part, 5))).length, `word at ${offset}`);
    for (const [mode, text] of [['prefix', marker + 'x'.repeat(140000)], ['suffix', 'x'.repeat(140000) + marker], ['exact', marker]]) {
        const dictionary = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', mode, entries: [marker] });
        assert((await screenText(text, part => dictionary.match(part, 5))).length, mode);
    }
});

test('normalization happens before chunking and does not transliterate ordinary Cyrillic words', async () => {
    const dictionary = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', normalization: { spaces: 'remove' }, entries: [marker] });
    assert((await screenText('AUDIT_' + ' '.repeat(70000) + 'SENTINEL', part => dictionary.match(part, 5), dictionary.options)).length);
    const expanded = '\ufdfa'.repeat(255);
    const expandedMatcher = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', entries: [expanded] });
    assert((await screenText('x'.repeat(63500) + expanded + 'x'.repeat(70000), part => expandedMatcher.match(part, 5))).length);
    const latin = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', entries: ['coc'] });
    assert.deepEqual(await screenText('сос', part => latin.match(part, 5)), []);
    assert(moderationViews('audit_\u0441entinel').includes('audit_centinel'));
    assert.throws(() => moderationViews('\ufdfa'.repeat(120000)), /MODERATION_TEXT_LIMIT/);
    assert([...chunks('a'.repeat(65535) + '😀' + 'a'.repeat(70000))].every(part => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part)));
});

test('invalid or saturated boundary results fail instead of silently dropping unseen matches', async () => {
    for (const result of [null, false, {}, [{ term: marker, start: 0, end: 1000 }]]) {
        await assert.rejects(screenText('fixture', async () => result), /MODERATION_INVALID_RESULT/);
    }
    const dictionary = new DictionaryMatcher({ schemaVersion: 1, name: 'fixture', mode: 'prefix', entries: Array.from({ length: 6 }, (_, i) => 'anchor' + 'x'.repeat(i)) });
    await assert.rejects(screenText('n'.repeat(47174) + 'anchorxxxxx' + 'n'.repeat(70000), part => dictionary.match(part, 5)), /MODERATION_MATCH_LIMIT/);
});

test('bounded publication preview rejects explosive replacements and includes replacement metadata', async () => {
    const data = fixture(), config = data.bundle.workflow.nodes[1].config;
    config.template = 'a'; config.replacements = Array.from({ length: 32 }, () => ({ from: 'a', to: 'a'.repeat(128) }));
    assert.throws(() => publicationText(data, data.bundle), /MODERATION_TEXT_LIMIT/);
    await assert.rejects(require('../../src/automation/safety').createSafety().assertPublication(data), { code: 'SAFETY_CHECK_FAILED', decision: 'error' });
    const safe = fixture();
    safe.bundle.workflow.nodes[1].config.replacements = [{ from: 'neutral', to: 'test' }, { from: 'test', to: marker }];
    assert(publicationText(safe, safe.bundle).includes(marker));
});

test('real worker keeps publication starter separate from operator exceptions and ordinary user filters', async t => {
    const { createEvaluator } = require('../../src/automation/evaluation');
    const { createSafety } = require('../../src/automation/safety');
    const dictionaries = {
        1: { schemaVersion: 1, name: 'Operator fixture', mode: 'word', entries: [marker, { term: 'xxx', kind: 'allow' }] },
        2: { schemaVersion: 1, name: 'Operator fixture', normalization: { spaces: 'remove', caseFold: false }, entries: [marker] },
    };
    let policy = { revision: 0, use_starter: 1, dictionary_id: null, dictionary_revision: null };
    const load = async (_id, revision) => dictionaries[revision];
    const evaluator = createEvaluator(load); t.after(() => evaluator.stop());
    const moderation = createModeration({ queryDatabase: async () => [{ ...policy }] }, { dictionaryData: load }, evaluator);
    const safety = createSafety({ matcher: moderation });
    const record = { plan: { event: {} } };
    const prepared = content => ({ payloads: [{ body: { content } }] });
    await safety.assertNotification(prepared('xxx'), record);
    await safety.assertPublication(fixture());
    await assert.rejects(safety.assertPublication({ ...fixture(), title: 'xxx' }), { code: 'SAFETY_WORD_DENIED' });
    policy = { revision: 1, use_starter: 1, dictionary_id: 'operator', dictionary_revision: 1 };
    await safety.assertNotification(prepared('xxx'), record);
    await assert.rejects(safety.assertPublication({ ...fixture(), title: 'xxx' }), { code: 'SAFETY_WORD_DENIED' });
    await assert.rejects(safety.assertPublication({ ...fixture(), title: marker }), { code: 'SAFETY_WORD_DENIED' });
    await assert.rejects(safety.assertNotification(prepared('AUDIT_\u200bSENTINEL'), record), { code: 'SAFETY_WORD_DENIED' });
    await assert.rejects(safety.assertNotification({ payloads: [{ body: { content: 'fixture' }, files: [{ name: marker + '.txt', data: Buffer.from('fixture') }] }] }, record), { code: 'SAFETY_WORD_DENIED' });
    const userDictionary = new DictionaryMatcher({ schemaVersion: 1, name: 'User fixture', entries: ['SENTINEL', { term: marker, kind: 'allow' }] });
    const workflow = newWorkflow('fixture');
    workflow.nodes.splice(1, 0, { id: 'filter', type: 'dictionary', config: { dictionary: 'user', fields: ['title'] } });
    workflow.edges = [{ id: 'a', source: 'start', target: 'filter', port: 'out' }, { id: 'b', source: 'filter', target: 'send', port: 'no' }];
    const evaluated = require('../../src/automation/engine').evaluateWorkflow(workflow, { title: marker }, { dictionaries: { user: userDictionary } });
    assert.equal(evaluated.outputs.length, 1, 'the user exception allows their workflow to produce a message');
    await assert.rejects(safety.assertNotification(prepared(evaluated.outputs[0].text), { plan: { event: evaluated.event } }), { code: 'SAFETY_WORD_DENIED' });
    policy = { ...policy, revision: 2, dictionary_revision: 2 };
    assert((await moderation.matchNotification('AUDIT_' + ' '.repeat(70000) + 'SENTINEL')).length);
    assert.deepEqual(await moderation.matchNotification('audit_sentinel'), [], 'operator case setting is retained');
    assert((await moderation.matchNotification(marker, NaN)).length, 'invalid result limit cannot erase a prohibition');
});
