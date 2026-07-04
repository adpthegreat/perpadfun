import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { apiOk, apiErr } from "@/lib/api/respond";
// SERVER-ONLY import. This pulls in the full 380-wallet allocation table; it must
// NEVER be imported by a client/route component — only from this API handler. The
// handler returns a single looked-up address, never the whole map.
import { getAllocation, eligibleCount } from "@/lib/checker/allocations.server";

// Base58 (no 0/O/I/l), 32–44 chars — the on-the-wire length bounds for a Solana
// pubkey. Matches the launch route's address bounds. Not lowercased: base58 is
// case-sensitive and the allocation keys are stored verbatim.
const Body = z.object({
  address: z
    .string()
    .trim()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "not a base58 string"),
});

// POST /api/checker — { address } -> { eligible, amount?, amountUi?, breakdown? }.
// GET  /api/checker — { eligibleCount } (the count only, never the list).
//
// POST-with-body keeps the address out of the URL / CF request logs (privacy).
export const Route = createFileRoute("/api/checker")({
  server: {
    handlers: {
      GET: async () => apiOk({ eligibleCount: eligibleCount() }),

      POST: async ({ request }) => {
        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return apiErr(400, "bad_json", "invalid JSON body");
        }

        const parsed = Body.safeParse(raw);
        if (!parsed.success) {
          return apiErr(422, "validation", "not a valid Solana address", "address");
        }
        const address = parsed.data.address;

        // Secondary guard: a well-formed base58 string of the right length can
        // still fail to be a valid 32-byte curve point. Constructing a PublicKey
        // rejects those without needing the on-curve check.
        try {
          new PublicKey(address);
        } catch {
          return apiErr(422, "validation", "not a valid Solana address", "address");
        }

        const alloc = getAllocation(address); // verbatim, case-sensitive lookup
        if (!alloc) {
          return apiOk({ eligible: false, address });
        }

        return apiOk({
          eligible: true,
          address,
          // exact integer base units (string, 6 decimals) — the canonical amount
          amount: alloc.amountBaseUnits,
          // UI decimal used for display (e.g. 46499698.213797)
          amountUi: alloc.amountUi,
          breakdown: {
            perpadBalance: alloc.perpadBalance,
            holdDays: alloc.holdDays,
            base: alloc.base,
            daysBonus: alloc.daysBonus,
          },
        });
      },
    },
  },
});
