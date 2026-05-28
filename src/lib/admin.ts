// Admin wallet pubkeys - safe to import on client.
export const ADMIN_WALLET_PUBKEYS = [
  "9Kxfhk9JMckpzAmGm1hXFjdfdL4VjpHvBKu9p4kJWHB7",
  "DPHgMJPRP6iUtdTwvjUJm6b5MaWqWQHPH9P5gLsTYUkm",
] as const;

// Back-compat: first entry is the canonical admin.
export const ADMIN_WALLET_PUBKEY = ADMIN_WALLET_PUBKEYS[0];

export function isAdminWallet(address: string | null | undefined): boolean {
  if (!address) return false;
  return (ADMIN_WALLET_PUBKEYS as readonly string[]).includes(address);
}
