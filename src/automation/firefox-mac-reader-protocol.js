'use strict';

// Private stdin framing for the experimental XPCShell reader. The caller
// owns the returned buffer and must clear it after the pipe is closed.
const fail = () => Object.assign(new Error('X_FIREFOX_MAC_READER_INPUT_INVALID'), { code: 'X_FIREFOX_MAC_READER_INPUT_INVALID' });
const fields = ['snapshotPath', 'resultPath', 'readerPath', 'readerSha256', 'uaid', 'browserVersion'];
function encodeMacFirefoxReaderInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)
        || !Object.hasOwn(descriptors[key], 'value') || typeof descriptors[key].value !== 'string')) throw fail();
    if (['snapshotPath', 'resultPath', 'readerPath'].some(name => !value[name].startsWith('/')
        || value[name].length > 4096 || /[\u0000-\u001f\u007f]/.test(value[name])) // eslint-disable-line no-control-regex
        || !/^[0-9a-f]{64}$/.test(value.readerSha256)
        || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.test(value.uaid)
        || !/^[0-9A-Za-z._+-]{1,64}$/.test(value.browserVersion)) throw fail();
    const source = Buffer.from(JSON.stringify(Object.fromEntries(fields.map(name => [name, value[name]]))), 'utf8');
    try {
        if (!source.length || source.length > 24576) throw fail();
        const encoded = source.toString('base64'), lines = encoded.match(/.{1,512}/g) || [];
        if (!lines.length || lines.length > 64) throw fail();
        return Buffer.from(`${lines.length}\n${lines.join('\n')}\n`, 'ascii');
    } finally { source.fill(0); }
}
module.exports = { encodeMacFirefoxReaderInput };
