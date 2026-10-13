export type ErrorCode = 'Config' | 'AutoPush' | 'TwitterApi' | 'WebSocket' | 'Decryption' | 'Ece' | 'Io' | 'Http' | 'Json' | 'Toml' | 'Base64Decode';
const prefixes: Record<ErrorCode, string> = {
  Config: 'config error', AutoPush: 'AutoPush error', TwitterApi: 'Twitter API error',
  WebSocket: 'WebSocket error', Decryption: 'decryption error', Ece: 'ECE error',
  Io: 'IO error', Http: 'HTTP error', Json: 'JSON error', Toml: 'TOML error', Base64Decode: 'base64 decode error'
};
/** Causes remain available for programmatic diagnosis; CLI/logs emit only safe messages. */
export class AngelicAngelError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(`${prefixes[code]}: ${message}`, options);
    this.name = 'AngelicAngelError';
    this.code = code;
  }
  toJSON(): { code: ErrorCode; message: string } { return { code: this.code, message: this.message }; }
}
export function safeError(error: unknown): string {
  return error instanceof AngelicAngelError ? error.message : 'operation failed';
}
