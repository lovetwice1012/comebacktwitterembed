"use client";

import { ArrowRight, ArrowRightLeft, Check, MoreHorizontal, Search, Server, Settings2, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { pushGuildSelection } from "@/components/dashboard/guild-options";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTranslator, type DashboardLocale } from "@/lib/i18n";

export type DashboardGuild = {
  guildId: string;
  name: string;
  iconUrl: string | null;
  canEdit: boolean;
  canManageGuild: boolean;
  permissions: { administrator: boolean; manageGuild: boolean; manageChannels: boolean };
  providerSummary: { enabled: number; disabled: number; total: number } | null;
};
const BOT_INVITE_URL = "https://discord.com/oauth2/authorize?client_id=1161267455335862282&permissions=274877958144&scope=bot%20applications.commands";

export function GuildList({ guilds, locale }: { guilds: DashboardGuild[]; locale: DashboardLocale }) {
  const t = createTranslator(locale), ja = locale === "ja", router = useRouter();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"browse" | "copy" | "bulk">("browse");
  const [sourceGuildId, setSourceGuildId] = useState("");
  const [targetGuildIds, setTargetGuildIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? guilds.filter(guild => guild.name.toLowerCase().includes(q) || guild.guildId.includes(q)) : guilds;
  }, [guilds, query]);
  const sourceGuild = guilds.find(guild => guild.guildId === sourceGuildId);
  function resetMode() { setMode("browse"); setSourceGuildId(""); setTargetGuildIds([]); }
  function toggleTarget(id: string, checked: boolean) { setTargetGuildIds(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id)); setMessage(null); }
  async function copySettings() {
    if (!sourceGuild || !targetGuildIds.length || busy) return;
    if (!confirm(t("guildList.copyConfirm", { source: sourceGuild.name, count: targetGuildIds.length }))) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/guilds/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceGuildId, targetGuildIds }) });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error("copy-failed");
      setMessage({ text: t("guildList.copyDone", { count: result.targetCount ?? targetGuildIds.length }) }); resetMode(); router.refresh();
    } catch { setMessage({ text: ja ? "設定をコピーできませんでした。コピー先の状態を確認してから再試行してください。" : "Could not copy settings. Check the destination servers before retrying.", error: true }); }
    finally { setBusy(false); }
  }
  return <div className="guild-directory">
    <div className="guild-directory-toolbar"><div className="guild-directory-search"><Search size={17} aria-hidden /><Input type="search" aria-label={t("guildList.searchPlaceholder")} placeholder={t("guildList.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} /></div>
      {mode === "browse" && guilds.filter(guild => guild.canManageGuild).length > 1 ? <Button variant="outline" onClick={() => { setMode("bulk"); setMessage(null); }}><Settings2 size={16} aria-hidden />{ja ? "複数サーバーを変更" : "Edit multiple servers"}</Button> : null}
      {guilds.some(guild => !guild.providerSummary || guild.providerSummary.total === 0) ? <Button variant="outline" onClick={() => router.refresh()}>{ja ? "件数を再取得" : "Reload service counts"}</Button> : null}
    </div>
    {message ? <div className={`guild-directory-result${message.error ? " is-error" : ""}`} role={message.error ? "alert" : "status"}>{message.error ? <ShieldCheck size={17} aria-hidden /> : <Check size={17} aria-hidden />}{message.text}</div> : null}
    {mode !== "browse" ? <section className="guild-selection-bar" aria-label={ja ? "対象サーバー" : "Target servers"}>
      <div><strong>{mode === "copy" ? t("guildList.copySource", { source: sourceGuild?.name || "" }) : ja ? "変更するサーバーを選択" : "Select servers to edit"}</strong><span>{ja ? `選択中 ${targetGuildIds.length}件` : `${targetGuildIds.length} selected`}</span></div>
      <div className="guild-selection-actions">{mode === "copy" ? <Button disabled={busy || !targetGuildIds.length} onClick={copySettings}><ArrowRightLeft size={16} aria-hidden />{busy ? t("sync.busy") : t("guildList.copyRun")}</Button> : <Button disabled={targetGuildIds.length < 2} onClick={() => pushGuildSelection(targetGuildIds)}><Settings2 size={16} aria-hidden />{ja ? "選択したサーバーの設定を開く" : "Open selected server settings"}</Button>}<Button disabled={busy} variant="ghost" onClick={resetMode}><X size={16} aria-hidden />{t("guildList.copyCancel")}</Button></div>
      {mode === "copy" ? <p><ShieldCheck size={15} aria-hidden />{ja ? "コピー先の設定を上書きします。サーバー管理権限が必要です。" : "Destination settings will be overwritten. Manage Server permission required."}</p> : null}
    </section> : null}
    <div className="guild-directory-list">{filtered.map(guild => {
      const isSource = mode === "copy" && guild.guildId === sourceGuildId;
      const selectable = mode === "bulk" ? guild.canManageGuild : mode === "copy" && !isSource && guild.canManageGuild;
      return <article key={guild.guildId} className={`guild-directory-row${targetGuildIds.includes(guild.guildId) ? " is-selected" : ""}`}>
        {mode !== "browse" ? <input type="checkbox" disabled={!selectable || busy} checked={isSource || targetGuildIds.includes(guild.guildId)} aria-label={`${mode === "copy" ? t("guildList.copyTargetCheckbox") : ja ? "変更対象として選択" : "Select for editing"} ${guild.name}`} onChange={event => toggleTarget(guild.guildId, event.target.checked)} /> : null}
        <div className="guild-directory-avatar">{guild.iconUrl ? <img src={guild.iconUrl} alt="" /> : <Server size={23} aria-hidden />}</div>
        <div className="guild-directory-name"><Link href={`/dashboard/${guild.guildId}`}><strong>{guild.name}</strong></Link><span>{guild.providerSummary && guild.providerSummary.total > 0 ? t("guildList.providerSummary", { enabled: guild.providerSummary.enabled, total: guild.providerSummary.total }) : ja ? "展開設定の件数を取得できませんでした" : "Service counts are unavailable"}</span></div>
        <Badge tone={guild.canEdit ? "success" : "muted"}>{guild.canEdit ? t("guildList.canEdit") : t("guildList.viewOnly")}</Badge>
        {isSource ? <Badge>{t("guildList.copySourceBadge")}</Badge> : null}
        {mode === "copy" && !isSource && !guild.canManageGuild ? <span className="guild-directory-restriction">{ja ? "サーバー管理権限が必要" : "Manage Server required"}</span> : null}
        {mode === "bulk" && !guild.canManageGuild ? <span className="guild-directory-restriction">{ja ? "サーバー管理権限が必要" : "Manage Server required"}</span> : null}
        {mode === "browse" ? <div className="guild-directory-actions"><Button asChild><Link href={`/dashboard/${guild.guildId}/providers`}><Settings2 size={16} aria-hidden />{guild.canEdit ? ja ? "リンク展開を変更" : "Edit link expansion" : ja ? "設定を見る" : "View settings"}</Link></Button><details><summary aria-label={`${ja ? "その他の操作" : "More actions"} ${guild.name}`}><MoreHorizontal size={19} aria-hidden /></summary><Button variant="ghost" onClick={() => { setSourceGuildId(guild.guildId); setTargetGuildIds([]); setMode("copy"); setMessage(null); }}><ArrowRightLeft size={16} aria-hidden />{ja ? "この設定を他のサーバーへコピー" : "Copy these settings to another server"}</Button></details></div> : null}
      </article>;
    })}</div>
    {filtered.length === 0 ? <div className="guild-directory-empty"><Server size={32} aria-hidden />{query.trim() ? <><p>{ja ? "検索条件に一致するサーバーがありません" : "No servers match this search"}</p><Button variant="outline" onClick={() => setQuery("")}>{ja ? "検索をクリア" : "Clear search"}<ArrowRight size={16} aria-hidden /></Button></> : <><Button asChild><a href={BOT_INVITE_URL} target="_blank" rel="noreferrer">{t("home.inviteBot")}</a></Button><p><ShieldCheck size={16} aria-hidden />{ja ? "サーバーの管理者から閲覧・編集権限を付与してもらうこともできます。" : "A server administrator can also grant you dashboard access."}</p></>}</div> : null}
  </div>;
}
