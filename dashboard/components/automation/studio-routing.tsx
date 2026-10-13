"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useStore, type ReactFlowState } from "@xyflow/react";
import { getEdgePosition } from "@xyflow/system";
import { edgeLanes, edgeRoutes, type EdgeLanes } from "../../../src/automation/editor-edge-routing";
import { decorateEdgeCrossings, type CrossingEdgeRoute } from "../../../src/automation/editor-edge-crossings";

type RoutingEdge = { id: string; sourceId: string; targetId: string; sourceX: number; sourceY: number; targetX: number; targetY: number; lanes?: EdgeLanes };
type Obstacle = { id: string; x: number; y: number; width: number; height: number };
type Geometry = { key: string; edges: RoutingEdge[]; obstacles: Obstacle[]; identities: Map<string, string> };
type RouteStore = { routes: Map<string, CrossingEdgeRoute>; identities: Map<string, string>; subscribe: (listener: () => void) => () => void; publish: (routes: Map<string, CrossingEdgeRoute>, identities: Map<string, string>) => void };

const RouteContext = createContext<RouteStore | null>(null);
const noSubscription = () => () => {};
const noRoute = () => undefined;

function createRouteStore(): RouteStore {
  const listeners = new Set<() => void>();
  const store: RouteStore = {
    routes: new Map(), identities: new Map(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    publish(next, identities) {
      let changed = next.size !== store.routes.size;
      for (const [id, route] of next) {
        const previous = store.routes.get(id);
        if (previous && previous.path === route.path && previous.displayPath === route.displayPath && previous.crossingCount === route.crossingCount && previous.labelX === route.labelX && previous.labelY === route.labelY && previous.blocked === route.blocked) next.set(id, previous);
        else changed = true;
      }
      store.identities = identities;
      if (!changed) return;
      store.routes = next;
      for (const listener of listeners) listener();
    },
  };
  return store;
}

/** Geometry lives in XYFlow's store during a drag, before the saved rule is committed. */
function routingGeometry(state: ReactFlowState): Geometry {
  const obstacles: Obstacle[] = [];
  for (const node of state.nodeLookup.values()) {
    if (node.hidden) continue;
    const width = node.measured.width ?? node.width ?? node.initialWidth;
    const height = node.measured.height ?? node.height ?? node.initialHeight;
    if (!(width && height)) continue;
    obstacles.push({ id: node.id, x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y, width, height });
  }
  const visibleEdges = state.edges.filter(edge => !edge.hidden);
  const lanes = edgeLanes(visibleEdges);
  const edges: RoutingEdge[] = [], identities = new Map<string, string>();
  for (const edge of visibleEdges) {
    const source = state.nodeLookup.get(edge.source), target = state.nodeLookup.get(edge.target);
    if (source?.hidden || target?.hidden) continue;
    identities.set(edge.id, JSON.stringify([edge.source, edge.sourceHandle ?? null, edge.target, edge.targetHandle ?? null]));
    if (!source || !target) continue;
    const position = getEdgePosition({ id: edge.id, sourceNode: source, targetNode: target, sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null, connectionMode: state.connectionMode });
    if (!position) continue;
    edges.push({ id: edge.id, sourceId: edge.source, targetId: edge.target, sourceX: position.sourceX, sourceY: position.sourceY, targetX: position.targetX, targetY: position.targetY, lanes: lanes.get(edge.id) });
  }
  // Exclude selection, viewport and node data: they do not change wire geometry.
  return { key: JSON.stringify([obstacles, edges, [...identities]]), obstacles, edges, identities };
}

/** Keep this provider outside ReactFlow; its stable store only updates changed wires. */
export function StudioRoutingProvider({ children }: { children: ReactNode }) {
  const store = useRef<RouteStore | null>(null);
  if (!store.current) store.current = createRouteStore();
  return <RouteContext.Provider value={store.current}>{children}</RouteContext.Provider>;
}

/** Render inside ReactFlow so measured card bounds and handle positions are available. */
export function StudioRoutingObserver() {
  const store = useContext(RouteContext);
  const geometry = useStore(routingGeometry, (previous, next) => previous.key === next.key);
  const routes = useMemo(() => edgeRoutes(geometry.edges, { obstacles: geometry.obstacles, previousRoutes: store?.routes }), [geometry, store]);
  useLayoutEffect(() => {
    if (!store) return;
    const next = new Map(routes);
    // A handle may be between ResizeObserver measurements. Keep its existing wire
    // until the next measurement instead of emptying the routing layer.
    for (const [id, identity] of geometry.identities) {
      if (next.has(id) || store.identities.get(id) !== identity) continue;
      const previous = store.routes.get(id);
      if (previous) next.set(id, previous);
    }
    store.publish(decorateEdgeCrossings(next), geometry.identities);
  }, [store, geometry, routes]);
  return null;
}

export function useStudioRoute(id: string) {
  const store = useContext(RouteContext);
  const snapshot = useCallback(() => store?.routes.get(id), [store, id]);
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store ? snapshot : noRoute, noRoute);
}
