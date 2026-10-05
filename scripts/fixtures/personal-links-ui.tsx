import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PersonalLinksWorkspace } from "../../dashboard/components/personal-links/personal-links-workspace";
import { ProviderSettingsForm } from "../../dashboard/components/settings/provider-settings-form";
import "../../dashboard/app/globals.css";
function Fixture() {
  const [settings, setSettings] = useState<any[]>([]), [version, setVersion] = useState(0);
  useEffect(() => { fetch('/fixture/settings').then(r => r.json()).then(setSettings); }, [version]);
  return <main className="mx-auto max-w-7xl space-y-6 p-4">
    <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs">検証専用：架空ユーザー・使い捨てDB。Discordへは送信しません。商品情報は模擬です。</p>
    <PersonalLinksWorkspace displayName="検証ユーザー" />
    <section className="space-y-3 border-t pt-6"><h2 className="text-xl font-semibold">サーバー設定の検証（Pixiv）</h2>
      {settings.length > 0 && <ProviderSettingsForm guildId="333333333333333333" providerId="pixiv" providerLabel="Pixiv" canEdit locale="ja" settings={settings} draftKeyOverride="personal-links-test-settings" showResetProvider={false}
        onSaveChanges={async changes => { const res = await fetch('/fixture/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error); return data; }}
        onSaved={() => setVersion(v => v + 1)} />}
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
