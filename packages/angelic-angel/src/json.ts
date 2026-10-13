/** serde_json 1.0.149 validates every token before duplicate map fields are replaced. */
export function validateSerdeJsonLexemes(text: string): void {
  let depth = 0;
  const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (char === '"') {
      const start = offset++;
      for (; offset < text.length; offset++) {
        if (text[offset] === '\\') { offset++; continue; }
        if (text[offset] === '"') break;
      }
      const decoded = JSON.parse(text.slice(start, offset + 1)) as string;
      // In Unicode regex mode a valid surrogate pair is one astral code point;
      // this character class therefore matches only unpaired surrogates.
      if (/[\uD800-\uDFFF]/u.test(decoded)) throw new SyntaxError('Invalid JSON Unicode escape');
    } else if (char === '[' || char === '{') {
      // serde_json starts at 128 and fails when entering a container reaches zero.
      if (++depth >= 128) throw new SyntaxError('JSON recursion limit exceeded');
    } else if (char === ']' || char === '}') {
      depth--;
    } else if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) {
      numberToken.lastIndex = offset;
      const match = numberToken.exec(text);
      if (match) {
        if (!Number.isFinite(Number(match[0]))) throw new SyntaxError('JSON number out of range');
        offset = numberToken.lastIndex - 1;
      }
    }
  }
}

/** Throw-only serde_json::Value compatibility parser. Raw JSON keeps complete i64/u64
 * values serializable without exposing BigInt to webhook JSON.stringify. Protocol
 * callers can disable preservation when number/object classification is needed. */
export function parseSerdeJson(text: string, preserveIntegers = true): unknown {
  validateSerdeJsonLexemes(text);
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (typeof value !== 'number') return value;
    if (!Number.isFinite(value)) throw new SyntaxError('JSON number out of range');
    const source = context?.source;
    if (!preserveIntegers || source === undefined) return value;
    const rawJSON = (JSON as unknown as { rawJSON(source: string): unknown }).rawJSON;
    if (Object.is(value, -0)) return rawJSON('-0.0');
    if (!Number.isSafeInteger(value) && /^-?(?:0|[1-9][0-9]*)$/u.test(source)) {
      const integer = BigInt(source);
      if (integer >= -9223372036854775808n && integer <= 18446744073709551615n) return rawJSON(source);
    }
    return value;
  }) as unknown;
}
