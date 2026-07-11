import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getServerConnection, getTreasuryKeypair } from "@/lib/solana/treasury.server";
import { deriveSubWalletAddress } from "@/lib/solana/subWallet.server";
import { fetchJupiterPerpPosition, fetchAllMids } from "@/lib/tokens.functions";
import { maxLeverageFor } from "@/lib/imperial-markets";

export const getTreasuryPubkey = createServerFn({ method: "GET" }).handler(async () => {
  return { pubkey: getTreasuryKeypair().publicKey.toBase58() };
});

export const getLaunchFundingTarget = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        tokenId: z.string().uuid(),
        requiredLamports: z.number().int().min(0).max(6_000_000_000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const pubkey = deriveSubWalletAddress(data.tokenId);
    const balanceLamports = await getServerConnection().getBalance(
      new PublicKey(pubkey),
      "confirmed",
    );
    return {
      pubkey,
      balanceLamports,
      lamportsNeeded: Math.max(0, data.requiredLamports - balanceLamports),
    };
  });

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

async function auditExternalBuybacks({
  walletAddress,
  mintAddress,
}: {
  walletAddress: string | null;
  mintAddress: string | null;
}) {
  if (!walletAddress || !mintAddress) return { buybackSol: 0, tokensBurned: 0 };
  try {
    const conn = getServerConnection();
    const wallet = new PublicKey(walletAddress);
    const signatures = await conn.getSignaturesForAddress(wallet, { limit: 120 });
    let buybackSol = 0;
    let tokensBurned = 0;

    for (const s of signatures) {
      const tx = await conn.getParsedTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta || tx.meta.err) continue;

      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const walletIndex = keys.indexOf(walletAddress);
      const solDelta =
        walletIndex >= 0
          ? (tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex]) / 1e9
          : 0;
      const tokenBalance = (balances: typeof tx.meta.preTokenBalances) =>
        (balances ?? [])
          .filter((b) => b.mint === mintAddress && b.owner === walletAddress)
          .reduce((sum, b) => sum + Number(b.uiTokenAmount.amount ?? 0), 0);
      const tokenDelta =
        tokenBalance(tx.meta.postTokenBalances) - tokenBalance(tx.meta.preTokenBalances);

      if (tokenDelta > 0 && solDelta < -0.001) buybackSol += Math.abs(solDelta);
      if (tokenDelta < 0) tokensBurned += Math.abs(tokenDelta);
    }

    return { buybackSol, tokensBurned };
  } catch {
    return { buybackSol: 0, tokensBurned: 0 };
  }
}

export type TreasuryEvent = {
  id: string;
  kind:
    | "tick"
    | "buyback"
    | "burn"
    | "skim"
    | "open"
    | "close"
    | "claim"
    | "graduation"
    | "external_sweep"
    | "external_split_treasury"
    | "external_buyback"
    | "external_perp";
  mid: number | null;
  pnlDeltaUsd: number | null;
  solAmount: number | null;
  tokensAmount: number | null;
  note: string | null;
  txSig: string | null;
  createdAt: string;
};

export type TreasuryState = {
  treasurySol: number;
  tokensBurned: number;
  buybackSol: number;
  buybackUsd: number;
  profitsTakenUsd: number;
  positionSizeUsd: number;
  positionCollateralUsd: number;
  positionOpen: boolean;
  leverage: number;
  direction: "long" | "short";
  underlying: string;
  pnlUsd: number;
  lastTickMid: number | null;
  lastTickAt: string | null;
  feesAccruedUsd: number;
  feeGateUsd: number;
  topUpFeeGateUsd: number;
  openCollateralUsd: number;
  topUpCollateralUsd: number;
  pnlTriggerUsd: number;
  router: "jupiter" | "imperial";
  imperialProfilePda: string | null;
};

export const getTreasury = createServerFn({ method: "GET" })
  .inputValidator((d: { tokenId: string }) => z.object({ tokenId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { data: t, error: tErr } = await supabaseAdmin
      .from("tokens")
      .select(
        "id, leverage, direction, underlying, launch_mid, treasury_sol, tokens_burned, position_size_usd, position_collateral_usd, position_opened_at, last_tick_mid, last_tick_at, treasury_pnl_usd, fees_accrued_usd, treasury_wallet_address, router, imperial_profile_pda, external_mint, mint_address, total_supply",
      )
      .eq("id", data.tokenId)
      .maybeSingle();
    if (tErr || !t)
      return {
        treasuryPubkey: null as string | null,
        state: null,
        events: [] as TreasuryEvent[],
        lastBuyback: null as { sol: number; at: string; tx: string | null } | null,
        lastBurn: null as { tokens: number; at: string; tx: string | null } | null,
        error: "Not found",
      };

    const [{ data: recentRows }, { data: actionRows }] = await Promise.all([
      supabaseAdmin
        .from("treasury_events")
        .select("*")
        .eq("token_id", data.tokenId)
        .order("created_at", { ascending: false })
        .limit(40),
      supabaseAdmin
        .from("treasury_events")
        .select("*")
        .eq("token_id", data.tokenId)
        .in("kind", [
          "claim",
          "buyback",
          "burn",
          "skim",
          "open",
          "close",
          "external_sweep",
          "external_split_treasury",
          "external_buyback",
          "external_perp",
        ])
        .order("created_at", { ascending: false })
        .limit(30),
    ]);
    const eventById = new Map<string, NonNullable<typeof recentRows>[number]>();
    for (const e of [...(recentRows ?? []), ...(actionRows ?? [])]) eventById.set(e.id, e);
    const evs = [...eventById.values()]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 60);

    // Sum burns from all events (handles external tokens where the
    // tokens.tokens_burned column isn't kept in sync — burns land as
    // external_buyback / buyback / burn events with tokens_amount).
    const { data: burnRows } = await supabaseAdmin
      .from("treasury_events")
      .select("tokens_amount, sol_amount, pnl_delta_usd, kind, created_at, tx_sig")
      .eq("token_id", data.tokenId)
      .in("kind", ["burn", "buyback", "external_buyback"]);
    // Count each burn ONCE. The keeper emits a `buyback` AND a `burn` row for the
    // same internal burn (identical tokens_amount), so summing both double-counts.
    // Take `burn` (internal) + `external_buyback` (external, single row); skip
    // `buyback`. The sol/profit reducers below still use the `buyback` rows.
    const burnedFromEvents = (burnRows ?? []).reduce(
      (acc, r) =>
        r.kind === "burn" || r.kind === "external_buyback"
          ? acc + Number(r.tokens_amount ?? 0)
          : acc,
      0,
    );
    const buybackSol = (burnRows ?? []).reduce(
      (acc, r) =>
        r.kind === "buyback" || r.kind === "external_buyback"
          ? acc + Number(r.sol_amount ?? 0)
          : acc,
      0,
    );
    // Total realized profit locked in via take-profit — the FULL realizedActual,
    // not just the 25% treasury skim. The keeper tags each TP with a "buyback"-kind
    // event carrying pnl_delta_usd = realizedActual (loop.js TP step). The actual
    // buyback-drain "buyback" events have NO pnl_delta_usd, so this sums cleanly
    // (each TP counted once; drains contribute 0).
    const profitsTakenUsd = (burnRows ?? []).reduce(
      (acc, r) => (r.kind === "buyback" ? acc + Math.max(0, Number(r.pnl_delta_usd ?? 0)) : acc),
      0,
    );

    // Most-recent buyback + burn from the COMPLETE per-token event set (not the
    // truncated 60-row live feed, which drops these on active tokens — the
    // "no buybacks yet" bug). A buyback = a SOL-spending buyback/external_buyback
    // (excludes zero-SOL take-profit markers and stranded rows). A burn = a `burn`
    // row or an external buy+burn carrying tokens. created_at is ISO, so string
    // comparison is chronological.
    const latestBy = <T extends { created_at: string }>(rows: T[]): T | null =>
      rows.reduce<T | null>((a, r) => (!a || r.created_at > a.created_at ? r : a), null);
    const lbRow = latestBy(
      (burnRows ?? []).filter(
        (r) =>
          (r.kind === "buyback" || r.kind === "external_buyback") && Number(r.sol_amount ?? 0) > 0,
      ),
    );
    const bnRow = latestBy(
      (burnRows ?? []).filter(
        (r) =>
          r.kind === "burn" || (r.kind === "external_buyback" && Number(r.tokens_amount ?? 0) > 0),
      ),
    );
    const lastBuyback = lbRow
      ? { sol: Number(lbRow.sol_amount ?? 0), at: lbRow.created_at, tx: lbRow.tx_sig ?? null }
      : null;
    const lastBurn = bnRow
      ? {
          tokens: Number(bnRow.tokens_amount ?? 0) / 1e6,
          at: bnRow.created_at,
          tx: bnRow.tx_sig ?? null,
        }
      : null;

    const dir = String(t.direction ?? "long").toLowerCase() === "short" ? "short" : "long";
    const treasuryPubkey =
      (t.treasury_wallet_address as string | null) ?? getTreasuryKeypair().publicKey.toBase58();

    const isImperial = String(t.router ?? "jupiter").toLowerCase() === "imperial";

    // Live Jupiter position is only valid for Jupiter-routed tokens. Imperial
    // tokens use keeper-verified DB state, otherwise an unrelated Jupiter wallet
    // response can override the correct Imperial collateral/size in the UI.
    // For Imperial, launch_mid is maintained by the keeper as the venue's live
    // average entry. If older rows do not have it, fall back to tick history.
    const needsEntryFallback = isImperial && !t.launch_mid && !!t.position_opened_at;
    // Mint whose on-chain supply we read to derive the exact burned amount
    // (prefer the native mint; fall back to the external/pump.fun mint).
    const supplyMint =
      ((t as { mint_address?: string | null }).mint_address ??
        (t as { external_mint?: string | null }).external_mint) ||
      null;
    const [jup, solUsd, mids, tickHistory, chainBuybacks, onChainSupply] = await Promise.all([
      isImperial ? Promise.resolve(null) : fetchJupiterPerpPosition(treasuryPubkey),
      buybackSol > 0 || t.external_mint ? fetchSolUsd() : Promise.resolve(0),
      isImperial ? fetchAllMids() : Promise.resolve({} as Record<string, string>),
      needsEntryFallback
        ? supabaseAdmin
            .from("treasury_events")
            .select("mid, note, created_at")
            .eq("token_id", data.tokenId)
            .eq("kind", "tick")
            .not("mid", "is", null)
            .gte("created_at", t.position_opened_at as string)
            .order("created_at", { ascending: true })
            .limit(500)
        : Promise.resolve({ data: [] as Array<{ mid: number | null; note: string | null }> }),
      auditExternalBuybacks({
        walletAddress: treasuryPubkey,
        mintAddress: (t as { external_mint?: string | null }).external_mint ?? null,
      }),
      supplyMint
        ? getServerConnection()
            .getTokenSupply(new PublicKey(supplyMint), "confirmed")
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    const auditedBuybackSol = Math.max(buybackSol, chainBuybacks.buybackSol);
    // Burned amount, authoritative from on-chain supply: launch supply − current
    // total supply (burns are real SPL burns that reduce supply, so this equals
    // the amount burned and matches explorers exactly — no reliance on the
    // event/counter estimate that can drift or double-count). Fall back to the
    // event/counter max only when the supply read fails.
    let auditedBurnedBaseUnits = Math.max(
      burnedFromEvents,
      chainBuybacks.tokensBurned,
      Number(t.tokens_burned ?? 0),
    );
    const currentSupplyRaw = onChainSupply?.value?.amount
      ? Number(onChainSupply.value.amount)
      : NaN;
    if (Number.isFinite(currentSupplyRaw)) {
      const launchSupplyRaw =
        Number((t as { total_supply?: number | null }).total_supply ?? 1e9) * 1e6;
      const supplyDelta = launchSupplyRaw - currentSupplyRaw;
      if (supplyDelta >= 0 && Number.isFinite(supplyDelta)) auditedBurnedBaseUnits = supplyDelta;
    }

    // Walk tick history. Whenever parsed `coll=$X` increases vs prior tick,
    // attribute the delta-notional (delta_coll * leverage) as an entry at that
    // tick's mid. Sum (tokens_added * tick_mid) / sum(tokens_added) = avg entry.
    const lev = Math.max(1, Number(t.leverage ?? 1));
    let prevColl = 0;
    let entryNotionalSum = 0;
    let tokensSum = 0;
    for (const row of (tickHistory?.data ?? []) as Array<{
      mid: number | null;
      note: string | null;
    }>) {
      const m = Number(row.mid ?? 0);
      if (!m || m <= 0) continue;
      const collMatch = row.note?.match(/coll=\$([\d.]+)/);
      const coll = collMatch ? Number(collMatch[1]) : 0;
      if (coll > prevColl + 0.01) {
        const addedNotional = (coll - prevColl) * lev;
        const tokensAdded = addedNotional / m;
        entryNotionalSum += addedNotional;
        tokensSum += tokensAdded;
        prevColl = coll;
      } else if (coll > 0) {
        prevColl = coll;
      }
    }
    const weightedEntryMid = tokensSum > 0 ? entryNotionalSum / tokensSum : 0;

    const dbSize = Number(t.position_size_usd ?? 0);
    const dbColl = Number(t.position_collateral_usd ?? 0);
    const dbPnl = Number(t.treasury_pnl_usd ?? 0);
    const rawSizeUsd = jup?.sizeUsd && jup.sizeUsd > 0 ? jup.sizeUsd : dbSize;
    const collUsd = jup?.collateralUsd && jup.collateralUsd > 0 ? jup.collateralUsd : dbColl;
    const sizeUsd = rawSizeUsd;
    // Live PnL for Imperial: tokens_held * (currentMid - avgEntryMid) * dirSign.
    // Equivalent to sizeUsd * priceChangePct when sizeUsd is current notional.
    // Without this the UI shows a stale $0.00 between keeper ticks (keeper
    // currently writes pnl=0 because it has no entry-mid tracking either).
    const entryMid = Number(t.launch_mid ?? weightedEntryMid ?? 0);
    const currentMid = Number(
      mids[String(t.underlying ?? "SOL").toUpperCase()] ?? t.last_tick_mid ?? entryMid,
    );
    const dirSign = dir === "short" ? -1 : 1;
    const priceChangePct = entryMid > 0 ? ((currentMid - entryMid) / entryMid) * dirSign : 0;
    const imperialLivePnl = sizeUsd * priceChangePct;
    const pnlUsd = jup
      ? jup.pnlUsd
      : isImperial && sizeUsd > 0 && entryMid > 0
        ? imperialLivePnl
        : dbPnl;
    const positionOpen = !!jup || !!t.position_opened_at;

    // Display the NOMINAL leverage the position opened at — the creator's chosen
    // leverage clamped to the venue cap (minus the keeper's 0.5 safety margin),
    // e.g. 9.5x. NOT the venue's *effective* leverage (size/equity), which
    // collapses toward 1x as unrealized profit grows and made healthy positions
    // look broken on the token page. Stable across PnL swings + TP fires.
    // See plan/KEEPER_TP_REWRITE.md §12.
    const requestedLeverage = Number(t.leverage ?? 2);
    const venueCap = maxLeverageFor(String(t.underlying ?? ""));
    const nominalLeverage =
      venueCap > 0 ? Math.min(requestedLeverage, Math.max(1, venueCap - 0.5)) : requestedLeverage;

    return {
      treasuryPubkey,
      state: {
        treasurySol: Number(t.treasury_sol ?? 0),
        // Authoritative burned amount (on-chain supply delta when available,
        // else the event/counter fallback). Base units → whole tokens.
        tokensBurned: auditedBurnedBaseUnits / 1e6,
        buybackSol: auditedBuybackSol,
        buybackUsd: auditedBuybackSol * solUsd,
        profitsTakenUsd,

        positionSizeUsd: sizeUsd,
        positionCollateralUsd: collUsd,
        positionOpen,
        leverage: nominalLeverage,
        direction: (jup?.side ?? dir) as "long" | "short",
        underlying: String(t.underlying ?? "SOL").toUpperCase(),
        pnlUsd,
        lastTickMid: t.last_tick_mid != null ? Number(t.last_tick_mid) : null,
        lastTickAt: t.last_tick_at as string | null,
        feesAccruedUsd: Number(t.fees_accrued_usd ?? 0),
        feeGateUsd: 100,
        topUpFeeGateUsd: 100,
        openCollateralUsd: 50,
        topUpCollateralUsd: 50,
        pnlTriggerUsd: 5,
        router: (isImperial ? "imperial" : "jupiter") as "jupiter" | "imperial",
        imperialProfilePda:
          (t as { imperial_profile_pda?: string | null }).imperial_profile_pda ?? null,
      } as TreasuryState,

      events: evs.map((e) => ({
        id: e.id,
        kind: e.kind,
        mid: e.mid != null ? Number(e.mid) : null,
        pnlDeltaUsd: e.pnl_delta_usd != null ? Number(e.pnl_delta_usd) : null,
        solAmount: e.sol_amount != null ? Number(e.sol_amount) : null,
        tokensAmount: e.tokens_amount != null ? Number(e.tokens_amount) / 1e6 : null,
        note: e.note,
        txSig: (e as { tx_sig?: string | null }).tx_sig ?? null,
        createdAt: e.created_at,
      })) as TreasuryEvent[],

      lastBuyback,
      lastBurn,
      error: null as string | null,
    };
  });
