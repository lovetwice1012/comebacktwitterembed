"use client";

import { Search, ShieldCheck, Tags, UserMinus, UserPlus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type MockMember = {
  id: string;
  username: string;
  nickname: string;
  avatar: string;
  access: "閲覧のみ" | "設定を編集";
};

type MockRole = {
  id: string;
  name: string;
  color: string;
  memberCount: number;
  access: "閲覧のみ" | "設定を編集";
};

const members: MockMember[] = [
  { id: "923456781234567890", username: "mio_kanade", nickname: "みお", avatar: "M", access: "設定を編集" },
  { id: "823456781234567891", username: "haru_dev", nickname: "はる（開発）", avatar: "H", access: "閲覧のみ" },
  { id: "723456781234567892", username: "sora_78", nickname: "そら", avatar: "S", access: "設定を編集" },
  { id: "623456781234567893", username: "rin_mod", nickname: "りん / モデレーター", avatar: "R", access: "閲覧のみ" },
  { id: "523456781234567894", username: "yuki_fox", nickname: "ゆき", avatar: "Y", access: "閲覧のみ" },
];

const roles: MockRole[] = [
  { id: "113456781234567890", name: "モデレーター", color: "#5865f2", memberCount: 8, access: "設定を編集" },
  { id: "213456781234567891", name: "コンテンツ管理", color: "#57f287", memberCount: 14, access: "閲覧のみ" },
  { id: "313456781234567892", name: "イベントスタッフ", color: "#fee75c", memberCount: 22, access: "閲覧のみ" },
];

function avatarDataUri(initial: string, index: number) {
  const colors = ["#7c3aed", "#0284c7", "#db2777", "#059669", "#ea580c"];
  const color = colors[index % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${color}"/><text x="32" y="41" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="29" font-weight="700">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function AccessManagementMock() {
  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">ダッシュボードアクセス管理</h1>
          <Badge tone="warning">モック・無効</Badge>
        </div>
        <p className="text-sm text-muted-foreground">サーバー管理権限を持つユーザーが、メンバーまたはロールへダッシュボードの閲覧・設定編集アクセスを付与する画面です。</p>
      </header>

      <Card className="border-amber-300 bg-amber-50/50">
        <CardHeader className="flex flex-row items-start gap-3 space-y-0">
          <ShieldCheck className="mt-0.5 shrink-0 text-amber-700" size={20} />
          <div>
            <CardTitle>Discord Members Intent の審査待ち</CardTitle>
            <CardDescription>スクリーンショット提出用に架空のメンバーを表示しています。実メンバーの検索、選択、権限変更、保存はすべて無効で、現在のアクセス判定には影響しません。</CardDescription>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Users size={18} />メンバーを検索して選択</CardTitle>
          <CardDescription>アイコン、ユーザー名、サーバーニックネームを確認して対象を選びます。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
              <Input disabled className="pl-9" placeholder="ユーザー名、ニックネーム、ユーザーIDで検索" aria-label="メンバー検索" />
            </div>
            <Button disabled variant="outline"><UserPlus size={16} />選択したメンバーに追加</Button>
            <Button disabled variant="destructive"><UserMinus size={16} />選択したメンバーから削除</Button>
          </div>
          <div className="rounded-md border">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-sm font-medium">
              <input disabled type="checkbox" aria-label="すべてのメンバーを選択" />
              <span>メンバー</span>
              <span>付与するアクセス</span>
            </div>
            {members.map((member, index) => (
              <label key={member.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0 opacity-70">
                <input disabled type="checkbox" aria-label={`${member.username} を選択`} />
                <span className="flex min-w-0 items-center gap-3">
                  <img src={avatarDataUri(member.avatar, index)} alt="" className="h-10 w-10 shrink-0 rounded-full" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{member.username}</span>
                    <span className="block truncate text-sm text-muted-foreground">ニックネーム: {member.nickname} <span className="hidden md:inline">· {member.id}</span></span>
                  </span>
                </span>
                <Badge tone={member.access === "設定を編集" ? "success" : "muted"}>{member.access}</Badge>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span>選択: 0 人（モック）</span>
            <div className="flex flex-wrap gap-2">
              <Button disabled size="sm" variant="outline">閲覧のみを一括付与</Button>
              <Button disabled size="sm">設定編集を一括付与</Button>
              <Button disabled size="sm" variant="destructive">アクセスを一括削除</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Tags size={18} />ロールを検索して選択</CardTitle>
          <CardDescription>ロールにアクセスを付与すると、そのロールを持つメンバーへ同じアクセスを適用する想定です。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 text-muted-foreground" size={16} />
              <Input disabled className="pl-9" placeholder="ロール名またはロールIDで検索" aria-label="ロール検索" />
            </div>
            <Button disabled variant="outline"><UserPlus size={16} />選択したロールに追加</Button>
            <Button disabled variant="destructive"><UserMinus size={16} />選択したロールから削除</Button>
          </div>
          <div className="rounded-md border">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-sm font-medium">
              <input disabled type="checkbox" aria-label="すべてのロールを選択" />
              <span>ロール</span>
              <span>付与するアクセス</span>
            </div>
            {roles.map((role) => (
              <label key={role.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 last:border-b-0 opacity-70">
                <input disabled type="checkbox" aria-label={`${role.name} を選択`} />
                <span className="flex min-w-0 items-center gap-3">
                  <span className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: role.color }} aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">@{role.name}</span>
                    <span className="block truncate text-sm text-muted-foreground">{role.memberCount} 人 · {role.id}</span>
                  </span>
                </span>
                <Badge tone={role.access === "設定を編集" ? "success" : "muted"}>{role.access}</Badge>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span>選択: 0 ロール（モック）</span>
            <div className="flex flex-wrap gap-2">
              <Button disabled size="sm" variant="outline">閲覧のみを一括付与</Button>
              <Button disabled size="sm">設定編集を一括付与</Button>
              <Button disabled size="sm" variant="destructive">アクセスを一括削除</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
