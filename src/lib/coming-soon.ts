// Coming-soon gate. While COMING_SOON is true the UI is limited to the landing
// page and token detail pages; every other UI route redirects to "/". Flip this
// to false to restore the full app — no code is commented out anywhere.
//
// This does NOT affect /api/* (server routes are handled separately), so the
// platform token can still be launched + read through the API while the UI is
// gated, and /token/$id stays live to view it.
export const COMING_SOON = false; // gated for launch

export function isUIRouteAllowed(pathname: string): boolean {
  if (!COMING_SOON) return true;
  if (pathname === "/") return true;
  // Everything else is blocked for launch: /launch, /tokens, /route-fees, /paper,
  // /onboarding, /token/* all redirect to "/".
  if (pathname.startsWith("/paper")) return true; // paper
  if (pathname.startsWith("/onboarding")) return true; // paper
  if (pathname.startsWith("/launch")) return true;
  if (pathname.startsWith("/route-fees")) return true;
  if (pathname.startsWith("/admin")) return true; 
  // if (pathname.startsWith("/admin-launch")) return true; 
  if (pathname.startsWith("/tokens")) return true; 
  if (pathname.startsWith("/token")) return true; // admin cockpit + keeper logs (secret-gated) — ops only
  if (pathname.startsWith("/api/")) return true; // never gate API routes
  return false;
}
