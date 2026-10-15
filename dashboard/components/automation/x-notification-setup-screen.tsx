"use client";

import { useCallback } from "react";
import { automationFetch } from "./automation-feedback";
import { XNotificationSetup } from "./x-notification-setup";
import { XProcessingSettings } from "./x-processing-settings";
import "./notification-x.css";

export function XNotificationSetupScreen() {
  // Identity is established by the authenticated API; no guild or owner is supplied.
  const api = useCallback(async (path: string, method = "GET", body?: unknown) => {
    return automationFetch(`/api/automation/${path}`, { method, cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }, []);
  return <div className="notification-x nx-setup-screen"><XNotificationSetup api={api} initiallyOpen /><details className="nx-legacy-timing"><summary>既存監視の共通設定</summary><p className="nx-field-note">通知方法を個別に指定していない既存の監視に適用します。</p><XProcessingSettings api={api} /></details></div>;
}
