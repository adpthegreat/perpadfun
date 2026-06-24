// Admin key (KEEPER_SECRET) for the keeper-logs viewer, kept in localStorage so
// the admin enters it once per browser. Sent as the x-keeper-secret header to
// the secret-gated /api/public/keeper/* routes — the same secret the keeper and
// the other /api/admin operations already use. NOT a public credential: it
// stays in the operator's browser and is verified server-side against
// KEEPER_SECRET. keeper_logs itself remains non-public (no RLS read policy).

const STORAGE_KEY = "perpspad.adminKey";

export function getAdminKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setAdminKey(value: string): void {
  if (typeof window === "undefined") return;
  try {
    const v = value.trim();
    if (v) window.localStorage.setItem(STORAGE_KEY, v);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
