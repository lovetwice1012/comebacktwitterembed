import type { EdgeRoute } from './editor-edge-routing';

export type CrossingEdgeRoute = EdgeRoute & { displayPath: string; crossingCount: number };
export function decorateEdgeCrossings(routes: ReadonlyMap<string, EdgeRoute>): Map<string, CrossingEdgeRoute>;
