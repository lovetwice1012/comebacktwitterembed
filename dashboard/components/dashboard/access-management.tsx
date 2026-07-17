"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, Search, Tags, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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

function levelLabel(level: AccessLevel) {
  return level === "edit" ? "編集" : "閲覧のみ";
}

function InitialAvatar({ member }: { member: Member }) {
  const initial = (member.nickname || member.username || "?").slice(0, 1).toUpperCase();
  if (member.avatarUrl) {
    return <img src={member.avatarUrl} alt="" className="h-10 w-10 shrink-0 rounded-full bg-muted object-cover" />;
  }
  return <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary">{initial}</span>;
}

export function AccessManagement({ guildId }: { guildId: string }) {
  const [data, setData] = useState<AccessResponse>(emptyResponse);
  const [query, setQuery] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<TargetType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (search: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/guilds/${guildId}/access?query=${encodeURIComponent(search)}`, {
        headers: { Accept: "application/json" },
      });
      const payload = await res.json().catch(() => null) as AccessResponse | { error?: string } | null;
      if (!res.ok) throw new Error(payload && "error" in payload ? payload.error || "アクセス情報を取得できませんでした。" : "アクセス情報を取得できませんでした。");
      if (!payload || !("enabled" in payload) || !("grants" in payload) || !("members" in payload) || !("roles" in payload)) {
        throw new Error("アクセス情報の応答が不正です。");
      }
      setData(payload as AccessResponse);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "アクセス情報を取得できませんでした。");
    } finally {
      setLoading(false);
    }
  }, [guildId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 250);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  const grantByTarget = useMemo(
    () => new Map(data.grants.map((grant) => [`${grant.targetType}:${grant.targetId}`, grant.accessLevel])),
    [data.grants],
  );
  const roles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return data.roles;
    return data.roles.filter((role) => role.name.toLocaleLowerCase().includes(normalized) || role.id.includes(normalized));
  }, [data.roles, query]);

  const save = async (targetType: TargetType, accessLevel: AccessLevel | null) => {
    const targetIds = targetType === "user" ? selectedUserIds : selectedRoleIds;
    if (targetIds.length === 0) return;
    setSaving(targetType);
    try {
      const res = await fetch(`/api/guilds/${guildId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ targetType, targetIds, accessLevel }),
      });
      const payload = await res.json().catch(() => null) as Pick<AccessResponse, "enabled" | "grants"> | { error?: string } | null;
      if (!res.ok) throw new Error(payload && "error" in payload ? payload.error || "アクセス権を保存できませんでした。" : "アクセス権を保存できませんでした。");
      if (!payload || !("enabled" in payload) || !("grants" in payload)) throw new Error("アクセス権保存の応答が不正です。");
      setData((current) => ({ ...current, enabled: payload.enabled, grants: payload.grants }));
      if (targetType === "user") setSelectedUserIds([]);
      else setSelectedRoleIds([]);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "アクセス権を保存できませんでした。");
    } finally {
      setSaving(null);
    }
  };

  if (!data.enabled && !loading) {
    return <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">委任アクセスは現在無効です。Members Intent の承認後に機能フラグを有効化してください。</p>;
  }

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">ダッシュボードアクセス管理</h1>
        <p className="text-sm text-muted-foreground">ユーザーまたはロールに閲覧・編集アクセスを付与します。アクセス管理自体はサーバー管理者だけが行えます。</p>
      </header>

      {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
      {data.directoryError ? <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{data.directoryError}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Users size={18} />ユーザーを検索して追加</CardTitle>
          <CardDescription>ユーザー名、ニックネーム、またはユーザーIDで検索します。検索結果はDiscordから取得します。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="ユーザー名、ニックネーム、ユーザーIDで検索" aria-label="ユーザーまたはロールを検索" />
          </div>
          <div className="rounded-md border">
            {loading ? <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16} />検索中…</p> : null}
            {!loading && query.trim() && data.members.length === 0 ? <p className="p-4 text-sm text-muted-foreground">一致するユーザーはいません。</p> : null}
            {data.members.map((member) => {
              const level = grantByTarget.get(`user:${member.id}`);
              return (
                <label key={member.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0">
                  <input type="checkbox" checked={selectedUserIds.includes(member.id)} onChange={() => setSelectedUserIds((ids) => toggleId(ids, member.id))} aria-label={`${member.username} を選択`} />
                  <span className="flex min-w-0 items-center gap-3">
                    <InitialAvatar member={member} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{member.username}</span>
                      <span className="block truncate text-sm text-muted-foreground">ニックネーム: {member.nickname || "未設定"} <span className="hidden md:inline">・{member.id}</span></span>
                    </span>
                  </span>
                  {level ? <Badge tone={level === "edit" ? "success" : "muted"}>{levelLabel(level)}</Badge> : <Badge tone="muted">未付与</Badge>}
                </label>
              );
            })}
            {!query.trim() && !loading ? <p className="p-4 text-sm text-muted-foreground">検索語を入力するとユーザーが表示されます。</p> : null}
          </div>
          <ActionButtons count={selectedUserIds.length} busy={saving === "user"} onSave={(level) => void save("user", level)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Tags size={18} />ロールを選択して追加</CardTitle>
          <CardDescription>ロールが付与されたメンバー全員にアクセスを付与します。@everyone は選べません。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border">
            {roles.map((role) => {
              const level = grantByTarget.get(`role:${role.id}`);
              return (
                <label key={role.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0">
                  <input type="checkbox" checked={selectedRoleIds.includes(role.id)} onChange={() => setSelectedRoleIds((ids) => toggleId(ids, role.id))} aria-label={`${role.name} を選択`} />
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="h-4 w-4 shrink-0 rounded-full border" style={{ backgroundColor: role.color || "transparent" }} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">@{role.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">{role.managed ? "連携ロール" : "通常ロール"} ・{role.id}</span>
                    </span>
                  </span>
                  {level ? <Badge tone={level === "edit" ? "success" : "muted"}>{levelLabel(level)}</Badge> : <Badge tone="muted">未付与</Badge>}
                </label>
              );
            })}
            {!loading && roles.length === 0 ? <p className="p-4 text-sm text-muted-foreground">一致するロールはありません。</p> : null}
          </div>
          <ActionButtons count={selectedRoleIds.length} busy={saving === "role"} onSave={(level) => void save("role", level)} />
        </CardContent>
      </Card>
    </div>
  );
}

function ActionButtons({ count, busy, onSave }: { count: number; busy: boolean; onSave: (level: AccessLevel | null) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span>{count} 件を選択中</span>
      <div className="flex flex-wrap gap-2">
        <Button disabled={count === 0 || busy} size="sm" variant="outline" onClick={() => onSave("view")}>閲覧のみを一括付与</Button>
        <Button disabled={count === 0 || busy} size="sm" onClick={() => onSave("edit")}>編集を一括付与</Button>
        <Button disabled={count === 0 || busy} size="sm" variant="destructive" onClick={() => onSave(null)}>アクセスを一括削除</Button>
      </div>
    </div>
  );
}
