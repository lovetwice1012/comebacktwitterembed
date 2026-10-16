'use strict';
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { gunzip } = require('node:zlib');
const unzip = promisify(gunzip), MAX_DEPENDENCIES = 256;
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, digest = /^[0-9a-f]{64}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw Object.assign(new Error('辞書の配布元を確認できません。内容は保持されています。運営に確認を依頼してください。'), { name: 'AutomationError', code: 'PACKAGE_DEPENDENCIES_INVALID', status: 503 }); };
function references(value) {
    if (!Array.isArray(value) || value.length > MAX_DEPENDENCIES) fail();
    const result = new Map();
    for (const row of value) {
        if (!object(row) || Object.keys(row).some(key => !['packageId', 'version', 'checksum'].includes(key)) || !id.test(row.packageId || '') || !Number.isSafeInteger(row.version) || row.version < 1 || !digest.test(row.checksum || '')) fail();
        const ref = { packageId: row.packageId.toLowerCase(), version: row.version, checksum: row.checksum }, key = `${ref.packageId}:${ref.version}`;
        if (result.has(key) && result.get(key).checksum !== ref.checksum) fail(); result.set(key, ref);
    }
    return [...result.values()].sort((a, b) => a.packageId.localeCompare(b.packageId) || a.version - b.version);
}
function storedReferences(value) {
    if (value == null) return [];
    try {
        const record = typeof value === 'string' ? JSON.parse(value) : value;
        if (!object(record) || record.schemaVersion !== 1 || Object.keys(record).some(key => !['schemaVersion', 'sourceAlias', 'references', 'checksum'].includes(key)) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(record.sourceAlias || '') || ['constructor', 'prototype'].includes(record.sourceAlias)) fail();
        const refs = references(record.references);
        if (record.checksum !== hash({ sourceAlias: record.sourceAlias, references: refs })) fail();
        return refs;
    } catch { fail(); }
}
function validatePortable(value, dictionaries) {
    if (value === undefined) return;
    if (!object(value) || Object.keys(value).some(key => key !== 'dictionaries') || !object(value.dictionaries) || Object.keys(value.dictionaries).length > 16) fail();
    for (const [alias, entries] of Object.entries(value.dictionaries)) {
        if (!Object.hasOwn(dictionaries, alias) || !Array.isArray(entries) || entries.length > MAX_DEPENDENCIES) fail();
        for (const entry of entries) if (!object(entry) || Object.keys(entry).some(key => !['packageId', 'version', 'checksum', 'license', 'description'].includes(key)) || typeof entry.license !== 'string' || entry.license.length > 8000 || typeof entry.description !== 'string' || entry.description.length > 8000) fail();
        references(entries.map(({ packageId, version, checksum }) => ({ packageId, version, checksum })));
    }
}
const portableReferences = entries => references((entries || []).map(({ packageId, version, checksum }) => ({ packageId, version, checksum })));
async function edition(query, ref) {
    const row = (await query('SELECT v.*,p.owner_user_id FROM automation_package_versions v JOIN automation_packages p ON p.id=v.package_id WHERE v.package_id=? AND v.version=?', [ref.packageId, ref.version]))[0];
    if (!row || row.checksum !== ref.checksum) fail();
    let bundle;
    try {
        const bytes = await unzip(row.bundle_gzip, { maxOutputLength: require('./bundle').MAX_EXPANDED });
        if (createHash('sha256').update(bytes).digest('hex') !== row.checksum) fail();
        bundle = require('./bundle').validateBundle(JSON.parse(bytes.toString('utf8')));
    } catch { fail(); }
    return { row, bundle };
}
async function describe(query, value) {
    const result = [];
    for (const ref of references(value)) {
        const { row, bundle } = await edition(query, ref);
        const texts = [...new Set([bundle.description || '', row.description || '', `Source: ${row.title} (${ref.packageId}) v${ref.version}; author ${row.owner_user_id}`].filter(Boolean))];
        const description = texts.join('\n\n'); if (description.length > 8000) fail();
        result.push({ ...ref, license: bundle.license || '', description });
    }
    return result;
}
async function nearestReference(query, packageId, version) {
    if (!packageId || !Number.isSafeInteger(Number(version)) || Number(version) < 1) fail();
    const row = (await query('SELECT checksum FROM automation_package_versions WHERE package_id=? AND version=?', [packageId, version]))[0];
    if (!row) fail(); return references([{ packageId, version: Number(version), checksum: row.checksum }])[0];
}
async function dictionaryReferences(query, row) {
    const result = storedReferences(row.package_dependencies_json);
    if (row.source_package_id) result.push(await nearestReference(query, row.source_package_id, row.source_package_version));
    return references(result);
}
function packageRecord(value, dictionaries) {
    if (value == null) return { dictionaries: {} };
    try {
        const row = typeof value === 'string' ? JSON.parse(value) : value;
        if (!object(row) || row.schemaVersion !== 1 || Object.keys(row).some(key => !['schemaVersion', 'dictionaries', 'checksum'].includes(key))) fail();
        validatePortable({ dictionaries: row.dictionaries }, dictionaries);
        if (row.checksum !== hash(row.dictionaries)) fail();
        return { dictionaries: row.dictionaries };
    } catch { fail(); }
}
function serializePackage(value, dictionaries) {
    validatePortable(value, dictionaries);
    if (!Object.keys(value.dictionaries).length) return null;
    const json = JSON.stringify({ schemaVersion: 1, dictionaries: value.dictionaries, checksum: hash(value.dictionaries) });
    if (Buffer.byteLength(json) > 16000000) fail();
    packageRecord(json, dictionaries); return json;
}
async function packageDetails(query, value, dictionaries) {
    const stored = packageRecord(value, dictionaries);
    for (const entries of Object.values(stored.dictionaries)) {
        // Human metadata is the immutable server snapshot included in the
        // original publication checks. Never reveal newly changed source text.
        if (JSON.stringify(await describe(query, portableReferences(entries))) !== JSON.stringify(entries)) fail();
    }
    return stored;
}
function notice(value, exclude = null) {
    const rows = new Map();
    for (const entries of Object.values(value.dictionaries)) for (const entry of entries) {
        if (exclude && entry.packageId === exclude.packageId && entry.version === exclude.version) continue;
        rows.set(`${entry.packageId}:${entry.version}`, entry);
    }
    return [...rows.values()].map(row => `Dictionary source: ${row.packageId} v${row.version}\nLicense: ${row.license}\n${row.description}`).join('\n\n');
}
async function stamp(query, ref, origin, entries = [], sourceAlias) {
    const canonical = await describe(query, portableReferences(entries));
    if (JSON.stringify(canonical) !== JSON.stringify(entries)) fail();
    const refs = references([...portableReferences(entries), await nearestReference(query, origin.id, origin.version)]);
    // This receipt comes only from verified immutable package metadata.
    // Editable portable text never authorizes a runtime dependency.
    await describe(query, refs);
    const json = JSON.stringify({ schemaVersion: 1, sourceAlias, references: refs, checksum: hash({ sourceAlias, references: refs }) });
    if (Buffer.byteLength(json) > 64000) fail(); storedReferences(json);
    await query('UPDATE automation_dictionary_revisions SET package_dependencies_json=? WHERE dictionary_id=? AND revision=?', [json, ref.id, ref.revision]);
}
module.exports = { references, storedReferences, portableReferences, edition, describe, nearestReference, dictionaryReferences, stamp, packageRecord, packageDetails, serializePackage, notice, MAX_DEPENDENCIES };
