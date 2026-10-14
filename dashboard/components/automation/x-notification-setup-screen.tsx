"use client";

import { useCallback } from "react";
import { automationResponseError } from "./automation-feedback";
import { XNotificationSetup } from "./x-notification-setup";

export function XNotificationSetupScreen() {
  // Identity is established by the authenticated API; no guild or owner is supplied.
  const api = useCallback(async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`/api/automation/${path}`, { method, cache: "no-store", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw automationResponseError(result, response);
    return result;
  }, []);
  return <XNotificationSetup api={api} initiallyOpen />;
}
