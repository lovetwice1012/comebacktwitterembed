import React from "react";

// Only bundled by the loopback UI fixture, never by the Dashboard.
export default function Link({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props}>{children}</a>;
}
export function usePathname() { return window.location.pathname; }
export function useRouter() { return { refresh() { window.location.reload(); }, push(url: string) { window.location.assign(url); }, replace(url: string) { window.location.replace(url); } }; }
