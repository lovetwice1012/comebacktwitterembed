export const fieldLabels: Record<string, string> = {
  providerId: "サービス", kind: "投稿の種類", sourceKey: "監視対象", contentId: "投稿ID", url: "リンク", title: "タイトル", body: "本文", author: "作者", tags: "タグ", language: "言語", sensitive: "センシティブ表示", mediaCount: "画像・動画の数", durationSeconds: "再生時間（秒）", priceAmount: "現在価格", previousPriceAmount: "前回価格", priceDelta: "増減額", discountPercent: "割引率（%）", currency: "通貨", available: "購入できる", publishedAtMs: "公開時刻", observedAtMs: "検知時刻", ageMinutes: "公開からの経過（分）",
};
export const valueLabels: Record<string, string> = {
  ...fieldLabels, eq: "等しい", ne: "等しくない", contains: "含む", notContains: "含まない", startsWith: "で始まる", endsWith: "で終わる", in: "候補のどれか", exists: "取得できている", gt: "より大きい", gte: "以上", lt: "より小さい", lte: "以下", true: "はい", false: "いいえ", yes: "一致", no: "不一致", unknown: "情報不足", out: "次へ", expanded: "リッチ表示", card: "カード", text: "文章", all: "全体", sourceKey: "監視対象ごと", author: "作者ごと", providerId: "サービスごと", currency: "通貨ごと", default: "この通知の宛先", youtube: "YouTube", github: "GitHub", twitch: "Twitch", spotify: "Spotify", pixiv: "Pixiv", booth: "BOOTH", amazon: "Amazon", steam: "Steam", new: "新着", price: "価格", ReleaseEvent: "リリース", PushEvent: "コミット",
};
export function predicateSummary(p: any): string {
  if (!p) return "条件を設定";
  if (["all", "any", "not"].includes(p.op)) {
    const children = (p.conditions || []).map(predicateSummary);
    return p.op === "not" ? `NOT（${children[0] || "条件なし"}）` : `（${children.join(p.op === "all" ? " AND " : " OR ")}）`;
  }
  const name = fieldLabels[p.field] || p.field;
  const val = typeof p.value === "boolean" ? p.value ? "はい" : "いいえ" : Array.isArray(p.value) ? p.value.join("、") : String(p.value ?? "未設定");
  const comparison = ({ eq: "＝", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" } as Record<string, string>)[p.op] || valueLabels[p.op] || p.op;
  return p.op === "exists" ? `${name}を取得済み` : `${name} ${comparison}「${val}」${p.ignoreCase ? "（大小無視）" : ""}`;
}
export function predicateHeading(p: any): string {
  return p?.op === "all" ? `AND · すべて（${p.conditions.length}条件）` : p?.op === "any" ? `OR · どれか（${p.conditions.length}条件）` : p?.op === "not" ? "NOT · 否定" : predicateSummary(p);
}
export function blockSummary(node: any): string {
  const c = node.config;
  switch (node.type) {
    case "start": return c.providers?.length ? c.providers.map((p: string) => valueLabels[p] || p).join("・") : "すべての新着・価格イベント";
    case "condition": return predicateSummary(c.predicate);
    case "dictionary": return `${c.fields.map((f: string) => fieldLabels[f] || f).join("・")}を「${c.dictionary}」で確認`;
    case "merge": return c.mode === "all" ? "すべての経路が一致したら1件に合流" : "一致した経路を1件に合流";
    case "delay": return `${c.anchor === "published" ? "公開" : "検知"}から${c.minutes}分待つ`;
    case "schedule": return `${c.windows.map((w: any) => `${w.start}–${w.end}`).join("、")}${c.quiet?.length ? ` ／ ${c.quiet.map((w: any) => `${w.start}–${w.end}`).join("、")}は通知しない` : ""} (${c.zone})`;
    case "transform": return `${valueLabels[c.format] || c.format} · ${c.template}`;
    case "limit": return `${c.minutes}分に${c.count}件まで`;
    case "aggregate": return `${c.minutes}分分をまとめる（最大${c.maxItems}件）`;
    case "send": return c.destination === "default" ? "この通知に設定した宛先へ" : `「${c.destination}」へ`;
    case "stop": return c.reason || "この経路では通知しない";
    default: return "";
  }
}
export function evaluationKey(rule: any, bindings: any): string {
  return JSON.stringify({ schemaVersion: rule.schemaVersion, expiresAfterMinutes: rule.expiresAfterMinutes,
    nodes: rule.nodes.map((n: any) => ({ id: n.id, type: n.type, config: n.config })), edges: rule.edges, bindings });
}
