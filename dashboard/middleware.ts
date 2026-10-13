import { NextRequest, NextResponse } from "next/server";
import { DashboardFleetAuthorityError, assertDashboardFleetWriteAuthority, dashboardRequestNeedsWriteAuthority } from "@/lib/fleet-authority";

export function middleware(req: NextRequest) {
  if (!dashboardRequestNeedsWriteAuthority(req.method, req.nextUrl.pathname)) return NextResponse.next();
  try { assertDashboardFleetWriteAuthority(); return NextResponse.next(); }
  catch (error) {
    const failure = error instanceof DashboardFleetAuthorityError ? error : new DashboardFleetAuthorityError();
    return NextResponse.json({ error: failure.message, code: failure.code }, { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "5" } });
  }
}

// Next 15.5 supports Node middleware, so the guardian evidence is read directly
// without an internal HTTP endpoint or a client-controlled authority header.
export const config = { runtime: "nodejs", matcher: ["/api/:path*", "/dashboard/:path*", "/admin/:path*"] };
