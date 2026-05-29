import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { deriveSubWalletAddress } from "@/lib/solana/subWallet.server";
import { getTreasuryKeypair } from "@/lib/solana/treasury.server";

// One-off backfill that fills every NULL tokens.treasury_wallet_address so the
// column can be made NOT NULL (closes cause H / 2c, see LAUNCH_REFACTOR.md).
//
// Cohort rule (the landmine — see keeper/src/wallet.js walletForToken):
//   - a NULL wallet currently means "sign with master".
//   - legacy tokens (pre-sub-wallet) were ALL deprecated by the 2026-05-19
//     cleanup and their on-chain feeClaimer IS master -> backfill master addr
//     (preserves their behavior; walletForToken returns master for that value).
//   - every token created since uses a sub-wallet (feeClaimer = derived sub)
//     -> backfill the derived sub address (this also REPAIRS refactor-era rows
//     whose old non-fatal derive step failed and were silently signing with
//     master, i.e. cause H actually manifesting).
//
// Auth: x-keeper-secret. Always dry-run first (?dryRun=1) and eyeball the plan.

function normalizeSecret(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function jsonErr(status: number, msg: string) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/admin/backfill-treasury-wallets")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = normalizeSecret(process.env.KEEPER_SECRET);
        if (!expected) return jsonErr(500, "KEEPER_SECRET not configured");
        const got = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (!got || got !== expected) return jsonErr(401, "unauthorized");

        const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

        const { data: rows, error } = await supabaseAdmin
          .from("tokens")
          .select("id, ticker, status, created_at, dbc_pool_address, mint_address")
          .is("treasury_wallet_address", null);
        if (error) return jsonErr(500, error.message);

        const master = getTreasuryKeypair().publicKey.toBase58();
        const plan = (rows ?? []).map((t) => {
          const cohort = t.status === "deprecated" ? "legacy_master" : "subwallet";
          return {
            id: t.id,
            ticker: t.ticker,
            status: t.status,
            created_at: t.created_at,
            launched: Boolean(t.dbc_pool_address || t.mint_address),
            cohort,
            wallet: cohort === "legacy_master" ? master : deriveSubWalletAddress(t.id),
          };
        });

        if (dryRun) {
          return Response.json({ ok: true, dryRun: true, count: plan.length, plan });
        }

        let updated = 0;
        for (const p of plan) {
          const { error: upErr } = await supabaseAdmin
            .from("tokens")
            .update({ treasury_wallet_address: p.wallet })
            .eq("id", p.id)
            .is("treasury_wallet_address", null); // idempotent: only fill nulls
          if (upErr) return jsonErr(500, `update ${p.id}: ${upErr.message}`);
          updated++;
        }
        return Response.json({ ok: true, dryRun: false, updated });
      },
    },
  },
});
