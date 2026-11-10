'use strict';

// macOS Chromium OSCrypt v10, limited to the GCM device security token.
// The caller must supply a password for an explicitly owned setup profile;
// this module does not access Keychain, files, browsers or the network.
const { pbkdf2Sync, createDecipheriv } = require('node:crypto');
const fail = () => Object.assign(new Error('X_CHROME_MAC_TOKEN_INVALID'), { code: 'X_CHROME_MAC_TOKEN_INVALID' });
const MAX_U64 = (1n << 64n) - 1n;

function decryptMacChromiumDeviceToken(encrypted, password) {
    if (!Buffer.isBuffer(encrypted) || ![19, 35].includes(encrypted.length)
        || !encrypted.subarray(0, 3).equals(Buffer.from('v10'))
        || !Buffer.isBuffer(password) || password.length < 1 || password.length > 4096) throw fail();
    let key, plain, partial, final;
    try {
        key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
        const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
        partial = decipher.update(encrypted.subarray(3)); final = decipher.final();
        plain = Buffer.concat([partial, final]);
        if (!plain.length || plain.length > 20 || plain.some(byte => byte < 0x30 || byte > 0x39)) throw fail();
        const token = plain.toString('ascii');
        if (!/^[1-9][0-9]{0,19}$/.test(token) || BigInt(token) > MAX_U64) throw fail();
        return token;
    } catch { throw fail(); }
    finally { key?.fill(0); partial?.fill(0); final?.fill(0); plain?.fill(0); }
}
module.exports = { decryptMacChromiumDeviceToken };
