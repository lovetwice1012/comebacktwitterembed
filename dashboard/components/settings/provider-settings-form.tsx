"use client";

import { AlertTriangle, RotateCcw, Save, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { buildPreview } from "@/lib/settings-preview";
import { deepEqual, labelText, valueLabel } from "@/lib/settings-diff";
import type { ButtonVisibility, SettingState, SettingValue, TargetSetting } from "@/lib/types";

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

function targetTextarea(value: unknown, key: keyof TargetSetting) {
  const targets = value as TargetSetting;
  return Array.isArray(targets?.[key]) ? targets[key].join("\n") : "";
}

export function ProviderSettingsForm({
  guildId,
  providerId,
  providerLabel,
  canEdit,
  settings,
}: {
  guildId: string;
  providerId: string;
  providerLabel: string;
  canEdit: boolean;
  settings: SettingState[];
}) {
  const router = useRouter();
  const defaults = useMemo(() => initialValues(settings), [settings]);
  const draftKey = `dashboard:draft:${guildId}:${providerId}`;
  const form = useForm<FormValues>({ defaultValues: defaults });
  const watched = form.watch();
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem(draftKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as FormValues;
      form.reset({ ...defaults, ...parsed }, { keepDirty: true });
      setMessage("保存されていない下書きを復元しました。");
    } catch {
      window.localStorage.removeItem(draftKey);
    }
  }, [draftKey]);

  const changes = useMemo(() => {
    return Object.fromEntries(Object.entries(watched).filter(([key, value]) => !deepEqual(value, defaults[key]))) as FormValues;
  }, [defaults, watched]);
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
        setting.spec.dbColumn,
        labelText(setting.spec.label),
        labelText(setting.spec.description),
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
  const preview = buildPreview(providerId, previewStates);

  async function save() {
    const dangerousKeys = Object.keys(changes).filter((key) => settings.find((setting) => setting.key === key)?.spec.impactLevel === "danger");
    if (dangerousKeys.length && !confirm(`危険設定を変更します: ${dangerousKeys.join(", ")}`)) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/guilds/${guildId}/providers/${providerId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      window.localStorage.removeItem(draftKey);
      setMessage(json.warnings?.length ? `保存しました: ${json.warnings.join(" ")}` : "保存しました。");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  async function resetProvider() {
    if (!confirm(`${providerLabel} の設定をデフォルトへ戻します。`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/guilds/${guildId}/providers/${providerId}/reset`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Reset failed");
      window.localStorage.removeItem(draftKey);
      setMessage("provider設定をリセットしました。");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "リセットに失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <div className="sticky top-16 z-20 rounded-lg border bg-card p-3 shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">{hasChanges ? `${Object.keys(changes).length}件の未保存変更` : "未保存変更はありません"}</div>
              <div className="text-sm text-muted-foreground">保存前に差分と危険度を確認できます。</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => form.reset(clone(defaults))} disabled={!hasChanges || saving}>
                <RotateCcw size={16} />
                破棄
              </Button>
              <Button onClick={save} disabled={!canEdit || !hasChanges || saving}>
                <Save size={16} />
                保存
              </Button>
            </div>
          </div>
          {message ? <div className="mt-2 text-sm text-muted-foreground">{message}</div> : null}
        </div>

        <Card>
          <CardContent className="pt-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
              <Input className="pl-9" placeholder="設定キー、ラベル、DBカラムで検索" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {filteredSettings.map((setting) => (
            <SettingEditor key={setting.key} setting={setting} value={watched[setting.key]} setValue={(value) => form.setValue(setting.key, value, { shouldDirty: true })} disabled={!canEdit || saving} />
          ))}
        </div>
      </div>

      <aside className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>変更差分</CardTitle>
            <CardDescription>保存される値だけを表示します。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(changes).length ? (
              Object.entries(changes).map(([key, value]) => {
                const setting = settings.find((item) => item.key === key);
                return (
                  <div key={key} className="rounded-md border p-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{setting ? labelText(setting.spec.label) : key}</span>
                      <Badge tone={setting?.spec.impactLevel === "danger" ? "danger" : setting?.spec.impactLevel === "high" ? "warning" : "muted"}>{setting?.spec.impactLevel || "low"}</Badge>
                    </div>
                    <div className="mt-1 text-muted-foreground">{valueLabel(defaults[key])} → {valueLabel(value)}</div>
                  </div>
                );
              })
            ) : (
              <div className="text-sm text-muted-foreground">差分はありません。</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>ライブプレビュー</CardTitle>
            <CardDescription>{preview.density} / {preview.mediaMode}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border-l-4 border-primary bg-muted p-3">
              {preview.lines.map((line) => <div key={line} className="text-sm">{line}</div>)}
              <div className="mt-2 text-sm text-muted-foreground">{preview.media}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {preview.buttons.map((button) => <Badge key={button} tone="muted">{button}</Badge>)}
            </div>
          </CardContent>
        </Card>

        <Button variant="destructive" className="w-full" disabled={!canEdit || saving} onClick={resetProvider}>
          <AlertTriangle size={16} />
          providerをデフォルトへ戻す
        </Button>
      </aside>
    </div>
  );
}

function SettingEditor({
  setting,
  value,
  setValue,
  disabled,
}: {
  setting: SettingState;
  value: SettingValue;
  setValue: (value: SettingValue) => void;
  disabled: boolean;
}) {
  const spec = setting.spec;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>{labelText(spec.label)}</CardTitle>
            <CardDescription>{labelText(spec.description)}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={spec.impactLevel === "danger" ? "danger" : spec.impactLevel === "high" ? "warning" : "muted"}>{spec.impactLevel}</Badge>
            {spec.advanced ? <Badge tone="muted">advanced</Badge> : null}
            <Badge tone="muted">{spec.category}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {renderControl(setting, value, setValue, disabled)}
        <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
          <span>key: {setting.key}</span>
          <span>DB: {spec.dbColumn || "-"}</span>
          <span>default: {valueLabel(setting.defaultValue)}</span>
        </div>
        {setting.warnings.length ? (
          <div className="space-y-1 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
            {setting.warnings.map((warning) => <div key={warning}>{warning}</div>)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function renderControl(setting: SettingState, value: SettingValue, setValue: (value: SettingValue) => void, disabled: boolean) {
  const spec = setting.spec;
  if (spec.kind === "bool" || spec.kind === "providerEnabled") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => setValue(event.target.checked)} />
        {value === true ? "有効" : "無効"}
      </label>
    );
  }

  if (spec.kind === "choice") {
    return (
      <select className="h-10 w-full rounded-md border bg-card px-3 text-sm" value={String(value ?? "")} disabled={disabled} onChange={(event) => setValue(event.target.value)}>
        {spec.choices?.map((choice) => (
          <option key={choice.value} value={choice.value}>{labelText(choice.label)}</option>
        ))}
      </select>
    );
  }

  if (spec.kind === "bannedWords") {
    return <Textarea disabled={disabled} value={textareaList(value)} onChange={(event) => setValue(parseTextareaList(event.target.value))} placeholder="1行に1語、またはCSV貼り付け" />;
  }

  if (spec.kind === "targets") {
    const targets = (value || { user: [], channel: [], role: [] }) as TargetSetting;
    return (
      <div className="grid gap-3 md:grid-cols-3">
        {(["user", "channel", "role"] as const).map((key) => (
          <label key={key} className="space-y-1 text-sm">
            <span className="font-medium">{key}</span>
            <Textarea
              disabled={disabled}
              value={targetTextarea(targets, key)}
              onChange={(event) => setValue({ ...targets, [key]: parseTextareaList(event.target.value) })}
              placeholder={`${key} IDs`}
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
          <label key={key} className="flex items-center gap-2 rounded-md border p-2 text-sm">
            <input type="checkbox" disabled={disabled} checked={visibility[key] === true} onChange={(event) => setValue({ ...visibility, [key]: event.target.checked })} />
            {key} を非表示
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
          <label key={item.value} className="flex items-start gap-2 rounded-md border p-2 text-sm">
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
            <span>
              <span className="font-medium">{labelText(item.label)}</span>
              <span className="block text-xs text-muted-foreground">{item.value}</span>
            </span>
          </label>
        ))}
      </div>
    );
  }

  return <div className="text-sm text-muted-foreground">この設定種別は表示専用です。</div>;
}
