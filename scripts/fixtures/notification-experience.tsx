import React from "react";
import { createRoot } from "react-dom/client";
import NotificationsPage from "../../dashboard/app/dashboard/automation/page";
import XPage from "../../dashboard/app/dashboard/automation/x/page";
import PlansPage from "../../dashboard/app/dashboard/automation/plans/page";
import SupportPage from "../../dashboard/app/dashboard/automation/support/page";
import "../../dashboard/app/globals.css";

const params = new URLSearchParams(window.location.search);
const scenarios = new Set(["fresh", "connected", "unbound", "pending", "full", "rt-plan", "supporter-direct"]);
const selected = params.get("scenario");
const scenario = selected && scenarios.has(selected) ? selected : "connected";
// The real root layout sets this from the same rollout preference mocked below.
document.documentElement.dataset.dashboardUi = "preview";
document.cookie = `notification_preview=${scenario};path=/;SameSite=Strict`;
// An inert data-block script satisfies the real loader's existing-SDK check.
// It is not a JavaScript script and causes no remote fetch. CSP also blocks
// external scripts/connections. The card below is explicitly a local mock.
const sdkMarker = document.createElement("script"); sdkMarker.type = "application/json";
sdkMarker.src = "https://sandbox.web.squarecdn.com/v1/square.js"; document.head.append(sdkMarker);
(window as any).Square = { payments: () => ({ card: async () => ({
  attach: async (selector: string) => { const target = document.querySelector(selector); if (target) target.innerHTML = '<div style="padding:16px;border:1px dashed #94a3b8;border-radius:8px;background:#f8fafc;font-size:13px">ローカル検証専用のカード入力（実カード情報は入力しません）</div>'; },
  destroy: async () => {}, tokenize: async () => ({ status: "OK", token: "fixture-only-card-nonce" }),
}) }) };
async function start() {
  const path = window.location.pathname;
  const Page = path.endsWith("/plans") ? PlansPage : path.endsWith("/support") ? SupportPage : path.endsWith("/x") ? XPage : NotificationsPage;
  const page = await Page();
  createRoot(document.getElementById("root")!).render(<><div role="status" style={{ background: "#fef3c7", borderBottom: "1px solid #f59e0b", color: "#78350f", fontSize: 12, padding: "8px 16px", textAlign: "center" }}>ローカル検証専用・架空アカウント／Discord・X・決済はすべて模擬データです。実送信や課金はありません。</div>{page}</>);
}
void start();
