"use client";

import { useId, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Bell, BookOpen, CalendarClock, CircleStop, Clock3, Gauge, GitBranch, Layers3, Merge, Play, Search, SlidersHorizontal, X, FlaskConical, type LucideIcon } from "lucide-react";
import type { Rule, RuleNode } from "./rule-editor";
import { blockSummary, valueLabels } from "./rule-labels";

type StudioStepsProps = {
  value: Rule;
  catalog: any;
  selected: string;
  onSelect: (id: string) => void;
  simulation: any;
};

const icons: Record<string, LucideIcon> = {
  start: Play,
  condition: GitBranch,
  dictionary: BookOpen,
  merge: Merge,
  delay: Clock3,
  schedule: CalendarClock,
  transform: SlidersHorizontal,
  limit: Gauge,
  aggregate: Layers3,
  send: Bell,
  stop: CircleStop,
};
const outcomes: Record<string, string> = {
  scheduled: "通知する",
  excluded: "この経路では通知しない",
  merged: "合流",
  expired: "期限切れ",
};

// The list is a view of the existing graph. It never rewrites edges, positions,
// or groups. Original array order breaks ties between equally ready nodes.
function orderSteps(value: Rule) {
  const byId = new Map(value.nodes.map(node => [node.id, node]));
  const index = new Map(value.nodes.map((node, i) => [node.id, i]));
  const incoming = new Map(value.nodes.map(node => [node.id, [] as Rule["edges"]]));
  const outgoing = new Map(value.nodes.map(node => [node.id, [] as Rule["edges"]]));
  const degree = new Map(value.nodes.map(node => [node.id, 0]));

  for (const edge of value.edges) {
    outgoing.get(edge.source)?.push(edge);
    incoming.get(edge.target)?.push(edge);
    if (byId.has(edge.source) && byId.has(edge.target)) degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }

  const ready = value.nodes.filter(node => degree.get(node.id) === 0);
  const ordered: RuleNode[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    ordered.push(node);
    for (const edge of outgoing.get(node.id) || []) {
      if (!byId.has(edge.target)) continue;
      const remaining = (degree.get(edge.target) || 0) - 1;
      degree.set(edge.target, remaining);
      if (remaining === 0) {
        ready.push(byId.get(edge.target)!);
        ready.sort((a, b) => index.get(a.id)! - index.get(b.id)!);
      }
    }
  }

  // A malformed imported cycle must still be selectable and repairable.
  const orderedIds = new Set(ordered.map(node => node.id));
  const unresolved = value.nodes.filter(node => !orderedIds.has(node.id));
  ordered.push(...unresolved);

  const reachable = new Set<string>();
  const stack = value.nodes.filter(node => node.type === "start").map(node => node.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of outgoing.get(id) || []) if (byId.has(edge.target)) stack.push(edge.target);
  }

  return { ordered, incoming, outgoing, byId, reachable, unresolved: new Set(unresolved.map(node => node.id)) };
}

export function StudioSteps({ value, catalog, selected, onSelect, simulation }: StudioStepsProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const graph = useMemo(() => orderSteps(value), [value]);
  const numbers = useMemo(() => new Map(graph.ordered.map((node, i) => [node.id, i + 1])), [graph]);
  const groupNames = useMemo(() => new Map<string, string>((value.layout?.groups || []).map((group: any) => [group.id, group.label])), [value.layout?.groups]);
  const trace = useMemo(() => {
    const latest = new Map<string, any>();
    for (const row of simulation?.trace || []) latest.set(row.nodeId, row);
    return latest;
  }, [simulation]);
  const label = (node: RuleNode) => catalog.nodes[node.type]?.label || node.type;
  const labelCounts = new Map<string, number>();
  for (const node of value.nodes) labelCounts.set(label(node), (labelCounts.get(label(node)) || 0) + 1);
  const targetName = (id: string) => {
    const target = graph.byId.get(id);
    return target ? `${numbers.get(id)}. ${label(target)}` : "接続先が見つかりません";
  };
  const term = query.trim().toLocaleLowerCase("ja");
  const visible = graph.ordered.filter(node => {
    if (!term) return true;
    const targets = (graph.outgoing.get(node.id) || []).map(edge => `${valueLabels[edge.port] || edge.port} ${targetName(edge.target)}`).join(" ");
    return `${label(node)} ${blockSummary(node)} ${groupNames.get(node.group || "") || ""} ${node.id} ${targets}`.toLocaleLowerCase("ja").includes(term);
  });
  const detached = value.nodes.filter(node => !graph.reachable.has(node.id)).length;

  return <section className="studio-steps" aria-label="通知の手順">
    <div className="studio-steps-heading">
      <h2>通知の流れ</h2>
      <span className="studio-steps-count">{value.nodes.length}手順</span>
    </div>
    <div className="studio-step-search">
      <Search size={16} aria-hidden="true" />
      <label className="sr-only" htmlFor={searchId}>手順を検索</label>
      <input id={searchId} type="search" value={query} placeholder="条件・サービス・手順を検索" onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" aria-label="手順の検索をクリア" onClick={() => setQuery("")}><X size={16} aria-hidden="true" /></button>}
    </div>
    {detached > 0 && <p className="studio-steps-warning"><AlertTriangle size={14} aria-hidden="true" />開始から未接続 {detached}手順</p>}
    {term && <p className="studio-steps-search-result" role="status">{visible.length}手順（全{value.nodes.length}手順）</p>}
    <ol className="studio-step-list" aria-label="処理順の手順">
      {visible.map(node => {
        const number = numbers.get(node.id)!;
        const Icon = icons[node.type] || SlidersHorizontal;
        const ports: string[] = catalog.nodes[node.type]?.ports || [];
        const outgoing = graph.outgoing.get(node.id) || [];
        const incoming = graph.incoming.get(node.id) || [];
        const groupName = groupNames.get(node.group || "");
        const isDetached = !graph.reachable.has(node.id);
        const orderIssue = graph.unresolved.has(node.id);
        const row = trace.get(node.id);
        const summary = blockSummary(node);
        const shownPorts = [...new Set([...ports, ...outgoing.map(edge => edge.port)])];
        const isBranch = ports.length > 1;
        return <li className="studio-step-shell" key={node.id} value={number}>
          <button type="button" className="studio-step" data-kind={node.type} data-selected={selected === node.id} data-detached={isDetached} data-order-issue={orderIssue} aria-label={`手順 ${label(node)} を編集${(labelCounts.get(label(node)) || 0) > 1 ? `（手順 ${number}）` : ""}`} aria-current={selected === node.id ? "step" : undefined} onClick={() => onSelect(node.id)}>
            <span className="studio-step-number" aria-hidden="true">{number.toString().padStart(2, "0")}</span>
            <span className="studio-step-icon"><Icon size={18} aria-hidden="true" /></span>
            <span className="studio-step-copy">
              <span className="studio-step-title">{label(node)}</span>
              <span className="studio-step-summary" title={summary}>{summary}</span>
              {(groupName || incoming.length > 1 || node.type === "merge" || isDetached || orderIssue) && <span className="studio-step-meta">
                {groupName && <span className="studio-step-badge">{groupName}</span>}
                {(incoming.length > 1 || node.type === "merge") && <span className="studio-step-badge"><Merge size={12} aria-hidden="true" />{incoming.length}経路から合流</span>}
                {isDetached && <span className="studio-step-badge" data-warning>開始から未接続</span>}
                {orderIssue && <span className="studio-step-badge" data-warning>経路の順序を確認</span>}
              </span>}
              {shownPorts.length > 0 && <span className="studio-step-routes">
                {shownPorts.map(port => {
                  const edges = outgoing.filter(edge => edge.port === port);
                  const missing = edges.some(edge => !graph.byId.has(edge.target));
                  return <span key={port} className="studio-step-route" data-port={port} data-empty={!edges.length} data-missing={missing}>
                    <span className="studio-step-port">{valueLabels[port] || port}</span><ArrowRight size={12} aria-hidden="true" />
                    <span>{edges.length ? edges.map(edge => targetName(edge.target)).join("、") : isBranch ? "この経路では通知しない" : "次の手順が未接続"}</span>
                  </span>;
                })}
              </span>}
              {row && <span className="studio-step-outcome" data-outcome={row.outcome}><FlaskConical size={12} aria-hidden="true" /><span>{valueLabels[row.outcome] || outcomes[row.outcome] || row.outcome}</span>{row.reason && <span>{row.reason}</span>}</span>}
            </span>
          </button>
        </li>;
      })}
    </ol>
    {!visible.length && <div className="studio-steps-empty">{term ? <><Search size={20} aria-hidden="true" /><button type="button" onClick={() => setQuery("")}>検索をクリア</button></> : <p className="studio-critical-note"><AlertTriangle size={14} aria-hidden="true" />開始ブロックが必要です</p>}</div>}
  </section>;
}
