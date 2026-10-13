"use client";

import { AlertTriangle, Check, Clipboard, Eye, Info, Plus, RotateCcw, Save, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { OutputPreviewCard } from "@/components/preview/output-preview-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { categoryLabel, createTranslator, impactLabel, labelText, type DashboardLocale, type TranslationKey } from "@/lib/i18n";
import { buildPreview } from "@/lib/settings-preview";
import { deepEqual } from "@/lib/settings-diff";
import { settingCommandsForValue, type SettingCommand } from "@/lib/setting-commands";
import type { AccountDepthMap, ButtonVisibility, SettingState, SettingValue, TargetSetting } from "@/lib/types";
import { isCommonSetting, settingChoiceTitle, settingDisplayValue, settingTitle } from "./settings-presentation";
import "./settings-workspace.css";

type FormValues = Record<string, SettingValue>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function initialValues(settings: SettingState[]) {
  return Object.fromEntries(settings.map((setting) => [setting.key, setting.value])) as FormValues;
}

function textareaList(value: unknown) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function parseTextareaList(value: string) {
  return [...new Set(value.split(/[\n,]/).map((item) => item.normalize("NFC").trim()).filter(Boolean))];
}

function accountDepthEntries(value: SettingValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as AccountDepthMap)
    .map(([account, depth]) => ({
      account,
      depth: Number(depth),
    }))
    .filter((entry) => entry.account && Number.isInteger(entry.depth) && entry.depth >= 0)
    .sort((a, b) => a.account.localeCompare(b.account));
}

function normalizeAccountInput(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function targetTextarea(value: unknown, key: keyof TargetSetting) {
  const targets = value as TargetSetting;
  return Array.isArray(targets?.[key]) ? targets[key].join("\n") : "";
}

const targetLabelKeys = {
  user: "form.target.user",
  channel: "form.target.channel",
  role: "form.target.role",
} satisfies Record<keyof TargetSetting, TranslationKey>;

const buttonLabelKeys: Record<string, TranslationKey> = {
  showMediaAsAttachments: "form.button.showMediaAsAttachments",
  showAttachmentsAsEmbedsImage: "form.button.showAttachmentsAsEmbedsImage",
  translate: "form.button.translate",
  delete: "form.button.delete",
  savetweet: "form.button.savetweet",
  personal: "form.button.personal",
  personal_save: "form.button.personal_save",
  personal_remind: "form.button.personal_remind",
  personal_restock: "form.button.personal_restock",
  gallery: "form.button.gallery",
  all: "form.button.all",
};

function targetLabel(target: keyof TargetSetting, locale: DashboardLocale) {
  return createTranslator(locale)(targetLabelKeys[target]);
}

function buttonLabel(key: string, locale: DashboardLocale) {
  const labelKey = buttonLabelKeys[key];
  return labelKey ? createTranslator(locale)(labelKey) : key;
}

const selfDescribingSettings = new Set([
  "enabled", "disable", "defaultLanguage", "extract_bot_message", "button_invisible", "button_disabled",
  "failure_display_policy", "anonymous_expand", "alwaysreplyifpostedtweetlink", "display_density", "media_display_mode",
  "hidden_output_items", "amazon_description_max_length", "booth_adult_display_mode", "github_card_style", "steam_image_source",
  "sendMediaAsAttachmentsAsDefault", "legacy_mode", "twitter_stats_layout", "twitter_quote_mode", "pixiv_images_per_step",
  "pixiv_caption_max_length", "pixiv_tag_limit", "youtube_video_list_limit", "tiktok_hq", "tiktok_video_fallback_mode",
  "quote_repost_max_depth", "quote_repost_do_not_extract",
]);

function settingHint(providerId: string, setting: SettingState, locale: DashboardLocale) {
  if (setting.key === "bannedWords" && providerId === "twitter") {
    return locale === "ja" ? "該当するツイートは展開せず、元の投稿メッセージも削除します。" : "Matching tweets are not expanded. The original Discord message is also deleted.";
  }
  const hints: Record<string, [string, string]> = {
    silent_expansion: ["プッシュ通知・デスクトップ通知を抑えます。未読表示は残ります。", "Suppresses push and desktop notifications. Unread indicators remain."],
    show_previous_shares: ["オフでも今回のリンクは展開されます。", "Turning this off still expands the current link."],
    gallery_display_mode: ["ページ操作は自分専用の画面で行います。", "Gallery navigation opens a private viewer."],
    editOriginalIfTranslate: ["元のBot応答を翻訳結果に置き換えます。", "Replaces the original bot response with its translation."],
    bannedWords: ["取得した本文・表示情報に指定した語が含まれる場合、展開しません。", "Skips expansion when fetched text or display information contains a listed word."],
    deletemessageifonlypostedtweetlink: ["リンクだけの元投稿を、展開の送信成功後に削除します。", "Deletes link-only source messages after successful expansion delivery."],
    deletemessageifonlypostedtweetlink_secoundaryextractmode: ["元投稿の削除がオンなら、条件に合うリンクだけの投稿も送信成功後に削除します。", "When source deletion is enabled, also deletes link-only messages after successful matching expansion delivery."],
    quote_repost_depth_by_account: ["アカウント別の指定を優先します。", "Account-specific values take priority."],
    passive_mode: ["簡易埋め込みのツイート本文を省略します。", "Omits tweet text in compact embeds."],
    secondary_extract_mode: ["動画・複数画像の条件で展開を絞ります。", "Filters expansion by the selected video or multiple-image conditions."],
    pixiv_images_per_step: ["1回のBot応答に含める枚数", "Images included in each bot response"],
  };
  const hint = hints[setting.key];
  if (hint) return hint[locale === "ja" ? 0 : 1];
  if (selfDescribingSettings.has(setting.key) || /_(?:description_max_length|caption_max_length|image_limit|media_limit)$/.test(setting.key)) return "";
  return labelText(setting.spec.description, locale);
}

export function ProviderSettingsForm({
  guildId,
  providerId,
  providerLabel,
  canEdit,
  canReset = canEdit,
  settings,
  locale,
  draftKeyOverride,
  onSaveChanges,
  onSaved,
  showResetProvider = true,
  onChangesChange,
  externalSaved,
  externalSaving = false,
  viewerId,
  scopeLabel,
  requiredSaveKeys = [],
}: {
  guildId: string;
  providerId: string;
  providerLabel: string;
  canEdit: boolean;
  canReset?: boolean;
  settings: SettingState[];
  locale: DashboardLocale;
  draftKeyOverride?: string;
  onSaveChanges?: (changes: Record<string, SettingValue>) => Promise<{ warnings?: string[]; complete?: boolean; cancelled?: boolean } | void>;
  onSaved?: () => void;
  showResetProvider?: boolean;
  onChangesChange?: (changes: Record<string, SettingValue>) => void;
  externalSaved?: { sequence: number; changes: Record<string, SettingValue>; warnings?: string[] };
  externalSaving?: boolean;
  viewerId?: string;
  scopeLabel?: string;
  requiredSaveKeys?: string[];
}) {
  const router = useRouter();
  const t = createTranslator(locale);
  const defaults = useMemo(() => initialValues(settings), [settings]);
  const [savedValues, setSavedValues] = useState<FormValues>(defaults);
  const savedRef = useRef(defaults), hydratedKey = useRef<string | null>(null);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const draftKey = draftKeyOverride || `dashboard:draft:${viewerId ? `${viewerId}:` : ""}${guildId}:${providerId}`;
  const form = useForm<FormValues>({ defaultValues: defaults });
  const watched = form.watch();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("common"), [changedOnly, setChangedOnly] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [messageError, setMessageError] = useState(false);
  const [invalidSettings, setInvalidSettings] = useState<Record<string, boolean>>({});
  const [discardSequence, setDiscardSequence] = useState(0);
  const formBusy = saving || externalSaving;
  const setValidity = useCallback((key: string, valid: boolean) => setInvalidSettings(current => current[key] === !valid ? current : { ...current, [key]: !valid }), []);
  const invalidKeys = settings.filter(setting => invalidSettings[setting.key]).map(setting => setting.key);
  const revealSetting = (key: string) => {
    setQuery(""); setCategory("all"); setChangedOnly(false);
    requestAnimationFrame(() => {
      const card = document.getElementById(`setting-${encodeURIComponent(key)}`);
      card?.scrollIntoView?.({ block: "center" });
      (card?.querySelector<HTMLElement>('[aria-invalid="true"],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)') || card)?.focus();
    });
  };

  useEffect(() => {
    let pending: FormValues = {};
    if (hydratedKey.current === draftKey) {
      pending = Object.fromEntries(Object.entries(form.getValues()).filter(([key, value]) => Object.hasOwn(defaults, key) && (requiredSaveKeys.includes(key) || !deepEqual(value, savedRef.current[key])))) as FormValues;
    } else {
      try {
        const raw = window.localStorage.getItem(draftKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pending = Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(defaults, key))) as FormValues;
          if (Object.keys(pending).length) { setMessage(t("form.draftRestored")); setMessageError(false); }
        }
      } catch { setStorageWarning(locale === "ja" ? "ブラウザに下書きを保存できません。画面を閉じる前に変更を保存してください。" : "Drafts cannot be saved in this browser. Save changes before closing this page."); }
      setInvalidSettings({});
    }
    savedRef.current = defaults;
    hydratedKey.current = draftKey;
    setSavedValues(defaults);
    form.reset({ ...defaults, ...pending });
    setReadyKey(draftKey);
  }, [defaults, draftKey]);

  const watchedFingerprint = JSON.stringify(watched);
  const requiredFingerprint = JSON.stringify(requiredSaveKeys);
  const changes = useMemo(() => {
    return Object.fromEntries(Object.entries(watched).filter(([key, value]) => requiredSaveKeys.includes(key) || !deepEqual(value, savedValues[key]))) as FormValues;
  }, [savedValues, watchedFingerprint, requiredFingerprint]);
  const hasChanges = Object.keys(changes).length > 0;
  useEffect(() => { onChangesChange?.(changes); }, [changes, onChangesChange]);

  const externalSequence = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!externalSaved || externalSequence.current === externalSaved.sequence) return;
    externalSequence.current = externalSaved.sequence;
    const current = clone(form.getValues());
    const nextSaved = { ...savedRef.current, ...externalSaved.changes };
    savedRef.current = nextSaved; setSavedValues(nextSaved); form.reset(current);
    setMessage(externalSaved.warnings?.length ? externalSaved.warnings.join(" ") : t("form.saveSuccess")); setMessageError(false);
  }, [externalSaved]);

  useEffect(() => {
    if (readyKey !== draftKey) return;
    try {
      if (hasChanges) window.localStorage.setItem(draftKey, JSON.stringify(changes));
      else window.localStorage.removeItem(draftKey);
    } catch { setStorageWarning(locale === "ja" ? "ブラウザに下書きを保存できません。画面を閉じる前に変更を保存してください。" : "Drafts cannot be saved in this browser. Save changes before closing this page."); }
  }, [changes, draftKey, hasChanges, readyKey]);

  useEffect(() => {
    const focusSetting = () => {
      const target = new URLSearchParams(window.location.search).get("setting");
      if (!target || !settings.some(setting => setting.key === target)) return;
      setQuery(""); setCategory("all"); setChangedOnly(false);
      requestAnimationFrame(() => {
        const card = document.getElementById(`setting-${encodeURIComponent(target)}`);
        card?.scrollIntoView?.({ block: "center" });
        (card?.querySelector<HTMLElement>("input:not(:disabled),select:not(:disabled),textarea:not(:disabled)") || card)?.focus();
      });
    };
    focusSetting(); window.addEventListener("popstate", focusSetting);
    return () => window.removeEventListener("popstate", focusSetting);
  }, [draftKey, settings]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasChanges]);

  const filteredSettings = useMemo(() => {
    const q = query.trim().toLowerCase();
    return settings.filter((setting) => {
      if (category === "common" && !q && !changedOnly && !isCommonSetting(setting, settings)) return false;
      if (category !== "all" && category !== "common" && setting.spec.category !== category) return false;
      if (changedOnly && !Object.hasOwn(changes, setting.key)) return false;
      const haystack = [
        setting.key,
        labelText(setting.spec.label, locale),
        settingTitle(setting, locale),
        labelText(setting.spec.description, locale),
        setting.spec.category,
        categoryLabel(setting.spec.category, locale),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query, settings, category, changedOnly, changes, locale]);
  const categories = [...new Set(settings.map(setting => setting.spec.category))];

  const previewStates = settings.map((setting) => ({
    ...setting,
    value: watched[setting.key] ?? setting.value,
  }));
  const preview = buildPreview(providerId, previewStates, locale);

  async function save() {
    if (invalidKeys.length) return;
    const dangerousKeys = Object.keys(changes).filter((key) => settings.find((setting) => setting.key === key)?.spec.impactLevel === "danger");
    if (dangerousKeys.length && !confirm(t("form.dangerConfirm", { keys: dangerousKeys.map(key => settingTitle(settings.find(setting => setting.key === key)!, locale)).join(", ") }))) return;
    setSaving(true);
    setMessage(null);
    setMessageError(false);
    try {
      let warnings: string[] = [];
      if (onSaveChanges) {
        const result = await onSaveChanges(changes);
        if (result?.cancelled) return;
        warnings = result?.warnings || [];
        if (result?.complete === false) { setMessage(warnings.join(" ") || t("form.saveFailed")); setMessageError(true); return; }
      } else {
        const res = await fetch(`/api/guilds/${guildId}/providers/${providerId}/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || t("form.saveFailed"));
        warnings = json.warnings || [];
      }
      try { window.localStorage.removeItem(draftKey); } catch { /* saving on the server succeeded; browser cleanup is optional */ }
      const nextValues = clone(watched);
      savedRef.current = nextValues;
      setSavedValues(nextValues);
      form.reset(nextValues);
      setMessage(warnings.length ? t("form.saveSuccessWarnings", { warnings: warnings.join(" ") }) : t("form.saveSuccess"));
      if (onSaved) onSaved();
      else router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("form.saveFailed"));
      setMessageError(true);
    } finally {
      setSaving(false);
    }
  }

  async function resetProvider() {
    if (!confirm(t("form.resetConfirm", { providerLabel }))) return;
    setSaving(true);
    setMessage(null); setMessageError(false);
    try {
      const res = await fetch(`/api/guilds/${guildId}/providers/${providerId}/reset`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("form.resetFailed"));
      if (!Array.isArray(json.settings)) throw new Error(t("form.resetFailed"));
      const nextValues = initialValues(json.settings as SettingState[]);
      savedRef.current = nextValues;
      setSavedValues(nextValues);
      form.reset(nextValues);
      setInvalidSettings({});
      setDiscardSequence(sequence => sequence + 1);
      try { window.localStorage.removeItem(draftKey); } catch { /* reset on the server succeeded */ }
      setMessage(t("form.resetSuccess"));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("form.resetFailed"));
      setMessageError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`settings-workspace settings-layout ${hasChanges || previewOpen ? "settings-layout--review" : ""} ${hasChanges ? "pb-44 sm:pb-0" : ""}`}>
      <div className="min-w-0 space-y-4">
        {hasChanges || message || storageWarning ? (
        <div data-settings-save-bar className={`rounded-lg border bg-card p-3 shadow-soft ${hasChanges ? "fixed inset-x-0 bottom-0 z-40 pb-[max(.75rem,env(safe-area-inset-bottom))] sm:sticky sm:inset-auto sm:top-[calc(var(--dashboard-header-height,8rem)+.5rem)] sm:z-20" : ""}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              {hasChanges ? <><div className="font-medium">{t("form.unsavedCount", { count: Object.keys(changes).length })}</div><div className="mt-1 text-xs text-muted-foreground">{[scopeLabel, providerLabel].filter(Boolean).join(" · ")}</div></> : null}
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button className="min-h-11 flex-1 sm:flex-none" variant="outline" onClick={() => { form.reset(clone(savedValues)); setDiscardSequence(sequence => sequence + 1); setMessage(null); setMessageError(false); }} disabled={!hasChanges || formBusy}>
                <RotateCcw size={16} />
                {requiredSaveKeys.length ? locale === "ja" ? "表示値を元に戻す" : "Restore previous values" : t("form.discard")}
              </Button>
              <Button className="min-h-11 flex-1 sm:flex-none" onClick={save} disabled={!canEdit || !hasChanges || formBusy || invalidKeys.length > 0}>
                <Save size={16} />
                {formBusy ? locale === "ja" ? "保存中…" : "Saving…" : requiredSaveKeys.length ? locale === "ja" ? "現在の値で保存を完了" : "Complete save with current values" : t("form.save")}
              </Button>
            </div>
          </div>
          {invalidKeys.length > 0 && <Button variant="ghost" className="mt-2 min-h-11 text-destructive" onClick={() => revealSetting(invalidKeys[0])}>{locale === "ja" ? "未完了のアカウント設定を確認" : "Review unfinished account settings"}</Button>}
          {message ? <div role={messageError ? "alert" : "status"} className={`mt-2 text-sm ${messageError ? "text-destructive" : "text-muted-foreground"}`}>{message}</div> : null}
          {storageWarning ? <p role="status" className="mt-2 flex items-start gap-2 text-xs text-muted-foreground"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{storageWarning}</p> : null}
        </div>
        ) : null}

        <section aria-label={locale === "ja" ? "設定を探す" : "Find settings"} className="space-y-3 rounded-lg border bg-card p-4">
          <div className="settings-toolbar">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
              <Input aria-label={t("form.searchPlaceholder")} className="pl-9" placeholder={t("form.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setCategory("all"); }} />
            </div>
            <Button variant="outline" className="settings-preview-toggle" aria-expanded={previewOpen} aria-controls={`settings-preview-${providerId}`} onClick={() => setPreviewOpen(open => !open)}><Eye size={16} aria-hidden="true" />{previewOpen ? locale === "ja" ? "表示例を閉じる" : "Close example" : locale === "ja" ? "Discordの表示例を見る" : "Preview on Discord"}</Button>
          </div>
          <div className="settings-categories" role="group" aria-label={locale === "ja" ? "設定の目的" : "Setting purpose"}>
            <Button variant={category === "common" ? "default" : "outline"} aria-pressed={category === "common"} onClick={() => { setCategory("common"); setQuery(""); setChangedOnly(false); }}>{locale === "ja" ? "よく使う設定" : "Common settings"}</Button>
            <Button variant={category === "all" && !query && !changedOnly ? "default" : "outline"} aria-pressed={category === "all" && !query && !changedOnly} onClick={() => { setCategory("all"); setQuery(""); setChangedOnly(false); }}>{locale === "ja" ? "すべての設定" : "All settings"}<span className="text-xs opacity-75">{settings.length}{locale === "ja" ? "件" : ""}</span></Button>
            {["output", "media", "targetControl", "buttons"].filter(item => categories.includes(item)).map(item => <Button key={item} variant={category === item ? "default" : "outline"} aria-pressed={category === item} onClick={() => { setCategory(item); setQuery(""); setChangedOnly(false); }}>{categoryLabel(item, locale)}</Button>)}
          </div>
          <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-sm">{locale === "ja" ? "設定の種類" : "Category"}<select className="min-h-11 max-w-full rounded border bg-background px-2 py-2" value={category} onChange={event => setCategory(event.target.value)}><option value="common">{locale === "ja" ? "よく使う設定" : "Common settings"}</option><option value="all">{locale === "ja" ? "すべて" : "All"}</option>{categories.map(item => <option key={item} value={item}>{categoryLabel(item, locale)}</option>)}</select></label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={changedOnly} onChange={event => { setChangedOnly(event.target.checked); if (event.target.checked) setCategory("all"); }} />{locale === "ja" ? "編集中の設定だけ" : "Unsaved changes only"}</label><span role="status" className="text-xs text-muted-foreground">{locale === "ja" ? `${filteredSettings.length}件を表示 全${settings.length}件` : `Showing ${filteredSettings.length} of ${settings.length} settings`}</span></div>
        </section>

        <div className="space-y-3">
          {!filteredSettings.length && <div className="rounded border bg-card p-5 text-sm"><p>{locale === "ja" ? "条件に一致する設定がありません。" : "No settings match these filters."}</p><Button variant="outline" className="mt-3" onClick={() => { setQuery(""); setCategory("all"); setChangedOnly(false); }}>{locale === "ja" ? "検索条件をクリア" : "Clear filters"}</Button></div>}
          {settings.map((setting) => (
            <div key={setting.key} hidden={!filteredSettings.some(filtered => filtered.key === setting.key)}>
            <SettingEditor
              providerId={providerId}
              setting={setting}
              value={watched[setting.key]}
              values={watched}
              setValue={(value) => form.setValue(setting.key, value, { shouldDirty: true })}
              disabled={!canEdit || formBusy}
              onValidityChange={setValidity}
              resetKey={`${draftKey}:${discardSequence}`}
              locale={locale}
              changed={Object.hasOwn(changes, setting.key)}
            />
            </div>
          ))}
        </div>
        {showResetProvider ? <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium text-muted-foreground">{locale === "ja" ? "設定を初期値に戻す" : "Restore default settings"}</summary><div className="mt-3 space-y-3"><p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{locale === "ja" ? `${providerLabel}の保存済み設定と編集中の変更を置き換えます。` : `Replaces saved settings and unsaved edits for ${providerLabel}.`}</p>{!canReset ? <p className="text-sm text-muted-foreground">{locale === "ja" ? "初期化にはサーバー管理権限が必要" : "Manage Server permission required to reset"}</p> : null}<Button variant="destructive" disabled={!canReset || formBusy} onClick={resetProvider}><RotateCcw size={16} aria-hidden="true" />{t("form.resetProvider")}</Button></div></details> : null}
      </div>

      <aside className="min-w-0 space-y-4">
        {hasChanges ? <Card>
          <CardHeader>
            <CardTitle>{t("form.diffTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(changes).length ? (
              Object.entries(changes).map(([key, value]) => {
                const setting = settings.find((item) => item.key === key);
                return (
                  <div key={key} className="min-w-0 rounded-md border p-2 text-sm">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                      <button type="button" className="min-w-0 break-words text-left font-medium underline decoration-muted-foreground/40 underline-offset-4" onClick={() => revealSetting(key)}>{setting ? settingTitle(setting, locale) : key}</button>
                      <Badge tone={setting?.spec.impactLevel === "danger" ? "danger" : setting?.spec.impactLevel === "high" ? "warning" : "muted"}>{impactLabel(setting?.spec.impactLevel, locale)}</Badge>
                    </div>
                    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-muted-foreground"><dt className="text-xs">{locale === "ja" ? "現在" : "Current"}</dt><dd className="settings-summary-value">{settingDisplayValue(setting, savedValues[key], locale)}</dd><dt className="text-xs">{locale === "ja" ? "変更後" : "After"}</dt><dd className="settings-summary-value text-foreground">{settingDisplayValue(setting, value, locale)}</dd></dl>
                  </div>
                );
              })
            ) : (
              <div className="text-sm text-muted-foreground">{t("form.noDiff")}</div>
            )}
          </CardContent>
        </Card> : null}

        {previewOpen ? <Card id={`settings-preview-${providerId}`}>
          <CardHeader>
            <div className="flex items-center justify-between gap-2"><CardTitle>{locale === "ja" ? "Discordの表示例" : "Discord example"}</CardTitle><Button size="sm" variant="ghost" aria-label={locale === "ja" ? "表示例を閉じる" : "Close example"} onClick={() => setPreviewOpen(false)}><X size={16} aria-hidden="true" /></Button></div>
            <CardDescription>{locale === "ja" ? "サンプル投稿 · 保存前の変更も反映" : "Sample post · Includes unsaved changes"}</CardDescription>
          </CardHeader>
          <CardContent>
            <OutputPreviewCard preview={preview} locale={locale} />
          </CardContent>
        </Card> : null}
      </aside>
    </div>
  );
}

function SettingEditor({
  providerId,
  setting,
  value,
  values,
  setValue,
  disabled,
  locale,
  onValidityChange,
  resetKey,
  changed,
}: {
  providerId: string;
  setting: SettingState;
  value: SettingValue;
  values: Record<string, SettingValue | undefined>;
  setValue: (value: SettingValue) => void;
  disabled: boolean;
  locale: DashboardLocale;
  onValidityChange: (key: string, valid: boolean) => void;
  resetKey: string;
  changed: boolean;
}) {
  const spec = setting.spec;
  const headingId = useId();
  const updateValidity = useCallback((valid: boolean) => onValidityChange(setting.key, valid), [onValidityChange, setting.key]);
  const showImpact = spec.impactLevel === "danger" || spec.impactLevel === "high";
  const commands = settingCommandsForValue(providerId, setting, value, values);
  const hint = settingHint(providerId, setting, locale);
  const destructiveHint = setting.key.includes("deletemessage") || setting.key === "bannedWords" && providerId === "twitter";
  return (
    <Card id={`setting-${encodeURIComponent(setting.key)}`} tabIndex={-1} aria-labelledby={headingId} data-changed={changed} data-complex={!["bool", "providerEnabled", "choice"].includes(spec.kind)} className="settings-editor scroll-mt-48">
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle id={headingId}>{settingTitle(setting, locale)}</CardTitle>
            {hint ? <CardDescription className={`flex items-start gap-2 ${destructiveHint ? "text-destructive" : ""}`}>{destructiveHint ? <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> : <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}<span>{hint}</span></CardDescription> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {showImpact ? (
              <Badge tone={spec.impactLevel === "danger" ? "danger" : "warning"}>{impactLabel(spec.impactLevel, locale)}</Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {renderControl(setting, value, setValue, disabled, locale, updateValidity, resetKey)}
        {commands.length ? <SettingCommandList commands={commands} locale={locale} /> : null}
        {setting.warnings.length ? (
          <div className="space-y-1 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
            {setting.warnings.map((warning) => <div key={warning}>{warning}</div>)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SettingCommandList({ commands, locale }: { commands: SettingCommand[]; locale: DashboardLocale }) {
  const t = createTranslator(locale);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  async function writeClipboard(command: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = command;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  async function copy(command: string) {
    await writeClipboard(command);
    setCopiedCommand(command);
    window.setTimeout(() => setCopiedCommand((current) => (current === command ? null : current)), 1600);
  }

  return (
    <details className="settings-command space-y-2 rounded-md border bg-muted/45 p-2 text-sm">
      <summary className="cursor-pointer font-medium text-muted-foreground">{locale === "ja" ? "Discordのコマンドを表示" : "Show Discord commands"}</summary>
      {commands.map(({ command }) => {
        const copied = copiedCommand === command;
        return (
          <div key={command} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded bg-card px-2 py-1 text-xs text-foreground">{command}</code>
            <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => copy(command)}>
              {copied ? <Check size={14} /> : <Clipboard size={14} />}
              {copied ? t("form.copiedCommand") : t("form.copyCommand")}
            </Button>
          </div>
        );
      })}
    </details>
  );
}

function renderControl(setting: SettingState, value: SettingValue, setValue: (value: SettingValue) => void, disabled: boolean, locale: DashboardLocale, onValidityChange: (valid: boolean) => void, resetKey: string) {
  const spec = setting.spec;
  const t = createTranslator(locale);
  if (spec.kind === "bool" || spec.kind === "providerEnabled") {
    return (
      <label className="flex min-w-0 items-center gap-2 text-sm">
        <input type="checkbox" aria-label={settingTitle(setting, locale)} checked={value === true} disabled={disabled} onChange={(event) => setValue(event.target.checked)} />
        {value === true ? locale === "ja" ? "オン" : "On" : locale === "ja" ? "オフ" : "Off"}
      </label>
    );
  }

  if (spec.kind === "choice") {
    return (
      <select aria-label={settingTitle(setting, locale)} className="min-h-11 w-full min-w-0 rounded-md border bg-card px-3 text-sm" value={String(value ?? "")} disabled={disabled} onChange={(event) => setValue(event.target.value)}>
        {spec.choices?.map((choice) => (
          <option key={choice.value} value={choice.value}>{settingChoiceTitle(setting, String(choice.value), locale)}</option>
        ))}
      </select>
    );
  }

  if (spec.kind === "multiChoice") {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <div className="grid gap-2 md:grid-cols-2">
        {spec.choices?.map((choice) => (
          <label key={choice.value} className="flex min-w-0 items-start gap-2 rounded-md border p-2 text-sm">
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.has(choice.value)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(choice.value);
                else next.delete(choice.value);
                setValue([...next]);
              }}
            />
            <span className="min-w-0 break-words font-medium">{labelText(choice.label, locale)}</span>
          </label>
        ))}
      </div>
    );
  }

  if (spec.kind === "bannedWords") {
    return <Textarea aria-label={settingTitle(setting, locale)} disabled={disabled} value={textareaList(value)} onChange={(event) => setValue(parseTextareaList(event.target.value))} placeholder={t("form.bannedWordsPlaceholder")} />;
  }

  if (spec.kind === "targets") {
    const targets = (value || { user: [], channel: [], role: [] }) as TargetSetting;
    return (
      <div className="grid gap-3 md:grid-cols-3">
        {(["user", "channel", "role"] as const).map((key) => (
          <label key={key} className="space-y-1 text-sm">
            <span className="font-medium">{targetLabel(key, locale)}</span>
            <Textarea
              disabled={disabled}
              value={targetTextarea(targets, key)}
              onChange={(event) => setValue({ ...targets, [key]: parseTextareaList(event.target.value) })}
              placeholder={t("form.idsPlaceholder", { target: targetLabel(key, locale) })}
            />
          </label>
        ))}
      </div>
    );
  }

  if (spec.kind === "buttonVisibility") {
    const visibility = (value || {}) as ButtonVisibility;
    const keys = Object.keys(visibility);
    return (
      <div className="grid gap-2 md:grid-cols-2">
        {keys.map((key) => (
          <label key={key} className="flex min-w-0 items-center gap-2 rounded-md border p-2 text-sm">
            <input type="checkbox" disabled={disabled} checked={visibility[key] === true} onChange={(event) => setValue({ ...visibility, [key]: event.target.checked })} />
            <span className="min-w-0 break-words">{t("form.hideButton", { key: buttonLabel(key, locale) })}</span>
          </label>
        ))}
      </div>
    );
  }

  if (spec.kind === "outputVisibility") {
    const selected = new Set(Array.isArray(value) ? value : []);
    return (
      <div className="grid gap-2 md:grid-cols-2">
        {spec.outputItems?.map((item) => (
          <label key={item.value} className="flex min-w-0 items-start gap-2 rounded-md border p-2 text-sm">
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.has(item.value)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(item.value);
                else next.delete(item.value);
                setValue([...next]);
              }}
            />
            <span className="min-w-0 break-words">
              <span className="font-medium">{labelText(item.label, locale)}</span>
              {item.description ? <span className="block text-xs text-muted-foreground">{labelText(item.description, locale)}</span> : null}
            </span>
          </label>
        ))}
      </div>
    );
  }

  if (spec.kind === "accountDepthMap") {
    return <AccountDepthMapEditor value={value} setValue={setValue} disabled={disabled} locale={locale} onValidityChange={onValidityChange} resetKey={resetKey} />;
  }

  return <div className="text-sm text-muted-foreground">{t("form.readOnlyKind")}</div>;
}

function AccountDepthMapEditor({
  value,
  setValue,
  disabled,
  locale,
  onValidityChange,
  resetKey,
}: {
  value: SettingValue;
  setValue: (value: SettingValue) => void;
  disabled: boolean;
  locale: DashboardLocale;
  onValidityChange: (valid: boolean) => void;
  resetKey: string;
}) {
  const t = createTranslator(locale);
  const errorId = useId();
  const rowIds = useRef(0);
  const fingerprint = (data: SettingValue | undefined) => JSON.stringify(accountDepthEntries(data));
  const serialized = fingerprint(value);
  const lastCommitted = useRef(serialized), lastResetKey = useRef(resetKey);
  const makeRows = () => accountDepthEntries(value).map(row => ({ ...row, id: rowIds.current++ }));
  const [rows, setRows] = useState(makeRows);
  const names = rows.map(row => normalizeAccountInput(row.account));
  const errors = rows.map((row, index) => !row.account.trim() ? locale === "ja" ? "アカウント名を入力してください。" : "Enter an account name."
    : !/^[a-z0-9_]{1,15}$/.test(names[index]) ? locale === "ja" ? "英数字・アンダースコアで15文字以内" : "Use up to 15 letters, numbers, or underscores."
      : names.filter(name => name === names[index]).length > 1 ? locale === "ja" ? "同じアカウントが重複しています。" : "This account is listed twice." : "");
  const valid = errors.every(error => !error);
  useEffect(() => { onValidityChange(valid); }, [valid, onValidityChange]);

  useEffect(() => {
    if (serialized === lastCommitted.current && resetKey === lastResetKey.current) return;
    lastCommitted.current = serialized; lastResetKey.current = resetKey;
    setRows(makeRows());
  }, [serialized, resetKey]);

  function commit(nextRows: Array<{ id: number; account: string; depth: number }>) {
    setRows(nextRows);
    const next: AccountDepthMap = {};
    for (const row of nextRows) {
      const account = normalizeAccountInput(row.account);
      if (!/^[a-z0-9_]{1,15}$/.test(account)) continue;
      if (!Number.isInteger(row.depth) || row.depth < 0) continue;
      next[account] = row.depth;
    }
    lastCommitted.current = fingerprint(next);
    setValue(next);
  }

  function updateRow(index: number, patch: Partial<{ account: string; depth: number }>) {
    commit(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2">
        {rows.map((row, index) => (
          <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
            <Input
              aria-label={locale === "ja" ? `アカウント名 ${index + 1}` : `Account name ${index + 1}`}
              aria-invalid={!!errors[index]}
              aria-describedby={errors[index] ? `${errorId}-${row.id}` : undefined}
              disabled={disabled}
              value={row.account}
              onChange={(event) => updateRow(index, { account: normalizeAccountInput(event.target.value) })}
              placeholder={t("form.accountPlaceholder")}
            />
            <select
              aria-label={locale === "ja" ? `引用展開数 ${index + 1}` : `Quote depth ${index + 1}`}
              className="min-h-11 rounded-md border bg-card px-3 text-sm"
              disabled={disabled}
              value={String(row.depth)}
              onChange={(event) => updateRow(index, { depth: Number(event.target.value) })}
            >
              {Array.from({ length: 11 }, (_value, depth) => (
                <option key={depth} value={depth}>{depth === 0 ? t("form.unlimitedDepth") : depth}</option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              title={t("form.removeAccount")}
              aria-label={t("form.removeAccount")}
              onClick={() => commit(rows.filter((_row, rowIndex) => rowIndex !== index))}
            >
              <Trash2 size={16} />
            </Button>
            {errors[index] && <p id={`${errorId}-${row.id}`} role="alert" className="text-xs text-destructive sm:col-span-3">{errors[index]}</p>}
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setRows([...rows, { id: rowIds.current++, account: "", depth: 1 }])}
      >
        <Plus size={16} />
        {t("form.addAccount")}
      </Button>
    </div>
  );
}
