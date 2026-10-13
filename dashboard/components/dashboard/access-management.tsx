"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, LockKeyhole, RotateCcw, Search, Tags, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { DashboardLocale } from "@/lib/i18n";

type AccessLevel = "view" | "edit";
type TargetType = "user" | "role";

type Grant = {
  guildId: string;
  targetType: TargetType;
  targetId: string;
  accessLevel: AccessLevel;
  grantedByUserId: string;
};

type Member = {
  id: string;
  username: string;
  nickname: string | null;
  avatarUrl: string | null;
};

type Role = {
  id: string;
  name: string;
  color: string | null;
  managed: boolean;
  position: number;
};

type AccessResponse = {
  enabled: boolean;
  grants: Grant[];
  members: Member[];
  roles: Role[];
  directoryError: string | null;
};

const emptyResponse: AccessResponse = {
  enabled: true,
  grants: [],
  members: [],
  roles: [],
  directoryError: null,
};

function toggleId(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

function levelLabel(level: AccessLevel, ja: boolean) {
  return level === "edit" ? ja ? "編集" : "Edit" : ja ? "閲覧のみ" : "View only";
}

function InitialAvatar({ member }: { member: Member }) {
  const initial = (member.nickname || member.username || "?").slice(0, 1).toUpperCase();
  if (member.avatarUrl) {
    return <img src={member.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full bg-muted object-cover" />;
  }
  return <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary">{initial}</span>;
}

export function AccessManagement({ guildId, locale = "ja" }: { guildId: string; locale?: DashboardLocale }) {
  const ja = locale === "ja";
  const [data, setData] = useState<AccessResponse>(emptyResponse);
  const [targetType, setTargetType] = useState<TargetType>("user"), [roleQuery, setRoleQuery] = useState("");
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<TargetType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; names: string[] } | null>(null);
  const loadSequence = useRef(0), saveInFlight = useRef(false), currentGuild = useRef(guildId), scopeGeneration = useRef(0);
  currentGuild.current = guildId;

  const load = useCallback(async (search: string) => {
    if (saveInFlight.current) return;
    const sequence = ++loadSequence.current;
    const current = () => sequence === loadSequence.current && currentGuild.current === guildId;
    const fallback = ja ? "アクセス情報を読み込めません。再読み込みしてください。" : "Could not load access. Try reloading.";
    setLoading(true);
    try {
      const res = await fetch(`/api/guilds/${guildId}/access?query=${encodeURIComponent(search)}`, {
        headers: { Accept: "application/json" },
      });
      const payload = await res.json().catch(() => null) as AccessResponse | { error?: string } | null;
      if (!current()) return;
      if (!res.ok) { setError(payload && "error" in payload ? payload.error || fallback : fallback); return; }
      if (!payload || !("enabled" in payload) || !Array.isArray(payload.grants) || !Array.isArray(payload.members) || !Array.isArray(payload.roles)) { setError(fallback); return; }
      setData(payload as AccessResponse);
      setError(null);
    } catch {
      if (current()) setError(fallback);
    } finally {
      if (current()) setLoading(false);
    }
  }, [guildId, ja]);

  useEffect(() => { scopeGeneration.current++; setData(emptyResponse); setSelectedUserIds([]); setSelectedRoleIds([]); setQuery(""); setLookup(""); setRoleQuery(""); setStatus(null); setError(null); setSaving(null); saveInFlight.current = false; return () => { scopeGeneration.current++; }; }, [guildId]);
  useEffect(() => {
    void load(lookup);
    return () => { loadSequence.current++; };
  }, [load, lookup]);

  const grantByTarget = useMemo(
    () => new Map(data.grants.map((grant) => [`${grant.targetType}:${grant.targetId}`, grant.accessLevel])),
    [data.grants],
  );
  const roles = data.roles.filter(role => `${role.name} ${role.id}`.toLowerCase().includes(roleQuery.trim().toLowerCase()));

  const save = async (targetType: TargetType, accessLevel: AccessLevel | null) => {
    const targetIds = targetType === "user" ? selectedUserIds : selectedRoleIds;
    if (targetIds.length === 0 || targetIds.length > 100 || saveInFlight.current || loading) return;
    const scope = guildId;
    const epoch = scopeGeneration.current;
    const current = () => currentGuild.current === scope && scopeGeneration.current === epoch;
    const names = targetType === "user" ? targetIds.map(id => { const member = data.members.find(item => item.id === id); return member?.nickname || member?.username || id; }) : targetIds.map(id => data.roles.find(item => item.id === id)?.name || id);
    loadSequence.current++;
    saveInFlight.current = true;
    setSaving(targetType);
    setStatus(null);
    const fallback = ja ? "権限を変更できませんでした。接続と権限を確認して再試行してください。" : "Could not change access. Check your connection and permissions, then retry.";
    try {
      const res = await fetch(`/api/guilds/${guildId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ targetType, targetIds, accessLevel }),
      });
      const payload = await res.json().catch(() => null) as Pick<AccessResponse, "enabled" | "grants"> | { error?: string } | null;
      if (!current()) return;
      if (!res.ok) { setError(payload && "error" in payload ? payload.error || fallback : fallback); return; }
      if (!payload || !("enabled" in payload) || !Array.isArray(payload.grants)) { setError(fallback); return; }
      setData((current) => ({ ...current, enabled: payload.enabled, grants: payload.grants }));
      if (targetType === "user") setSelectedUserIds([]);
      else setSelectedRoleIds([]);
      setError(null);
      setStatus({ names, text: accessLevel === null ? ja ? `${targetIds.length}件の追加権限を解除しました。` : `Removed additional access for ${targetIds.length} targets.` : ja ? `${targetIds.length}件に${levelLabel(accessLevel, ja)}を許可しました。` : `Allowed ${levelLabel(accessLevel, ja).toLowerCase()} access for ${targetIds.length} targets.` });
    } catch {
      if (current()) setError(fallback);
    } finally {
      if (current()) { setSaving(null); saveInFlight.current = false; }
    }
  };

  if (!data.enabled && !loading) {
    return <p className="flex items-start gap-2 rounded-md border p-4 text-sm text-muted-foreground"><LockKeyhole size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{ja ? "このサーバーでは追加のアクセス権を付与できません。" : "Additional dashboard access is unavailable for this server."}</p>;
  }

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{ja ? "ダッシュボードのアクセス" : "Dashboard access"}</h1>
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole size={16} aria-hidden />{ja ? "権限を変更できるのはサーバー管理者のみ" : "Only server managers can change access"}</p>
      </header>

      {error ? <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" disabled={loading || saving !== null} onClick={() => void load(lookup)}><RotateCcw size={16} aria-hidden="true" />{ja ? "アクセス情報を再読み込み" : "Reload access"}</Button></div> : null}
      {status ? <div role="status" className="space-y-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900"><p className="flex items-center gap-2"><Check size={16} aria-hidden="true" />{status.text}</p><div className="flex flex-wrap gap-2">{status.names.map(name => <span key={name} className="rounded border border-green-300 px-2 py-1">{name}</span>)}</div></div> : null}
      {data.directoryError ? <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3"><p className="flex items-start gap-2 text-sm text-amber-900"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{data.directoryError.includes("role") ? ja ? "ロールを取得できません。再読み込みしてください。" : "Could not load roles. Try reloading." : ja ? "Discordから対象を取得できません。ユーザーIDを確認して再検索してください。" : "Could not retrieve Discord targets. Check the user ID and search again."}</p><Button variant="outline" disabled={loading || saving !== null} onClick={() => void load(lookup)}><RotateCcw size={16} aria-hidden="true" />{ja ? "対象を再読み込み" : "Reload targets"}</Button></div> : null}
      <div role="group" aria-label={ja ? "権限を付与する対象" : "Access target type"} className="flex flex-wrap gap-2"><Button variant={targetType === "user" ? "default" : "outline"} aria-pressed={targetType === "user"} disabled={saving !== null} onClick={() => setTargetType("user")}><Users size={16} aria-hidden="true" />{ja ? "ユーザー" : "Users"}</Button><Button variant={targetType === "role" ? "default" : "outline"} aria-pressed={targetType === "role"} disabled={saving !== null} onClick={() => setTargetType("role")}><Tags size={16} aria-hidden="true" />{ja ? "ロール" : "Roles"}</Button></div>

      <Card hidden={targetType !== "user"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Users size={18} />{ja ? "ユーザーに権限を付与" : "Grant access to users"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); setLookup(query.trim()); }}>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
              <Input value={query} disabled={saving !== null} onChange={(event) => { const value = event.target.value; setQuery(value); if (!value.trim()) setLookup(""); }} className="pl-9" placeholder={ja ? "Discord ユーザーID" : "Discord user ID"} aria-label={ja ? "Discord ユーザーID" : "Discord user ID"} inputMode="numeric" aria-invalid={!!query.trim() && !/^\d{16,24}$/.test(query.trim())} />
            </div>
            <Button type="submit" disabled={!/^\d{16,24}$/.test(query.trim()) || loading || saving !== null}><Search size={16} />{ja ? "ユーザーを検索" : "Find user"}</Button>
          </form>
          {query.trim() && !/^\d{16,24}$/.test(query.trim()) ? <p className="text-xs text-destructive">{ja ? "ユーザーIDは16〜24桁の数字" : "Use a 16–24 digit user ID"}</p> : null}
          <div className="rounded-md border">
            {loading ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16} />{ja ? "検索中…" : "Searching…"}</p> : null}
            {!loading && lookup && data.members.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{ja ? "ユーザーIDを確認して再検索" : "Check the user ID and search again"}</p> : null}
            {!loading && data.members.map((member) => {
              const level = grantByTarget.get(`user:${member.id}`);
              return (
                <label key={member.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0">
                  <input type="checkbox" disabled={loading || saving !== null || selectedUserIds.length >= 100 && !selectedUserIds.includes(member.id)} checked={selectedUserIds.includes(member.id)} onChange={() => setSelectedUserIds((ids) => toggleId(ids, member.id))} aria-label={ja ? `${member.username} を選択` : `Select ${member.username}`} />
                  <span className="flex min-w-0 items-center gap-3">
                    <InitialAvatar member={member} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{member.username}</span>
                      {member.nickname && <span className="block truncate text-sm text-muted-foreground">{member.nickname}</span>}
                      <span className="hidden truncate text-xs text-muted-foreground md:block">{member.id}</span>
                    </span>
                  </span>
                  {level ? <Badge tone={level === "edit" ? "success" : "muted"}>{levelLabel(level, ja)}</Badge> : <Badge tone="muted">{ja ? "追加権限なし" : "No added access"}</Badge>}
                </label>
              );
            })}
          </div>
          <ActionButtons names={selectedUserIds.map(id => data.members.find(member => member.id === id)?.username || id)} busy={saving !== null || loading} locale={locale} onClear={() => setSelectedUserIds([])} onSave={(level) => void save("user", level)} />
        </CardContent>
      </Card>

      <Card hidden={targetType !== "role"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Tags size={18} />{ja ? "ロールに権限を付与" : "Grant access to roles"}</CardTitle>
          <CardDescription className="flex items-center gap-2"><Users size={16} aria-hidden />{ja ? "選んだロールのメンバー全員に適用" : "Applies to every member of the selected roles"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative"><Search size={16} className="pointer-events-none absolute left-3 top-3 text-muted-foreground" aria-hidden="true" /><Input className="pl-9" placeholder={ja ? "ロール名・IDを検索" : "Search role names or IDs"} aria-label={ja ? "ロール名・IDを検索" : "Search role names or IDs"} value={roleQuery} onChange={event => setRoleQuery(event.target.value)} disabled={saving !== null} /></div>
          <div className="rounded-md border">
            {loading ? <p role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16} />{ja ? "読み込み中…" : "Loading…"}</p> : null}
            {!loading && roles.map((role) => {
              const level = grantByTarget.get(`role:${role.id}`);
              return (
                <label key={role.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0">
                  <input type="checkbox" disabled={loading || saving !== null || selectedRoleIds.length >= 100 && !selectedRoleIds.includes(role.id)} checked={selectedRoleIds.includes(role.id)} onChange={() => setSelectedRoleIds((ids) => toggleId(ids, role.id))} aria-label={ja ? `${role.name}（${role.id}）を選択` : `Select ${role.name} (${role.id})`} />
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="h-4 w-4 shrink-0 rounded-full border" style={{ backgroundColor: role.color || "transparent" }} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">@{role.name}</span>
                      {role.managed ? <span className="block truncate text-sm text-muted-foreground">{ja ? "連携ロール" : "Integration role"}</span> : null}
                    </span>
                  </span>
                  {level ? <Badge tone={level === "edit" ? "success" : "muted"}>{levelLabel(level, ja)}</Badge> : <Badge tone="muted">{ja ? "追加権限なし" : "No added access"}</Badge>}
                </label>
              );
            })}
            {!loading && roles.length === 0 && roleQuery ? <Button className="m-3" variant="outline" onClick={() => setRoleQuery("")}>{ja ? "ロール検索をクリア" : "Clear role search"}</Button> : null}
          </div>
          <ActionButtons names={selectedRoleIds.map(id => data.roles.find(role => role.id === id)?.name || id)} busy={saving !== null || loading} locale={locale} onClear={() => setSelectedRoleIds([])} onSave={(level) => void save("role", level)} />
        </CardContent>
      </Card>
    </div>
  );
}

function ActionButtons({ names, busy, onSave, onClear, locale }: { names: string[]; busy: boolean; onSave: (level: AccessLevel | null) => void; onClear: () => void; locale: DashboardLocale }) {
  const count = names.length, ja = locale === "ja";
  return (
    <div className="space-y-3 rounded-md bg-muted p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><span>{ja ? `${count}件を選択中` : `${count} selected`}</span>{count > 0 ? <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>{ja ? "選択を解除" : "Clear selection"}</Button> : null}</div>
      {count > 0 ? <div className="flex flex-wrap gap-2">{names.map((name, index) => <Badge key={`${name}:${index}`} tone="muted">{name}</Badge>)}</div> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" disabled={count === 0 || busy} variant="outline" onClick={() => onSave("view")}>{ja ? "閲覧を許可" : "Allow viewing"}</Button>
        <Button className="min-h-11" disabled={count === 0 || busy} onClick={() => onSave("edit")}>{ja ? "編集を許可" : "Allow editing"}</Button>
        <Button className="min-h-11" disabled={count === 0 || busy} variant="outline" onClick={() => onSave(null)}>{ja ? "追加した権限を解除" : "Remove added access"}</Button>
      </div>
    </div>
  );
}
