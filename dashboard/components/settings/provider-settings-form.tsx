"use client";

import { AlertTriangle, Check, Clipboard, Plus, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { OutputPreviewCard } from "@/components/preview/output-preview-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { createTranslator, impactLabel, labelText, type DashboardLocale, type TranslationKey, valueLabel } from "@/lib/i18n";
import { buildPreview } from "@/lib/settings-preview";
import { deepEqual } from "@/lib/settings-diff";
import { settingCommandsForValue, type SettingCommand } from "@/lib/setting-commands";
import type { AccountDepthMap, ButtonVisibility, SettingState, SettingValue, TargetSetting } from "@/lib/types";

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
  all: "form.button.all",
};

function targetLabel(target: keyof TargetSetting, locale: DashboardLocale) {
  return createTranslator(locale)(targetLabelKeys[target]);
}

function buttonLabel(key: string, locale: DashboardLocale) {
  const labelKey = buttonLabelKeys[key];
  return labelKey ? createTranslator(locale)(labelKey) : key;
}

export function ProviderSettingsForm({
  guildId,
  providerId,
  providerLabel,
  canEdit,
  settings,
  locale,
  draftKeyOverride,
  onSaveChanges,
  onSaved,
  showResetProvider = true,
}: {
  guildId: string;
  providerId: string;
  providerLabel: string;
  canEdit: boolean;
  settings: SettingState[];
  locale: DashboardLocale;
  draftKeyOverride?: string;
  onSaveChanges?: (changes: Record<string, SettingValue>) => Promise<{ warnings?: string[] } | void>;
  onSaved?: () => void;
  showResetProvider?: boolean;
}) {
  const router = useRouter();
  const t = createTranslator(locale);
  const defaults = useMemo(() => initialValues(settings), [settings]);
  const [savedValues, setSavedValues] = useState<FormValues>(defaults);
  const draftKey = draftKeyOverride || `dashboard:draft:${guildId}:${providerId}`;
  const form = useForm<FormValues>({ defaultValues: defaults });
  const watched = form.watch();
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSavedValues(defaults);
    form.reset(defaults);
  }, [defaults]);

  useEffect(() => {
    const raw = window.localStorage.getItem(draftKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as FormValues;
      form.reset({ ...defaults, ...parsed }, { keepDirty: true });
      setMessage(t("form.draftRestored"));
    } catch {
      window.localStorage.removeItem(draftKey);
    }
  }, [draftKey]);

  const changes = useMemo(() => {
    return Object.fromEntries(Object.entries(watched).filter(([key, value]) => !deepEqual(value, savedValues[key]))) as FormValues;
  }, [savedValues, watched]);
  const hasChanges = Object.keys(changes).length > 0;

  useEffect(() => {
    if (hasChanges) window.localStorage.setItem(draftKey, JSON.stringify(changes));
    else window.localStorage.removeItem(draftKey);
  }, [changes, draftKey, hasChanges]);

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
    if (!q) return settings;
    return settings.filter((setting) => {
      const haystack = [
        setting.key,
        labelText(setting.spec.label, locale),
        labelText(setting.spec.description, locale),
        setting.spec.category,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query, settings]);

  const previewStates = settings.map((setting) => ({
    ...setting,
    value: watched[setting.key] ?? setting.value,
  }));
  const preview = buildPreview(providerId, previewStates, locale);

  async function save() {
    const dangerousKeys = Object.keys(changes).filter((key) => settings.find((setting) => setting.key === key)?.spec.impactLevel === "danger");
    if (dangerousKeys.length && !confirm(t("form.dangerConfirm", { keys: dangerousKeys.join(", ") }))) return;
    setSaving(true);
    setMessage(null);
    try {
      let warnings: string[] = [];
      if (onSaveChanges) {
        const result = await onSaveChanges(changes);
        warnings = result?.warnings || [];
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
      window.localStorage.removeItem(draftKey);
      const nextValues = clone(watched);
      setSavedValues(nextValues);
      form.reset(nextValues);
      setMessage(warnings.length ? t("form.saveSuccessWarnings", { warnings: warnings.join(" ") }) : t("form.saveSuccess"));
      if (onSaved) onSaved();
      else router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("form.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function resetProvider() {
    if (!confirm(t("form.resetConfirm", { providerLabel }))) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/guilds/${guildId}/providers/${providerId}/reset`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("form.resetFailed"));
      window.localStorage.removeItem(draftKey);
      setMessage(t("form.resetSuccess"));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("form.resetFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-4">
        {hasChanges || message ? (
        <div className="rounded-lg border bg-card p-3 shadow-soft sm:sticky sm:top-16 sm:z-20">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="font-medium">{hasChanges ? t("form.unsavedCount", { count: Object.keys(changes).length }) : t("form.noUnsavedChanges")}</div>
              {hasChanges ? <div className="text-sm text-muted-foreground">{t("form.unsavedHelp")}</div> : null}
            </div>
            <div className="flex flex-wrap gap-2 sm:justify-end">
              <Button className="flex-1 sm:flex-none" variant="outline" onClick={() => form.reset(clone(savedValues))} disabled={!hasChanges || saving}>
                <RotateCcw size={16} />
                {t("form.discard")}
              </Button>
              <Button className="flex-1 sm:flex-none" onClick={save} disabled={!canEdit || !hasChanges || saving}>
                <Save size={16} />
                {t("form.save")}
              </Button>
            </div>
          </div>
          {message ? <div className="mt-2 text-sm text-muted-foreground">{message}</div> : null}
        </div>
        ) : null}

        <Card>
          <CardContent className="pt-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
              <Input className="pl-9" placeholder={t("form.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {filteredSettings.map((setting) => (
            <SettingEditor
              key={setting.key}
              providerId={providerId}
              setting={setting}
              value={watched[setting.key]}
              values={watched}
              setValue={(value) => form.setValue(setting.key, value, { shouldDirty: true })}
              disabled={!canEdit || saving}
              locale={locale}
            />
          ))}
        </div>
      </div>

      <aside className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>{t("form.diffTitle")}</CardTitle>
            <CardDescription>{t("form.diffDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(changes).length ? (
              Object.entries(changes).map(([key, value]) => {
                const setting = settings.find((item) => item.key === key);
                return (
                  <div key={key} className="min-w-0 rounded-md border p-2 text-sm">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                      <span className="min-w-0 break-words font-medium">{setting ? labelText(setting.spec.label, locale) : key}</span>
                      <Badge tone={setting?.spec.impactLevel === "danger" ? "danger" : setting?.spec.impactLevel === "high" ? "warning" : "muted"}>{impactLabel(setting?.spec.impactLevel, locale)}</Badge>
                    </div>
                    <div className="mt-1 break-words text-muted-foreground">{valueLabel(savedValues[key], locale)} → {valueLabel(value, locale)}</div>
                  </div>
                );
              })
            ) : (
              <div className="text-sm text-muted-foreground">{t("form.noDiff")}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("form.livePreview")}</CardTitle>
          </CardHeader>
          <CardContent>
            <OutputPreviewCard preview={preview} locale={locale} />
          </CardContent>
        </Card>

        {showResetProvider ? (
          <Button variant="destructive" className="w-full" disabled={!canEdit || saving} onClick={resetProvider}>
            <AlertTriangle size={16} />
            {t("form.resetProvider")}
          </Button>
        ) : null}
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
}: {
  providerId: string;
  setting: SettingState;
  value: SettingValue;
  values: Record<string, SettingValue | undefined>;
  setValue: (value: SettingValue) => void;
  disabled: boolean;
  locale: DashboardLocale;
}) {
  const spec = setting.spec;
  const showImpact = spec.impactLevel === "danger" || spec.impactLevel === "high";
  const commands = settingCommandsForValue(providerId, setting, value, values);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle>{labelText(spec.label, locale)}</CardTitle>
            <CardDescription>{labelText(spec.description, locale)}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {showImpact ? (
              <Badge tone={spec.impactLevel === "danger" ? "danger" : "warning"}>{impactLabel(spec.impactLevel, locale)}</Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {renderControl(setting, value, setValue, disabled, locale)}
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
    <div className="space-y-2 rounded-md border bg-muted/45 p-2 text-sm">
      <div className="font-medium text-muted-foreground">{t("form.commandLabel")}</div>
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
    </div>
  );
}

function renderControl(setting: SettingState, value: SettingValue, setValue: (value: SettingValue) => void, disabled: boolean, locale: DashboardLocale) {
  const spec = setting.spec;
  const t = createTranslator(locale);
  if (spec.kind === "bool" || spec.kind === "providerEnabled") {
    return (
      <label className="flex min-w-0 items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => setValue(event.target.checked)} />
        {t("form.enabled")}
      </label>
    );
  }

  if (spec.kind === "choice") {
    return (
      <select className="h-10 w-full min-w-0 rounded-md border bg-card px-3 text-sm" value={String(value ?? "")} disabled={disabled} onChange={(event) => setValue(event.target.value)}>
        {spec.choices?.map((choice) => (
          <option key={choice.value} value={choice.value}>{labelText(choice.label, locale)}</option>
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
    return <Textarea disabled={disabled} value={textareaList(value)} onChange={(event) => setValue(parseTextareaList(event.target.value))} placeholder={t("form.bannedWordsPlaceholder")} />;
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
    return <AccountDepthMapEditor value={value} setValue={setValue} disabled={disabled} locale={locale} />;
  }

  return <div className="text-sm text-muted-foreground">{t("form.readOnlyKind")}</div>;
}

function AccountDepthMapEditor({
  value,
  setValue,
  disabled,
  locale,
}: {
  value: SettingValue;
  setValue: (value: SettingValue) => void;
  disabled: boolean;
  locale: DashboardLocale;
}) {
  const t = createTranslator(locale);
  const serialized = JSON.stringify(value || {});
  const [rows, setRows] = useState(() => accountDepthEntries(value));

  useEffect(() => {
    setRows(accountDepthEntries(value));
  }, [serialized]);

  function commit(nextRows: Array<{ account: string; depth: number }>) {
    setRows(nextRows);
    const next: AccountDepthMap = {};
    for (const row of nextRows) {
      const account = normalizeAccountInput(row.account);
      if (!/^[a-z0-9_]{1,15}$/.test(account)) continue;
      if (!Number.isInteger(row.depth) || row.depth < 0) continue;
      next[account] = row.depth;
    }
    setValue(next);
  }

  function updateRow(index: number, patch: Partial<{ account: string; depth: number }>) {
    commit(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2">
        {rows.map((row, index) => (
          <div key={`${row.account || "new"}-${index}`} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
            <Input
              disabled={disabled}
              value={row.account}
              onChange={(event) => updateRow(index, { account: normalizeAccountInput(event.target.value) })}
              placeholder={t("form.accountPlaceholder")}
            />
            <select
              className="h-10 rounded-md border bg-card px-3 text-sm"
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
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => setRows([...rows, { account: "", depth: 1 }])}
      >
        <Plus size={16} />
        {t("form.addAccount")}
      </Button>
    </div>
  );
}
