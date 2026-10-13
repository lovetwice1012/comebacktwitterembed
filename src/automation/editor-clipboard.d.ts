import type { Rule, RuleNode, Bindings } from "../../dashboard/components/automation/rule-editor";

export type AutomationSelection = {
  schemaVersion: 1;
  kind: "automation-selection";
  nodes: RuleNode[];
  edges: Rule["edges"];
  groups?: { id: string; label: string; collapsed?: boolean }[];
  bindings?: Bindings;
};
export function validateSelection(payload: unknown): AutomationSelection;
export function copySelection(rule: Rule, ids: string[], bindings?: Bindings): AutomationSelection;
export function cutSelection(rule: Rule, ids: string[]): Rule;
export function pasteSelection(rule: Rule, payload: unknown, position?: { x: number; y: number }, bindings?: Bindings): {
  rule: Rule;
  bindings?: Bindings;
  nodeIds: string[];
  edgeIds: string[];
};
