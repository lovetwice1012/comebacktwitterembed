// Compare only editable behavior. Names are labels and use the metadata-only API.
export function monitorBehavior(value: any, kind: string) {
  return { providerId: value.providerId || "", source: String(value.source || "").trim(), locale: value.locale || "ja",
    destinationId: value.destinationId || "", enabled: value.enabled !== false, scope: value.scope || "private",
    ...(kind === "price" ? { mode: value.mode || "change", maxPriceAmount: value.maxPriceAmount === "" || value.maxPriceAmount == null ? null : String(value.maxPriceAmount),
      minDiscountPercent: value.minDiscountPercent === "" || value.minDiscountPercent == null ? null : String(value.minDiscountPercent) } : {}) };
}

export function monitorBehaviorChanged(original: any, draft: any, kind: string) {
  return !original || JSON.stringify(monitorBehavior(original, kind)) !== JSON.stringify(monitorBehavior(draft, kind));
}

export function monitorWorkflowChanged(original: any, draft: any) {
  return (original?.workflowId || "") !== (draft.workflowId || "");
}

export function rebaseMonitorDraft(original: any, draft: any, latest: any, kind: string) {
  const before = { ...monitorBehavior(original, kind), name: original.name || "", workflowId: original.workflowId || "" };
  const after = { ...monitorBehavior(draft, kind), name: draft.name || "", workflowId: draft.workflowId || "" };
  const merged = { ...latest, kind, maxPriceAmount: latest.maxPriceAmount ?? "", minDiscountPercent: latest.minDiscountPercent ?? "", destinationId: latest.destinationId || "", workflowId: latest.workflowId || "" };
  for (const key of Object.keys(before) as (keyof typeof before)[]) {
    if (before[key] !== after[key]) merged[key] = draft[key];
  }
  return merged;
}
