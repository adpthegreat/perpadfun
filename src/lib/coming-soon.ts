// Coming-soon gate. While COMING_SOON is true the UI is limited to the landing
// page and token detail pages; every other UI route redirects to "/". Flip this
// to false to restore the full app — no code is commented out anywhere.
//
// This does NOT affect /api/* (server routes are handled separately), so the
// platform token can still be launched + read through the API while the UI is
// gated, and /token/$id stays live to view it.
export const COMING_SOON = true;

export function isUIRouteAllowed(pathname: string): boolean {
  if (!COMING_SOON) return true;
  if (pathname === "/") return true;
  if (pathname.startsWith("/token/")) return true; // token detail pages stay live
  if (pathname === "/paper") return true; // whitepaper stays live
  if (pathname === "/quest") return true; // pre-launch quest funnel stays live
  if (pathname.startsWith("/api/")) return true; // never gate API routes
  return false;
}
