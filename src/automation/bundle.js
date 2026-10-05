'use strict';

const { zipSync, Unzip, UnzipInflate, strToU8, strFromU8 } = require('fflate');
const { createHash } = require('node:crypto');
const { assertWorkflow } = require('./schema');
const { validateDictionary } = require('./dictionary');
const MAX_COMPRESSED = 32 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const checksum = data => createHash('sha256').update(data).digest('hex');

function validateBundle(bundle) {
    if (!bundle || bundle.schemaVersion !== 1 || !['workflow', 'dictionary', 'collection'].includes(bundle.kind)) throw new Error('BUNDLE_INVALID');
    if (Object.keys(bundle).some(key => !['schemaVersion', 'kind', 'workflow', 'dictionaries', 'description', 'license'].includes(key))) throw new Error('BUNDLE_UNKNOWN_FIELD');
    for (const key of ['description', 'license']) if (bundle[key] !== undefined && (typeof bundle[key] !== 'string' || bundle[key].length > 8000)) throw new Error('BUNDLE_TEXT_INVALID');
    if (bundle.kind !== 'dictionary') assertWorkflow(bundle.workflow);
    if (!bundle.dictionaries || typeof bundle.dictionaries !== 'object' || Array.isArray(bundle.dictionaries) || Object.keys(bundle.dictionaries).length > 16) throw new Error('BUNDLE_DICTIONARIES_INVALID');
    for (const [alias, dictionary] of Object.entries(bundle.dictionaries)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(alias) || ['constructor', 'prototype'].includes(alias)) throw new Error('BUNDLE_ALIAS_INVALID');
        validateDictionary(dictionary);
    }
    for (const node of bundle.workflow?.nodes || []) if (node.type === 'dictionary' && !bundle.dictionaries[node.config.dictionary]) throw new Error('BUNDLE_MISSING_DICTIONARY');
    // The package contains logical aliases only. Never export live endpoint
    // bindings or allow pasted signed webhook URLs in human-readable fields.
    const body = JSON.stringify(bundle);
    if (Buffer.byteLength(body) > MAX_EXPANDED) throw new Error('BUNDLE_SIZE_LIMIT');
    if (/https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\//i.test(body)
        || /"(?:access_token|client_secret|webhookUrl|webhook_url|bindings|dm_user_id)"\s*:/i.test(body)) throw new Error('BUNDLE_CONTAINS_CREDENTIALS');
    return bundle;
}
function encodeBundle(bundle) {
    validateBundle(bundle);
    const data = strToU8(JSON.stringify(bundle));
    const manifest = strToU8(JSON.stringify({ format: 'cbte-automation', version: 1, sha256: checksum(data) }));
    return zipSync({ 'manifest.json': manifest, 'bundle.json': data }, { level: 6 });
}
function decodeBundle(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_COMPRESSED) throw new Error('BUNDLE_SIZE_LIMIT');
    const files = new Map();
    let size = 0, failure = null, finished = 0;
    const unzip = new Unzip(file => {
        if (!['manifest.json', 'bundle.json'].includes(file.name) || files.has(file.name)) { failure = new Error('BUNDLE_UNEXPECTED_FILE'); return; }
        const chunks = []; files.set(file.name, chunks);
        file.ondata = (error, data, final) => {
            if (failure) return;
            if (error) { failure = error; return; }
            size += data.length;
            if (size > MAX_EXPANDED || file.name === 'manifest.json' && size > MAX_EXPANDED) { failure = new Error('BUNDLE_SIZE_LIMIT'); file.terminate(); return; }
            chunks.push(data);
            if (final) finished++;
        };
        if (file.originalSize > MAX_EXPANDED) { failure = new Error('BUNDLE_SIZE_LIMIT'); return; }
        file.start();
    });
    unzip.register(UnzipInflate);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
        if (failure) throw failure;
        unzip.push(bytes.subarray(offset, offset + 65536), offset + 65536 >= bytes.length);
    }
    if (failure) throw failure;
    if (files.size !== 2 || finished !== 2) throw new Error('BUNDLE_INCOMPLETE');
    const flatten = name => Buffer.concat(files.get(name).map(v => Buffer.from(v)));
    const manifestBytes = flatten('manifest.json');
    if (manifestBytes.length > 4096) throw new Error('BUNDLE_MANIFEST_INVALID');
    const manifest = JSON.parse(strFromU8(manifestBytes)), data = flatten('bundle.json');
    if (manifest.format !== 'cbte-automation' || manifest.version !== 1 || checksum(data) !== manifest.sha256) throw new Error('BUNDLE_CHECKSUM');
    return validateBundle(JSON.parse(strFromU8(data)));
}
module.exports = { validateBundle, encodeBundle, decodeBundle, checksum, MAX_COMPRESSED, MAX_EXPANDED };
