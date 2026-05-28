// Read the pending creator-fee SOL accumulating in a pump.fun coin's
// `creator_vault` PDA plus the routed sub-wallet SOL already claimed. Mirrors
// the keeper's pumpfunClaim.js/externalRouters.js gates so the UI can display
// the true dollar amount available for the next sweep.
//
// Layout reference: keeper/src/pumpfunClaim.js
//   bonding_curve   = PDA(["bonding-curve", mint], pumpProgram)
//   sharing_config  = bonding_curve.creator (32 bytes @ offset 49)
//   creator_vault   = PDA(["creator-vault", sharing_config], pumpProgram)
//   vault SOL       = lamports(creator_vault) + WSOL(ATA(creator_vault, WSOL))

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getServerConnection } from "@/lib/solana/treasury.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Must match keeper defaults (see pumpfunClaim.js and externalRouters.js).
const MIN_VAULT_USD = 100;

function deriveAmmCoinCreatorVaultAuthority(creator: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), creator.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  );
  return pda;
}

async function fetchSolUsd(): Promise<number> {
  try {
    const res = await fetch(
      "https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112",
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) return 0;
    const j = (await res.json()) as Record<string, { usdPrice?: number }>;
    const p = j["So11111111111111111111111111111111111111112"]?.usdPrice;
    return typeof p === "number" && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

function deriveBondingCurve(mint: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

function deriveCreatorVault(sharingConfig: PublicKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), sharingConfig.toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

export const getPumpFunVault = createServerFn({ method: "GET" })
  .inputValidator((input: { mint: string }) =>
    z.object({ mint: z.string().min(32).max(64) }).parse(input),
  )
  .handler(async ({ data }) => {
    try {
      const conn = getServerConnection();
      const mintPk = new PublicKey(data.mint);
      const { data: tokenRow } = await supabaseAdmin
        .from("tokens")
        .select("treasury_wallet_address")
        .eq("external_mint", data.mint)
        .maybeSingle();
      const routeWallet = tokenRow?.treasury_wallet_address
        ? new PublicKey(tokenRow.treasury_wallet_address as string)
        : null;
      const bondingCurve = deriveBondingCurve(mintPk);
      const bcAcct = await conn.getAccountInfo(bondingCurve, "confirmed");
      if (!bcAcct || bcAcct.data.length < 49 + 32) {
        return { ok: false as const, error: "bonding_curve missing" };
      }
      const sharingConfig = new PublicKey(bcAcct.data.slice(49, 49 + 32));
      const creatorVault = deriveCreatorVault(sharingConfig);
      const creatorVaultQuote = getAssociatedTokenAddressSync(WSOL_MINT, creatorVault, true);

      // pump-amm sharing-config vault: graduated pump.fun fees accrue under
      // bondingCurve.creator, which is the sharing config PDA for routed coins.
      const sharingAmmVaultAuthority = deriveAmmCoinCreatorVaultAuthority(sharingConfig);
      const sharingAmmVaultAta = getAssociatedTokenAddressSync(WSOL_MINT, sharingAmmVaultAuthority, true);

      // Also probe the route wallet AMM vault for direct-creator coins without
      // a sharing config. De-dupe below if both resolve to the same ATA.
      const routeAmmVaultAuthority = routeWallet ? deriveAmmCoinCreatorVaultAuthority(routeWallet) : null;
      const routeAmmVaultAta = routeAmmVaultAuthority
        ? getAssociatedTokenAddressSync(WSOL_MINT, routeAmmVaultAuthority, true)
        : null;

      const shouldProbeRouteAmm = routeAmmVaultAta && routeAmmVaultAta.toBase58() !== sharingAmmVaultAta.toBase58();
      const [solLamports, ataInfo, routeLamports, sharingAmmAtaInfo, routeAmmAtaInfo, solUsd] = await Promise.all([
        conn.getBalance(creatorVault, "confirmed"),
        conn.getAccountInfo(creatorVaultQuote, "confirmed"),
        routeWallet ? conn.getBalance(routeWallet, "confirmed") : Promise.resolve(0),
        conn.getAccountInfo(sharingAmmVaultAta, "confirmed"),
        shouldProbeRouteAmm ? conn.getAccountInfo(routeAmmVaultAta, "confirmed") : Promise.resolve(null),
        fetchSolUsd(),
      ]);
      let vaultSol = solLamports / LAMPORTS_PER_SOL;
      if (ataInfo && ataInfo.data && ataInfo.data.length >= 72) {
        const wsolLamports = Number(ataInfo.data.readBigUInt64LE(64));
        vaultSol += wsolLamports / LAMPORTS_PER_SOL;
      }
      // Fold pump-amm coin-creator vault WSOL into the "unclaimed" figure.
      for (const ammAtaInfo of [sharingAmmAtaInfo, routeAmmAtaInfo]) {
        if (!ammAtaInfo || !ammAtaInfo.data || ammAtaInfo.data.length < 72) continue;
        const wsolLamports = Number(ammAtaInfo.data.readBigUInt64LE(64));
        vaultSol += wsolLamports / LAMPORTS_PER_SOL;
      }
      const routeWalletSol = routeLamports / LAMPORTS_PER_SOL;
      const totalSol = vaultSol + routeWalletSol;
      const vaultUsd = solUsd > 0 ? vaultSol * solUsd : 0;
      const routeWalletUsd = solUsd > 0 ? routeWalletSol * solUsd : 0;
      const totalUsd = solUsd > 0 ? totalSol * solUsd : 0;
      return {
        ok: true as const,
        vaultSol,
        vaultUsd,
        routeWalletSol,
        routeWalletUsd,
        totalSol,
        totalUsd,
        solUsd,
        minClaimUsd: MIN_VAULT_USD,
        creatorVault: creatorVault.toBase58(),
        routeWallet: routeWallet?.toBase58() ?? null,
      };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "vault probe failed",
      };
    }
  });
