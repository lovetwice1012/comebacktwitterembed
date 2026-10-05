import React from "react";
import { createRoot } from "react-dom/client";
import { AutomationWorkspace } from "../../dashboard/components/automation/automation-workspace";
import "../../dashboard/app/globals.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><main className="mx-auto max-w-[1500px] space-y-4 p-4"><div className="rounded border border-amber-500 bg-amber-50 p-3 text-sm">ローカル検証専用 — テストDB・固定の架空ユーザーを使用します。Discord通信・実送信はありません。本番の認証は検証していません。</div><AutomationWorkspace viewerId="222222222222222222" guildId="111111111111111111" canEdit /></main></React.StrictMode>);
