'use strict';

// Validate duplicate keys and nesting before JSON.parse. This module deliberately
// throws a fixed error without echoing any input, including secret values.
function parseUniqueJson(source, maxDepth = 12) {
    const reject = () => { throw new Error('INVALID_JSON'); };
    if (typeof source !== 'string' || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) reject();
    let offset = 0;
    // eslint-disable-next-line no-control-regex
    const stringToken = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const whitespace = () => { while (offset < source.length && /[ \t\r\n]/.test(source[offset])) offset++; };
    function readString() {
        stringToken.lastIndex = offset;
        const match = stringToken.exec(source);
        if (!match) reject();
        offset = stringToken.lastIndex;
        return JSON.parse(match[0]);
    }
    function value(depth) {
        if (depth > maxDepth) reject();
        whitespace();
        if (source[offset] === '{') {
            offset++; whitespace();
            const names = new Set();
            if (source[offset] === '}') { offset++; return; }
            while (true) {
                whitespace();
                const name = readString();
                if (names.has(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) reject();
                names.add(name); whitespace();
                if (source[offset++] !== ':') reject();
                value(depth + 1); whitespace();
                const next = source[offset++];
                if (next === '}') return;
                if (next !== ',') reject();
            }
        }
        if (source[offset] === '[') {
            offset++; whitespace();
            if (source[offset] === ']') { offset++; return; }
            while (true) {
                value(depth + 1); whitespace();
                const next = source[offset++];
                if (next === ']') return;
                if (next !== ',') reject();
            }
        }
        if (source[offset] === '"') { readString(); return; }
        for (const literal of ['true', 'false', 'null']) {
            if (source.startsWith(literal, offset)) { offset += literal.length; return; }
        }
        numberToken.lastIndex = offset;
        if (!numberToken.exec(source)) reject();
        offset = numberToken.lastIndex;
    }
    value(0); whitespace();
    if (offset !== source.length) reject();
    return JSON.parse(source);
}
module.exports = { parseUniqueJson };
