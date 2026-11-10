'use strict';

// Builds bounded WNS requests from explicitly supplied, already validated
// client metadata. This module never loads product keys or opens a connection.
const { randomBytes, randomInt } = require('node:crypto');
const { reconnectSignature, challengeResponse } = require('./edge-wns-auth');
const { MAX_PAYLOAD } = require('./edge-wns-framing');
const fail = () => Object.assign(new Error('X_EDGE_WNS_PROTOCOL_INVALID'), { code: 'X_EDGE_WNS_PROTOCOL_INVALID' });
function exact(value, names) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) throw fail();
}
function xmlText(value, max, allowSpace = false) {
    return typeof value === 'string' && value.length > 0 && value.length <= max
        && (allowSpace ? /^[\x20-\x7e]+$/.test(value) : /^[\x21-\x7e]+$/.test(value)) && !/[<>&]/.test(value);
}
function sequence(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw fail(); return value; }
function channel(value) { if (typeof value !== 'string' || !/^[0-9a-f]{1,16}$/i.test(value)) throw fail(); return value; }
function packet(command, xml) {
    const context = randomBytes(8).toString('hex').toUpperCase(), correlation = `${randomBytes(12).toString('base64')}.0`;
    const body = Buffer.from(`Context: ${context}\r\nMS-CV: ${correlation}\r\n\r\n${xml}`, 'ascii');
    try {
        if (body.length > MAX_PAYLOAD) throw fail();
        return Buffer.concat([Buffer.from(`${command} ${body.length}\r\n`, 'ascii'), body]);
    } finally { body.fill(0); }
}
function createNonce() { return String(randomInt(1, 10)) + Array.from({ length: 31 }, () => String(randomInt(0, 10))).join(''); }
function connectFrame(agent, number) {
    exact(agent, ['os', 'osVersion', 'architecture', 'locale']);
    if (![agent.os, agent.osVersion, agent.architecture, agent.locale].every(value => xmlText(value, 128, true))) throw fail();
    return packet(`CNT ${sequence(number)} CON`, `<connect><ver>1</ver><agent><os>${agent.os}</os><osVer>${agent.osVersion}</osVer><proc>${agent.architecture}</proc><lcid>${agent.locale}</lcid></agent></connect>`);
}
function deviceFrame(number) { return packet(`ATH ${sequence(number)} CON\\DEVICE`, '<device><provision>false</provision></device>'); }
function bindFrame(input, number) {
    exact(input, ['channel', 'protocolVersion', 'clientName', 'clientVersion', 'nonce', 'reconnectToken', 'deviceKey']);
    const target = channel(input.channel); sequence(number);
    if (![input.protocolVersion, input.clientName, input.clientVersion].every(value => xmlText(value, 128, true))
        || typeof input.nonce !== 'string' || !/^\d{32}$/.test(input.nonce) || !Buffer.isBuffer(input.reconnectToken)
        || !input.reconnectToken.length || input.reconnectToken.length > 4096 || input.reconnectToken.some(byte => byte < 0x21 || byte > 0x7e || [38, 60, 62].includes(byte))) throw fail();
    let signature;
    try {
        signature = reconnectSignature(input.deviceKey, input.reconnectToken, input.nonce);
        return packet(`BND ${number} CON\\WNS ${target}`, `<wns><ver>${input.protocolVersion}</ver><client><name>${input.clientName}</name><ver>${input.clientVersion}</ver><nonce>${input.nonce}</nonce><signature>${signature.toString('base64')}</signature><reconnect-token>${input.reconnectToken.toString('ascii')}</reconnect-token></client></wns>`);
    } catch { throw fail(); } finally { signature?.fill(0); }
}
function challengeFrame(input, number) {
    exact(input, ['channel', 'serverNonce', 'productKey', 'productId']);
    const target = channel(input.channel); sequence(number);
    if (!Buffer.isBuffer(input.productId) || input.productId.length !== 16 || input.productId.some(byte => byte < 0x21 || byte > 0x7e)
        || !xmlText(input.productId.toString('ascii'), 16)) throw fail();
    let response;
    try {
        response = challengeResponse(input.serverNonce, input.productKey, input.productId);
        return packet(`PUT ${number} WNS\\CHALLENGE ${target}`, `<challenge><appId>${input.productId.toString('ascii')}</appId><response>${response.toString('hex')}</response></challenge>`);
    } catch { throw fail(); } finally { response?.fill(0); }
}
module.exports = { createNonce, connectFrame, deviceFrame, bindFrame, challengeFrame };
