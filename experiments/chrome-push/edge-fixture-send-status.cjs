'use strict';

// Synthetic Web Push responses may contain endpoint URLs, message IDs, or
// arbitrary server text. Keep only fixed status categories; never log headers.
function classifySendResponse(response) {
    const status = Number.isInteger(response?.statusCode) && response.statusCode >= 200 && response.statusCode <= 599
        ? String(response.statusCode) : 'UNKNOWN';
    const headers = response?.headers && typeof response.headers === 'object' && !Array.isArray(response.headers) ? response.headers : {};
    const category = (name, allowed) => {
        const value = headers[name];
        if (value === undefined) return 'ABSENT';
        if (typeof value !== 'string') return 'OTHER';
        const normalized = value.toLowerCase();
        return allowed.has(normalized) ? normalized.toUpperCase() : 'OTHER';
    };
    const device = category('x-wns-deviceconnectionstatus', new Set(['connected', 'disconnected', 'tempdisconnected', 'tempconnected']));
    const delivery = category('x-wns-status', new Set(['received', 'dropped', 'channelthrottled']));
    return `H${status}-D${device}-W${delivery}`;
}
function formatSendResponses(codes) {
    if (!Array.isArray(codes) || codes.length > 3 || codes.some(code => typeof code !== 'string'
        || !/^H(?:[2-5][0-9]{2}|UNKNOWN)-D(?:CONNECTED|DISCONNECTED|TEMPDISCONNECTED|TEMPCONNECTED|ABSENT|OTHER)-W(?:RECEIVED|DROPPED|CHANNELTHROTTLED|ABSENT|OTHER)$/.test(code)))
        throw new Error('PROBE_SEND_DIAGNOSTIC_INVALID');
    return codes.join(';');
}
module.exports = { classifySendResponse, formatSendResponses };
