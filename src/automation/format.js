'use strict';

const YAML = require('yaml');
const { assertWorkflow, LIMITS, RuleError } = require('./schema');

function parseWorkflow(text, format = 'yaml') {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMITS.bytes) throw new RuleError([{ path: '$', message: '入力サイズの上限を超えました。' }]);
    let value;
    try {
        if (format === 'json') value = JSON.parse(text);
        else {
            const doc = YAML.parseDocument(text, { version: '1.2', uniqueKeys: true, stringKeys: true, prettyErrors: false });
            if (doc.errors.length || doc.warnings.length) throw new Error(doc.errors[0]?.message || doc.warnings[0]?.message);
            value = doc.toJS({ maxAliasCount: 0 });
        }
    } catch (error) {
        // Parser excerpts can contain credentials accidentally pasted by a user;
        // never carry raw input into error telemetry or persistent logs.
        throw new RuleError([{ path: '$', message: 'JSON/YAMLの構文を確認してください。', line: error.linePos?.[0]?.line || null }]);
    }
    return assertWorkflow(value);
}
function stringifyWorkflow(value, format = 'yaml') {
    assertWorkflow(value);
    return format === 'json' ? JSON.stringify(value, null, 2) : YAML.stringify(value, { aliasDuplicateObjects: false, lineWidth: 0 });
}
function stringifyDraft(value, format = 'yaml') {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.bytes) throw new RuleError([{ path: '$', message: '入力サイズの上限を超えました。' }]);
    return format === 'json' ? JSON.stringify(value, null, 2) : YAML.stringify(value, { aliasDuplicateObjects: false, lineWidth: 0 });
}
function semanticWorkflow(value) {
    assertWorkflow(value);
    const { layout: _layout, ...rule } = structuredClone(value);
    rule.nodes = rule.nodes.map(({ position: _position, group: _group, ...node }) => node).sort((a, b) => a.id.localeCompare(b.id));
    rule.edges = rule.edges.slice().sort((a, b) => a.id.localeCompare(b.id));
    return rule;
}
module.exports = { parseWorkflow, stringifyWorkflow, stringifyDraft, semanticWorkflow };
