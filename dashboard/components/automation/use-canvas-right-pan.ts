"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { ReactFlowInstance, Viewport } from "@xyflow/react";

type Flow = Pick<ReactFlowInstance, "getViewport" | "setViewport">;
type Options = {
  getFlow: () => Flow | null;
  onStart?: () => void;
  onEnd?: (event: MouseEvent, viewport: Viewport) => void;
  onClick?: (event: MouseEvent, originalTarget: Element) => void;
  enabled?: boolean;
};
type Gesture = {
  target: Element;
  canvas: HTMLElement;
  flow: Flow;
  x: number;
  y: number;
  start: Viewport;
  viewport: Viewport;
  event: MouseEvent;
  moved: boolean;
};

// A node's summary is itself a button, but remains a useful place to grab the
// canvas. Other controls and editable fields keep their normal mouse behavior.
const controls = "input,textarea,select,[contenteditable]:not([contenteditable='false']),button:not(.studio-flow-summary-edit),[role='button']:not(.studio-flow-summary-edit),a,.studio-canvas-dock,.studio-context-menu,.studio-block-picker,.react-flow__controls,.react-flow__minimap,.react-flow__panel,[data-canvas-right-pan='ignore']";

export function useCanvasRightPan(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<Gesture | null>(null);
  const suppress = useRef<{ canvas: HTMLElement; until: number } | null>(null);
  const [panning, setPanning] = useState(false);

  const suppressContext = useCallback((event: MouseEvent) => {
    const recent = suppress.current;
    const afterRelease = event.button === 2 && recent && Date.now() < recent.until && event.target instanceof Element && recent.canvas.contains(event.target);
    if (!active.current && !afterRelease) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const finish = useCallback((event: MouseEvent, clicked: boolean) => {
    const gesture = active.current;
    if (!gesture) return;
    active.current = null;
    suppress.current = { canvas: gesture.canvas, until: Date.now() + 500 };
    setPanning(false);
    if (gesture.moved) latest.current.onEnd?.(event, gesture.viewport);
    else if (clicked) latest.current.onClick?.(event, gesture.target);
  }, []);

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const gesture = active.current;
      if (!gesture) return;
      // A release outside this window may not deliver mouseup. Do not leave the
      // canvas attached to the next move after the pointer returns.
      if (!(event.buttons & 2)) { finish(event, false); return; }
      event.preventDefault(); event.stopPropagation();
      gesture.event = event;
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (!gesture.moved && dx * dx + dy * dy <= 25) return;
      if (!gesture.moved) { gesture.moved = true; setPanning(true); }
      gesture.viewport = { ...gesture.start, x: gesture.start.x + dx, y: gesture.start.y + dy };
      void gesture.flow.setViewport(gesture.viewport, { duration: 0 });
    };
    const up = (event: MouseEvent) => {
      if (event.button !== 2 || !active.current) return;
      event.preventDefault(); event.stopPropagation(); finish(event, true);
    };
    const cancel = () => { if (active.current) finish(active.current.event, false); };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("contextmenu", suppressContext, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointercancel", cancel, true);
    return () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("contextmenu", suppressContext, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointercancel", cancel, true);
      active.current = null; suppress.current = null;
    };
  }, [finish, suppressContext]);

  useEffect(() => {
    if (options.enabled === false && active.current) finish(active.current.event, false);
  }, [options.enabled, finish]);

  const onMouseDownCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    // New presses must not inherit suppression from the previous gesture,
    // particularly when the next right-click is in a text input.
    suppress.current = null;
    if (event.button !== 2 || latest.current.enabled === false) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".react-flow") || target.closest(controls)) return;
    const flow = latest.current.getFlow();
    if (!flow) return;
    event.preventDefault(); event.stopPropagation();
    const viewport = flow.getViewport();
    active.current = { target, canvas: event.currentTarget, flow, x: event.clientX, y: event.clientY, start: { ...viewport }, viewport: { ...viewport }, event: event.nativeEvent, moved: false };
    latest.current.onStart?.();
  }, []);

  const onContextMenuCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => suppressContext(event.nativeEvent), [suppressContext]);
  return { onMouseDownCapture, onContextMenuCapture, panning };
}
