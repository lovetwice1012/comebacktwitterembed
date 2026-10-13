"use client";

import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import { edgeRoute, type EdgeLanes, type EdgeRoute } from "../../../src/automation/editor-edge-routing";
import type { CrossingEdgeRoute } from "../../../src/automation/editor-edge-crossings";
import { useStudioRoute } from "./studio-routing";
import "./studio-flow-edge.css";

type StudioEdgeData = { port?: string; lanes?: EdgeLanes; active?: boolean; focused?: boolean; dimmed?: boolean };

type StudioEdgeProps = EdgeProps<Edge<StudioEdgeData>>;

export function StudioFlowEdge(props: StudioEdgeProps) {
  const measuredRoute = useStudioRoute(props.id);
  const route = measuredRoute ?? edgeRoute({ sourceX: props.sourceX, sourceY: props.sourceY, targetX: props.targetX, targetY: props.targetY, lanes: props.data?.lanes });
  return <StudioEdgePicture {...props} route={route} />;
}

/** The split stroke is cosmetic; hit testing and endpoint markers stay continuous. */
export function StudioEdgePicture({ id, route, data, selected, markerStart, markerEnd, label, labelStyle, labelBgStyle, style, interactionWidth }: StudioEdgeProps & { route: EdgeRoute | CrossingEdgeRoute }) {
  const displayPath = "displayPath" in route ? route.displayPath : route.path;
  const split = displayPath !== route.path;
  const width = selected || data?.focused ? 4 : data?.active ? 3.5 : 2;
  return <g className="studio-flow-edge" data-port={data?.port} data-selected={selected || data?.focused || undefined} data-active={data?.active || undefined} data-dimmed={data?.dimmed || undefined} data-blocked={route.blocked || undefined} data-crossings={"crossingCount" in route ? route.crossingCount || undefined : undefined}>
    {route.blocked && <title>ブロックが重なっているため、線の経路を確保できません。重なったブロックを離してください。</title>}
    <path className="react-flow__edge-interaction" d={route.path} fill="none" strokeOpacity={0} strokeWidth={interactionWidth || 22} />
    <path className="studio-edge-halo" d={displayPath} fill="none" strokeWidth={width + 5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" aria-hidden="true" />
    <BaseEdge id={id} path={displayPath} markerStart={split ? undefined : markerStart} markerEnd={split ? undefined : markerEnd} interactionWidth={0}
      label={route.blocked ? <>{label} ⚠</> : label} labelX={route.labelX} labelY={route.labelY} labelStyle={{ ...labelStyle, fontSize: 11, fontWeight: selected ? 750 : 650 }}
      labelShowBg labelBgPadding={[7, 5]} labelBgBorderRadius={6} labelBgStyle={{ ...labelBgStyle, stroke: "hsl(var(--border))", strokeWidth: 1 }}
      style={{ ...style, strokeWidth: width, strokeLinecap: "round", strokeLinejoin: "round" }} />
    {split && <path className="studio-edge-endmarkers" d={route.path} fill="none" stroke="none" strokeWidth={width} markerStart={markerStart} markerEnd={markerEnd} pointerEvents="none" aria-hidden="true" />}
  </g>;
}
