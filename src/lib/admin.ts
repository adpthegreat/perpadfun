// Admin wallet pubkeys - safe to import on client.
export const ADMIN_WALLET_PUBKEYS = ["FHmBz4SnZ5r6Rws958S8WJ5ymnrvUdwjgrVQ3BVeBH95"] as const;

// Back-compat: first entry is the canonical admin.
export const ADMIN_WALLET_PUBKEY = ADMIN_WALLET_PUBKEYS[0];

export function isAdminWallet(address: string | null | undefined): boolean {
  if (!address) return false;
  return (ADMIN_WALLET_PUBKEYS as readonly string[]).includes(address);
}
