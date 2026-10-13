export type EdgeLanes = { targetIndex: number; targetCount: number; sourceIndex: number; sourceCount: number; routeIndex: number; routeCount: number };
export type EdgePoint = { x: number; y: number };
export type EdgeObstacle = { id?: string; x: number; y: number; width: number; height: number };
export type EdgeRoute = { path: string; points: EdgePoint[]; labelX: number; labelY: number; blocked?: boolean; routingConflictKey?: string };
export type EdgeRouteOptions = { obstacles?: EdgeObstacle[]; clearance?: number; occupied?: EdgePoint[][]; previousRoutes?: ReadonlyMap<string, EdgeRoute> };
export type EdgeRouteEndpoints = { sourceX: number; sourceY: number; targetX: number; targetY: number; sourceId?: string; targetId?: string; lanes?: Partial<EdgeLanes> };
export function edgeLanes(edges: { id: string; source: string; target: string; sourceHandle?: string | null; data?: { port?: string } }[]): Map<string, EdgeLanes>;
export function edgeRoute(options: EdgeRouteEndpoints & EdgeRouteOptions): EdgeRoute;
export function edgeRoutes(edges: (EdgeRouteEndpoints & { id: string })[], options?: EdgeRouteOptions): Map<string, EdgeRoute>;
