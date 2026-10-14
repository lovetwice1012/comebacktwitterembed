export type ErrorCode = 'Config' | 'AutoPush' | 'TwitterApi' | 'WebSocket' | 'Decryption' | 'Ece' | 'Io' | 'Http' | 'Json' | 'Toml' | 'Base64Decode';
const prefixes: Record<ErrorCode, string> = {
  Config: 'config error', AutoPush: 'AutoPush error', TwitterApi: 'Twitter API error',
  WebSocket: 'WebSocket error', Decryption: 'decryption error', Ece: 'ECE error',
  Io: 'IO error', Http: 'HTTP error', Json: 'JSON error', Toml: 'TOML error', Base64Decode: 'base64 decode error'
};
function diagnosticCause(cause: unknown): Error {
  if (cause instanceof AngelicAngelError) return cause;
  const names = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError', 'SystemError']);
  const name = cause instanceof Error && names.has(cause.name) ? cause.name : 'Error';
  const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ENOSPC', 'EIO', 'EEXIST']);
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  const retainedCode = typeof code === 'string' && codes.has(code) ? code : undefined;
  const safe = new Error(`${name} failure${retainedCode ? ` (${retainedCode})` : ''}`);
  safe.name = name;
  if (retainedCode) Object.defineProperty(safe, 'code', { value: retainedCode, enumerable: true });
  return safe;
}
/** Retain cause category/code without retaining parser snippets, URLs or secret payloads. */
export class AngelicAngelError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(`${prefixes[code]}: ${message}`, options?.cause === undefined ? undefined : { cause: diagnosticCause(options.cause) });
    this.name = 'AngelicAngelError';
    this.code = code;
  }
  toJSON(): { code: ErrorCode; message: string } { return { code: this.code, message: this.message }; }
}
export function safeError(error: unknown): string {
  return error instanceof AngelicAngelError ? error.message : 'operation failed';
}
