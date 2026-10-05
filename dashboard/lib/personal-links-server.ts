import "server-only";
import { z } from "zod";
import { requireBotModule } from "@/lib/bot-require";
import type { PersonalItem, PersonalKind } from "@/lib/personal-links-types";

const fields = {
  url: z.string().url().max(2048), title: z.string().max(512).default(""),
  tags: z.array(z.string().max(40)).max(10).default([]), note: z.string().max(1000).default(""),
  when: z.string().min(1).max(64), timeZone: z.string().min(1).max(64).default("Asia/Tokyo"),
  variationId: z.string().regex(/^(\*|\d{1,20})$/).default("*"), variationName: z.string().max(100).default(""),
  revision: z.number().int().nonnegative(), requestId: z.string().uuid(),
};
const savedCreate = z.object({ url: fields.url, title: fields.title, tags: fields.tags, note: fields.note }).strict();
const savedEdit = z.object({ title: fields.title, tags: fields.tags, note: fields.note, revision: fields.revision }).strict();
const reminder = z.object({ url: fields.url, title: fields.title, when: fields.when, timeZone: fields.timeZone });
const restock = z.object({ url: fields.url, title: fields.title, variationId: fields.variationId, variationName: fields.variationName });
const pages = z.coerce.number().int().min(1).max(1000).default(1);
const kinds = new Set(["saved", "reminder", "restock"]);
function failure(code: string, status = 400): never { throw Object.assign(new Error(code), { code, status }); }

export function personalLinkServices() {
  const db = requireBotModule<any>("src/db.js");
  const store = requireBotModule<any>("src/personalLinks/store.js").createStore(db);
  const model = requireBotModule<any>("src/personalLinks/model.js");
  return { store, model, stockOptions: async (url: string) => {
    const item = model.boothItem(url);
    const providerStore = requireBotModule<any>("src/providers/autoWatch/store.js");
    const policy = requireBotModule<any>("src/providers/autoWatch/index.js").ratePolicy("booth");
    const permit = await providerStore.reserveProviderRequest("booth", policy, Date.now());
    if (!permit.allowed) failure("STOCK_PACED", 429);
    try {
      const stock = await requireBotModule<any>("src/personalLinks/runner.js").fetchStock({ item_id: item.itemId, url: item.url });
      const options = [
        ...(stock.state === "sold_out" ? [{ id: "*", name: "商品全体", state: "sold_out" }] : []),
        ...stock.variations.filter((variation: any) => variation.state === "sold_out"),
      ];
      return { item, options };
    } catch (error: any) {
      if (Number(error.status) === 429) await providerStore.cooldownProvider("booth", Date.now() + Math.max(60000, Number(error.retryAfterMs) || 0));
      failure("STOCK_UNAVAILABLE", 502);
    }
  } };
}

export function presentPersonalItem(row: any, kind: PersonalKind): PersonalItem {
  const base = { id: String(row.id), kind, url: String(row.url), title: String(row.title), updatedAt: Number(row.updated_at_ms) };
  if (kind === "saved") return { ...base, tags: JSON.parse(row.tags_json), note: String(row.note), editable: true, cancellable: true };
  return { ...base, dueAt: Number(row.due_at_ms), timeZone: row.time_zone, variationId: row.variation_id, variationName: row.variation_name,
    status: row.status, lastError: row.last_error, editable: ["watching", "pending", "preparing"].includes(row.status),
    cancellable: ["watching", "pending", "preparing", "failed", "quarantined"].includes(row.status) };
}

export async function dispatchPersonalLinks(request: { method: string; path: string[]; search: URLSearchParams; body?: unknown }, userId: string, locale: string, services: ReturnType<typeof personalLinkServices>) {
  if (!/^\d{16,22}$/.test(userId)) failure("LOGIN_REQUIRED", 401);
  const { method, path, search } = request, { store, model } = services;
  if (path.length < 1 || path.length > 2 || !kinds.has(path[0])) failure("NOT_FOUND", 404);
  const kind = path[0] as PersonalKind, id = path[1];
  if (kind === "restock" && id === "options" && method === "POST") {
    const body = z.object({ url: fields.url }).strict().parse(request.body);
    const stock = await services.stockOptions(body.url);
    return { options: stock.options.map((option: any) => ({ ...option, name: option.id === "*" ? locale === "ja" ? "商品全体" : "Any variation" : option.name })) };
  }
  if (id && !/^[a-f0-9]{32}$/.test(id)) failure("NOT_FOUND", 404);
  if (method === "GET" && !id) {
    for (const key of search.keys()) if (!["page", "query", "tag"].includes(key)) failure("INVALID_INPUT");
    const page = pages.parse(search.get("page") || undefined);
    if (kind === "saved" && page > 100) failure("INVALID_INPUT");
    const rows = kind === "saved" ? await store.listSaved(userId, {
      page, limit: 11, query: z.string().max(100).parse(search.get("query") || ""), tag: z.string().max(40).parse(search.get("tag") || ""),
    }) : await store.listNotifications(userId, kind, page, 11);
    return { items: rows.slice(0, 10).map((row: any) => presentPersonalItem(row, kind)), hasMore: rows.length > 10 };
  }
  if (method === "DELETE" && id) {
    z.object({}).strict().parse(request.body || {});
    if (kind === "saved") await store.deleteSaved(userId, id); else await store.cancel(userId, id, kind);
    return { ok: true };
  }
  if (kind === "saved" && method === "POST" && !id) {
    const body = savedCreate.parse(request.body);
    const saved = await store.save(userId, model.link(body.url, body.title), {
      ...(body.tags.length ? { tags: body.tags } : {}), ...(body.note ? { note: body.note } : {}),
    });
    return { ok: true, already: saved.already === true };
  }
  if (kind === "saved" && method === "PATCH" && id) {
    const body = savedEdit.parse(request.body);
    await store.editSaved(userId, id, body.tags, body.note, { title: body.title, expectedUpdatedAt: body.revision });
    return { ok: true };
  }
  if (kind !== "saved" && ((method === "POST" && !id) || (method === "PATCH" && id))) {
    const schema = kind === "reminder" ? reminder : restock;
    const body: any = (id ? schema.extend({ revision: fields.revision }) : schema.extend({ requestId: fields.requestId })).strict().parse(request.body);
    const entry = model.link(body.url, body.title);
    const changes = { ...body, dueAtMs: kind === "reminder" ? model.dueAt(body.when, body.timeZone) : 0 };
    if (kind === "restock") {
      const current = id ? await store.getNotification(userId, id, kind) : null;
      if (id && !current) failure("NOT_FOUND", 404);
      const targetChanged = !current || current.url !== entry.url || current.variation_id !== body.variationId;
      if (targetChanged) {
        const stock = await services.stockOptions(entry.url);
        if (!stock.options.some((option: any) => option.id === body.variationId)) failure("INVALID_VARIATION");
        changes.variationName = stock.options.find((option: any) => option.id === body.variationId)?.name || "";
      }
    }
    if (id) await store.updateNotification(userId, id, kind, changes, body.revision);
    else await store.createNotification(userId, entry, { ...changes, kind, requestKey: `web:${body.requestId}`, locale });
    return { ok: true };
  }
  failure("NOT_FOUND", 404);
}

const errors: Record<string, [string, string, number]> = {
  NOT_FOUND: ["対象が見つかりません。", "Entry not found.", 404], EDIT_CONFLICT: ["別の操作で更新されています。一覧を更新してから編集し直してください。", "This entry changed. Refresh the list before editing again.", 409],
  NOT_EDITABLE: ["送信開始済み、または終了した通知は編集できません。", "A notification that is sending or finished cannot be edited.", 409],
  ALREADY_SENDING: ["送信開始済みのため解除できません。", "Delivery has started and cannot be cancelled.", 409], ALREADY_FINISHED: ["送信済み、または送信結果が不明な通知です。", "This notification was sent or its delivery is uncertain.", 409],
  DUPLICATE_WATCH: ["同じ対象の再入荷通知がすでに登録されています。", "You already have an active watch for this target.", 409],
  INVALID_LINK: ["URLを確認してください。", "Check the URL.", 400], UNSUPPORTED_LINK: ["Botの対応サービスのURLを入力してください。", "Enter a URL from a supported service.", 400],
  INVALID_BOOTH_LINK: ["BOOTHの商品URLを入力してください。", "Enter a BOOTH item URL.", 400], INVALID_VARIATION: ["バリエーションを確認してください。", "Check the variation.", 400],
  INVALID_TIME: ["日時を確認してください。夏時間で曖昧な時刻にはUTCオフセット付きISO日時を指定してください。", "Check the date and time. Use an explicit UTC offset for ambiguous local times.", 400],
  INVALID_TIME_ZONE: ["タイムゾーンを確認してください。", "Check the time zone.", 400], TIME_OUT_OF_RANGE: ["1分後から366日後までの日時を指定してください。", "Choose a time between one minute and 366 days from now.", 400],
  INVALID_TAGS: ["タグは10個まで、各40文字以内です。", "Use up to 10 tags of 40 characters each.", 400], NOTE_TOO_LONG: ["メモは1000文字以内です。", "Notes may contain at most 1,000 characters.", 400],
  SAVED_LIMIT: ["保存上限の1000件に達しました。", "You have reached the 1,000 saved-link limit.", 400], NOTIFICATION_LIMIT: ["有効な通知は合計100件までです。", "Up to 100 active notifications are allowed.", 400],
  STOCK_PACED: ["商品情報の確認が混み合っています。少し待って再試行してください。", "Please wait before requesting item information again.", 429],
  STOCK_UNAVAILABLE: ["商品情報を取得できませんでした。入力内容は保持しています。", "Could not load item information. Your input has been kept.", 502],
};
export function personalLinkError(error: any, locale = "ja") {
  const known = errors[error?.code];
  if (known) return { message: known[locale === "ja" ? 0 : 1], status: known[2] };
  if (error instanceof z.ZodError || error?.code === "INVALID_INPUT") return { message: locale === "ja" ? "入力内容を確認してください。" : "Please check the input.", status: 400 };
  return { message: locale === "ja" ? "操作に失敗しました。入力内容を保持したまま再試行できます。" : "The operation failed. Your input has been kept for retry.", status: 500 };
}
