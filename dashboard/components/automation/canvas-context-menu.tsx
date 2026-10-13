"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type CanvasMenuItem = { label: string; shortcut?: string; disabled?: boolean; danger?: boolean; divider?: boolean; run: () => void };

export function CanvasContextMenu({ x, y, width, height, items, onClose }: { x: number; y: number; width: number; height: number; items: CanvasMenuItem[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const bounds = menu.current?.getBoundingClientRect();
    if (bounds) setPosition({ x: Math.max(8, Math.min(x, width - bounds.width - 8)), y: Math.max(8, Math.min(y, height - Math.min(bounds.height, height - 16) - 8)) });
  }, [x, y, width, height]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("pointerdown", outside); if (previous?.isConnected) previous.focus(); };
  }, [onClose]);
  return <div ref={menu} role="menu" aria-label="キャンバスの操作" className="studio-context-menu nodrag nopan nokey" style={{ left: position.x, top: position.y, maxHeight: height - 16 }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  }}>
    {items.map(item => <button role="menuitem" type="button" key={item.label} disabled={item.disabled} data-danger={item.danger || undefined} data-divider={item.divider || undefined} onClick={() => { onClose(); item.run(); }}><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}
  </div>;
}
