// Reserve before retaining any request body. Shared across hot reloads and all
// automation routes in this process; a multi-process deployment also needs an
// ingress-wide quota (this is not advertised as a fleet-wide limiter).
type Usage = { active: number; resetAt: number; requests: number };
type Budget = { bytes: number; active: number; actors: Map<string, Usage> };
const processGlobals = globalThis as unknown as { automationAdmission?: Budget };
const budget = processGlobals.automationAdmission ||= { bytes: 0, active: 0, actors: new Map() };
const MiB = 1024 * 1024;
export class AdmissionError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function bodyLimit(path: string) {
  if (/^\/(dictionaries|dictionary-preview)(?:\/|$)/.test(path)) return 160 * MiB;
  if (/^\/(packages|import)(?:\/|$)/.test(path)) return 48 * MiB;
  if (/^\/(workflows|validate|simulate)(?:\/|$)/.test(path)) return 2 * MiB;
  return 256 * 1024;
}
export function reserveAdmission(actor: string, maxBody: number, now = Date.now()) {
  for (const [key, value] of budget.actors) if (!value.active && value.resetAt <= now) budget.actors.delete(key);
  let usage = budget.actors.get(actor);
  if (!usage) {
    if (budget.actors.size >= 4096) throw new AdmissionError(503, "AUTOMATION_BUSY", "混雑しています。しばらくしてから再試行してください。");
    usage = { active: 0, resetAt: now + 60000, requests: 0 }; budget.actors.set(actor, usage);
  }
  if (usage.resetAt <= now) { usage.requests = 0; usage.resetAt = now + 60000; }
  if (usage.requests >= 120 || usage.active >= 4) throw new AdmissionError(429, "AUTOMATION_USER_BUSY", "操作が集中しています。しばらくしてから再試行してください。");
  // Worst-case encoded/raw/parsed copies are reserved by the route ceiling,
  // never by an untrusted Content-Length. At most one 160MiB body is admitted.
  if (budget.active >= 16 || budget.bytes + maxBody > 192 * MiB) throw new AdmissionError(503, "AUTOMATION_BODY_BUSY", "大きな入力を処理中です。完了後に再試行してください。");
  budget.bytes += maxBody; budget.active++; usage.active++; usage.requests++;
  let released = false;
  return () => { if (!released) { released = true; budget.bytes -= maxBody; budget.active--; usage.active--; } };
}
