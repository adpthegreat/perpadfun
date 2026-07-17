import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HIDDEN_STATUS_PG_LIST } from "@/lib/launch/launchState";

// New world: DBC pools on Meteora are the source of truth for price/supply.
// Live token price comes from the on-chain pool. Perp mid is shown as a
// thesis reference for the underlying market.

const PERP_FEED = "https://api.hyperliquid.xyz/info";
const STANDARD_MIGRATION_SOL = 85; // rough threshold for graduation progress UI
// Floor displayed market cap. The DBC curve starts at ~34 SOL initial mcap,
// which is ~$5–6k at current SOL price, but Meteora's pricing function only
// realises that value once supply trades. We surface a flat $2.9k floor so a
// freshly-launched token isn't shown at $0 mcap on our site.
const INITIAL_MCAP_FLOOR_USD = 2900;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// USD price of a token's QUOTE asset. Pools store `sol_raised` /
// `current_price_sol` in the quote token's own units (SOL for SOL pools, but
// USDC for USDC pools, ANSEM for ANSEM pools, etc. — the column names are
// legacy). Valuing those at the SOL price for a non-SOL quote inflates market
// cap by solUsd/quoteUsd (e.g. ~77× for a $1 quote). Resolve the real quote
// price: SOL → live SOL mid; others → Jupiter USD price, USDC pinned to $1.
function resolveQuoteUsd(
  t: { quote_token?: string | null; quote_mint?: string | null },
  solUsd: number,
  quotePrices: Record<string, number>,
): number {
  const qm = t.quote_mint;
  if (!qm || qm === WSOL_MINT || (t.quote_token ?? "SOL") === "SOL") return solUsd;
  const p = Number(quotePrices[qm] ?? 0);
  if (p > 0) return p;
  return (t.quote_token ?? "") === "USDC" ? 1 : 0;
}

async function fetchJupiterPrices(mints: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(mints.filter(Boolean))];
  if (!ids.length) return {};
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids.join(",")}`);
    if (!res.ok) return {};
    const json = (await res.json()) as Record<string, { usdPrice?: number }>;
    return Object.fromEntries(
      Object.entries(json).map(([mint, quote]) => [mint, Number(quote.usdPrice ?? 0)]),
    );
  } catch {
    return {};
  }
}

// Best-effort ticker/symbol for an arbitrary quote mint (Jupiter token search).
// Used to label the pairing token on the token page for custom quotes; presets
// (SOL/USDC/ANSEM/UWU) already carry their own symbol. Null on any failure.
async function fetchTokenSymbol(mint: string): Promise<string | null> {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as unknown;
    const arr = Array.isArray(j) ? j : [];
    const found = (arr.find((x) => (x as { id?: string })?.id === mint) ?? arr[0]) as
      | { symbol?: string }
      | undefined;
    return found?.symbol ?? null;
  } catch {
    return null;
  }
}

// Pump.fun's bonding-curve API gives the *live* market cap (in SOL) for
// pre-graduation tokens. Jupiter often lags by minutes for fresh pumps,
// so we prefer pump.fun's number when available. Returns USD market caps.
async function fetchPumpFunMarketCaps(
  mints: string[],
  solUsd: number,
): Promise<Record<string, number>> {
  const ids = [...new Set(mints.filter(Boolean))];
  if (!ids.length || !solUsd) return {};
  const out: Record<string, number> = {};
  await Promise.all(
    ids.map(async (mint) => {
      try {
        const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
        if (!res.ok) return;
        const json = (await res.json()) as { market_cap?: number };
        const mcapSol = Number(json.market_cap ?? 0);
        if (mcapSol > 0) out[mint] = mcapSol * solUsd;
      } catch {
        // ignore
      }
    }),
  );
  return out;
}

export async function fetchAllMids(): Promise<Record<string, string>> {
  try {
    const res = await fetch(PERP_FEED, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, string>;
  } catch {
    return {};
  }
}

async function getMid(coin: string): Promise<number> {
  const mids = await fetchAllMids();
  return Number(mids[coin] ?? 0);
}

// Live perp position from Jupiter perps API for a treasury wallet.
// Returns null if no position open. Used as a fallback so the UI shows live
// positions even if the keeper hasn't (yet) written position_size_usd to DB,
// or when a position was opened outside the keeper's normal flow.
export type JupPerpPosition = {
  sizeUsd: number;
  collateralUsd: number;
  pnlUsd: number;
  side: "long" | "short";
  leverage: number;
  entryPriceUsd: number;
  markPriceUsd: number;
  liquidationPriceUsd: number;
  openedAtSec: number | null;
  positionPubkey: string;
};

const _jupPerpCache = new Map<string, { ts: number; data: JupPerpPosition | null }>();
const JUP_PERP_TTL_MS = 5_000;

export async function fetchJupiterPerpPosition(wallet: string): Promise<JupPerpPosition | null> {
  if (!wallet) return null;
  const cached = _jupPerpCache.get(wallet);
  const now = Date.now();
  if (cached && now - cached.ts < JUP_PERP_TTL_MS) return cached.data;
  try {
    const res = await fetch(`https://perps-api.jup.ag/v1/positions?walletAddress=${wallet}`);
    if (!res.ok) {
      _jupPerpCache.set(wallet, { ts: now, data: null });
      return null;
    }
    const json = (await res.json()) as { dataList?: Array<Record<string, string>> };
    const row = (json.dataList ?? [])[0];
    if (!row) {
      _jupPerpCache.set(wallet, { ts: now, data: null });
      return null;
    }
    const out: JupPerpPosition = {
      sizeUsd: Number(row.size ?? 0),
      collateralUsd: Number(row.collateral ?? 0),
      // Match Jupiter's UI "Unrealized PnL": price PnL excluding close fees
      // (fees only get realized on close). pnlBeforeFeesUsd is what shows on
      // the Jup positions row.
      pnlUsd: Number(row.pnlBeforeFeesUsd ?? row.pnlAfterFeesUsd ?? 0),
      side: String(row.side ?? "long").toLowerCase() === "short" ? "short" : "long",
      leverage: Number(row.leverage ?? 0),
      entryPriceUsd: Number(row.entryPrice ?? 0),
      markPriceUsd: Number(row.markPrice ?? 0),
      liquidationPriceUsd: Number(row.liquidationPrice ?? 0),
      openedAtSec: row.createdTime ? Number(row.createdTime) : null,
      positionPubkey: String(row.positionPubkey ?? ""),
    };
    _jupPerpCache.set(wallet, { ts: now, data: out });
    return out;
  } catch {
    _jupPerpCache.set(wallet, { ts: now, data: null });
    return null;
  }
}

// ---------- list tokens ----------
export const listTokens = createServerFn({ method: "GET" })
  .inputValidator((d: { tab?: "trending" | "new" | "graduated" } | undefined) =>
    z.object({ tab: z.enum(["trending", "new", "graduated"]).default("new") }).parse(d ?? {}),
  )
  .handler(async ({ data }) => {
    try {
      let q = supabaseAdmin
        .from("tokens")
        .select("*")
        .not("status", "in", HIDDEN_STATUS_PG_LIST)
        // Native perpspad tokens: must have an on-chain mint.
        // External routers (pump.fun, etc.): only show after the first fee has
        // actually been routed through our treasury. Without this gate, anyone
        // can create a claim_token row for an arbitrary pump.fun mint and have
        // it appear on the site even though no fees ever flowed.
        .or(
          "mint_address.not.is.null,and(external_mint.not.is.null,mint_pending.eq.false,first_fee_routed_at.not.is.null)",
        )
        .limit(500);
      if (data.tab === "graduated") {
        // External (pump.fun) tokens are always "graduated" in our model
        // (they only show up after fees have routed through our treasury,
        // which implies the bonding curve is past the relevant point).
        // Include them alongside native perpspad tokens whose migration has
        // actually completed.
        q = q
          .or("migration_status.in.(graduated,completed),source.eq.external")
          .order("created_at", { ascending: false });
      } else if (data.tab === "trending") {
        q = q.order("sol_raised", { ascending: false }).order("created_at", { ascending: false });
      } else q = q.order("created_at", { ascending: false });
      const { data: rows, error } = await q;
      if (error) throw error;

      const mids = await fetchAllMids();
      const solUsd = Number(mids["SOL"] ?? 0);
      const priceMints = (rows ?? [])
        .map((t) => t.mint_address || t.external_mint)
        .filter(Boolean) as string[];
      const pumpFunMints = (rows ?? [])
        .filter(
          (t) => t.source === "external" && t.external_platform === "pump_fun" && t.external_mint,
        )
        .map((t) => t.external_mint as string);
      const quoteMints = (rows ?? [])
        .map((t) => t.quote_mint)
        .filter((m): m is string => !!m && m !== WSOL_MINT);
      const [jupPrices, pumpFunMcaps, quotePrices] = await Promise.all([
        fetchJupiterPrices(priceMints),
        fetchPumpFunMarketCaps(pumpFunMints, solUsd),
        fetchJupiterPrices(quoteMints),
      ]);

      const enriched = (rows ?? []).map((t) => {
        const isExternal = t.source === "external";
        const mid = Number(mids[t.underlying] ?? 0);
        const solRaised = Number(t.sol_raised ?? 0);
        const quoteUsd = resolveQuoteUsd(t, solUsd, quotePrices);
        const reserveUsd = solRaised * quoteUsd;
        const graduated = t.migration_status === "graduated" || t.migration_status === "completed";
        const priceSol = Number(t.current_price_sol ?? 0);
        const supply = Number(t.total_supply ?? 1_000_000_000);
        const lookupMint = t.mint_address || t.external_mint;
        const jupPriceUsd = lookupMint ? Number(jupPrices[lookupMint] ?? 0) : 0;
        const priceUsd = jupPriceUsd || priceSol * quoteUsd;
        const fdvUsd = priceUsd * supply;
        const pumpFunMcap =
          t.external_platform === "pump_fun" && t.external_mint
            ? Number(pumpFunMcaps[t.external_mint] ?? 0)
            : 0;
        // Use real proxies when available (pump.fun mcap or Jupiter FDV).
        // Only fall back to INITIAL_MCAP_FLOOR_USD when BOTH are zero, so
        // tokens with a genuine sub-floor mcap (e.g. HYPU at ~$2.3k) aren't
        // bumped up to tie with every other dead/un-indexed external.
        const realProxy = Math.max(pumpFunMcap, fdvUsd);
        const marketCap = isExternal
          ? realProxy > 0
            ? realProxy
            : INITIAL_MCAP_FLOOR_USD
          : Math.max(fdvUsd, reserveUsd, INITIAL_MCAP_FLOOR_USD);
        return {
          id: t.id,
          ticker: t.ticker,
          name: t.name,
          description: t.description,
          imageUrl: t.image_url,
          underlying: t.underlying,
          leverage: Number(t.leverage),
          direction: t.direction as "long" | "short",
          priceUsd,
          changePct: 0,
          marketCap,
          reserveUsdc: reserveUsd,
          solRaised,
          supplySold: 0,
          graduated: isExternal ? true : graduated,
          graduationProgress: isExternal ? 1 : Math.min(1, solRaised / STANDARD_MIGRATION_SOL),
          createdAt: t.created_at,
          creatorAddress: t.creator_address,
          currentMid: mid,
          source: (t.source ?? "perpspad") as "perpspad" | "external",
          externalPlatform: t.external_platform as string | null,
          externalMint: t.external_mint as string | null,
          // Native DBC mint — exposed so the market search can match a pasted
          // mint address for perpspad-native coins too (external uses externalMint).
          mint: (t.mint_address ?? null) as string | null,
          router: (String(t.router ?? "imperial").toLowerCase() === "imperial"
            ? "imperial"
            : "jupiter") as "imperial" | "jupiter",
        };
      });

      enriched.sort((a, b) => {
        // Pin $PERPSPAD only on the trending tab. Elsewhere it sorts naturally.
        if (data.tab === "trending") {
          const aPerpspad = a.ticker?.toUpperCase() === "PERPSPAD" ? 1 : 0;
          const bPerpspad = b.ticker?.toUpperCase() === "PERPSPAD" ? 1 : 0;
          if (aPerpspad !== bPerpspad) return bPerpspad - aPerpspad;
        }
        if (data.tab === "new") {
          const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bt - at;
        }
        const mcapDiff = b.marketCap - a.marketCap;
        if (mcapDiff !== 0) return mcapDiff;
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      });
      return { tokens: enriched, error: null as string | null };
    } catch (e) {
      console.error("listTokens", e);
      return { tokens: [], error: "Failed to load tokens" };
    }
  });

export type EnrichedToken = Awaited<ReturnType<typeof listTokens>>["tokens"][number];

// ---------- resolve a token by mint (search fallback) ----------
// The market search filters the visible feed (limited/tabbed), so a pasted mint
// for a CONNECTED coin that isn't on the current page would find nothing. This
// resolves such a coin directly and surfaces it as a clickable card.
//
// CONNECTED-ONLY, on purpose (FEE_ROUTING_AND_MINT_INDEX.md §6): we apply the
// exact same visibility gate as the public feed — native by mint_address, external
// only once first_fee_routed_at is stamped (i.e. the on-chain creator-fee
// recipient matched the sub-wallet). This hides PENDING reservations, so a
// squatter's phantom router for a mint they don't own never shows in search, and
// the row we return is always the on-chain-recipient-matched one (the partial
// unique index guarantees at most one connected router per mint). Un-connected
// diagnostics live in the admin router-status panel, not public search.
export const findTokenByMint = createServerFn({ method: "GET" })
  .inputValidator((d: { mint: string }) =>
    z.object({ mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid mint") }).parse(d),
  )
  .handler(async ({ data }) => {
    const mint = data.mint.trim();
    const { data: rows } = await supabaseAdmin
      .from("tokens")
      .select(
        "id, ticker, name, image_url, underlying, leverage, direction, source, external_platform, external_mint, mint_address, mint_pending, first_fee_routed_at",
      )
      .not("status", "in", HIDDEN_STATUS_PG_LIST)
      // Same gate as listTokens: native (mint_address) OR a CONNECTED external
      // router (first_fee_routed_at stamped). Pending reservations are excluded.
      .or(`mint_address.eq.${mint},and(external_mint.eq.${mint},mint_pending.eq.false,first_fee_routed_at.not.is.null)`)
      .limit(1);

    const t = rows?.[0];
    if (!t) return { found: false as const, token: null };

    return {
      found: true as const,
      token: {
        id: t.id,
        ticker: t.ticker,
        name: t.name,
        imageUrl: t.image_url as string | null,
        underlying: t.underlying,
        leverage: Number(t.leverage),
        direction: t.direction as "long" | "short",
        source: (t.source ?? "perpspad") as "perpspad" | "external",
        externalPlatform: t.external_platform as string | null,
      },
    };
  });

// ---------- typeahead search (header auto-suggest) ----------
// Lightweight top-N matches for the global header search dropdown. Matches
// ticker / name (substring) OR an exact mint paste (external_mint / mint_address),
// under the SAME public visibility gate as the feed (native by mint, external only
// once connected). Returns just what a suggestion row needs.
export type TokenSuggestion = {
  id: string;
  ticker: string;
  name: string;
  imageUrl: string | null;
  source: "perpspad" | "external";
  externalPlatform: string | null;
};

export const searchTokens = createServerFn({ method: "GET" })
  .inputValidator((d: { q: string }) =>
    z.object({ q: z.string().trim().min(1).max(48) }).parse(d),
  )
  .handler(async ({ data }): Promise<{ results: TokenSuggestion[] }> => {
    // Sanitize for the PostgREST or-filter grammar (commas/parens/star are
    // delimiters/wildcards). Leaves ticker/name/mint chars intact.
    const q = data.q.replace(/[,()*%]/g, "").trim();
    if (!q) return { results: [] };

    const { data: rows, error } = await supabaseAdmin
      .from("tokens")
      .select("id, ticker, name, image_url, source, external_platform")
      .not("status", "in", HIDDEN_STATUS_PG_LIST)
      // visibility gate (same as listTokens / findTokenByMint)
      .or("mint_address.not.is.null,and(external_mint.not.is.null,mint_pending.eq.false,first_fee_routed_at.not.is.null)")
      // match: ticker/name substring OR exact mint paste
      .or(`ticker.ilike.*${q}*,name.ilike.*${q}*,external_mint.eq.${q},mint_address.eq.${q}`)
      .limit(8);

    if (error) return { results: [] };

    const results: TokenSuggestion[] = (rows ?? []).map((t) => ({
      id: t.id,
      ticker: t.ticker,
      name: t.name,
      imageUrl: t.image_url as string | null,
      source: (t.source ?? "perpspad") as "perpspad" | "external",
      externalPlatform: t.external_platform as string | null,
    }));
    // Rank exact-ish ticker prefix matches first, then the rest.
    const ql = q.toLowerCase();
    results.sort((a, b) => {
      const ap = a.ticker?.toLowerCase().startsWith(ql) ? 0 : 1;
      const bp = b.ticker?.toLowerCase().startsWith(ql) ? 0 : 1;
      return ap - bp;
    });
    return { results };
  });

// ---------- get one ----------
export const getToken = createServerFn({ method: "GET" })
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { data: t, error } = await supabaseAdmin
      .from("tokens")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error || !t) return { token: null, error: error?.message ?? "Not found" };

    let mid = 0;
    let solUsd = 0;
    try {
      const mids = await fetchAllMids();
      mid = Number(mids[t.underlying] ?? 0);
      solUsd = Number(mids["SOL"] ?? 0);
    } catch {
      // ignore
    }
    const solRaised = Number(t.sol_raised ?? 0);
    const graduated = t.migration_status === "graduated" || t.migration_status === "completed";
    const launchMid = Number(t.launch_mid ?? 0);
    const priceSol = Number(t.current_price_sol ?? 0);
    const supply = Number(t.total_supply ?? 1_000_000_000);
    const isExternal = t.source === "external";
    const lookupMint = t.mint_address || t.external_mint;
    const isPumpFun = isExternal && t.external_platform === "pump_fun" && !!t.external_mint;
    const quoteMint = (t.quote_mint as string | null) ?? null;
    const [jupPrices, pumpFunMcaps, quotePrices] = await Promise.all([
      fetchJupiterPrices(lookupMint ? [lookupMint] : []),
      isPumpFun
        ? fetchPumpFunMarketCaps([t.external_mint as string], solUsd)
        : Promise.resolve({} as Record<string, number>),
      fetchJupiterPrices(quoteMint && quoteMint !== WSOL_MINT ? [quoteMint] : []),
    ]);
    const jupPriceUsd = lookupMint ? Number(jupPrices[lookupMint] ?? 0) : 0;
    const quoteUsd = resolveQuoteUsd(t, solUsd, quotePrices);
    const reserveUsd = solRaised * quoteUsd;
    const priceUsd = jupPriceUsd || priceSol * quoteUsd;

    // Pairing (quote) token shown on the token page. Presets use their label as
    // the symbol; a custom quote resolves its symbol from Jupiter (fallback to a
    // truncated mint) so the page can say what the coin is actually paired with.
    const quoteLabel = (t.quote_token ?? "SOL") as string;
    let quoteSymbol = quoteLabel;
    if (quoteLabel === "CUSTOM" && quoteMint) {
      quoteSymbol =
        (await fetchTokenSymbol(quoteMint)) ??
        `${quoteMint.slice(0, 4)}…${quoteMint.slice(-4)}`;
    }
    const fdvUsd = priceUsd * supply;
    const pumpFunMcap = isPumpFun ? Number(pumpFunMcaps[t.external_mint as string] ?? 0) : 0;
    const realProxy = Math.max(pumpFunMcap, fdvUsd);
    const marketCap = isExternal
      ? realProxy > 0
        ? realProxy
        : INITIAL_MCAP_FLOOR_USD
      : Math.max(fdvUsd, reserveUsd, INITIAL_MCAP_FLOOR_USD);
    const tokenLinks = t as typeof t & { website_url?: string | null; twitter_url?: string | null };

    return {
      token: {
        id: t.id,
        ticker: t.ticker,
        name: t.name,
        description: t.description,
        imageUrl: t.image_url,
        websiteUrl: tokenLinks.website_url ?? null,
        twitterUrl: tokenLinks.twitter_url ?? null,
        underlying: t.underlying,
        leverage: Number(t.leverage),
        direction: t.direction as "long" | "short",
        priceUsd,
        launchPriceUsd: 0,
        changePct: 0,
        marketCap,
        reserveUsdc: reserveUsd,
        solRaised,
        solUsd,
        supplySold: 0,
        graduated,
        graduationProgress: Math.min(1, solRaised / STANDARD_MIGRATION_SOL),
        createdAt: t.created_at,
        creatorAddress: t.creator_address,
        currentMid: mid,
        baseMid: launchMid,
        basePriceUsd: 0,
        mintAddress: t.mint_address as string | null,
        externalMint: t.external_mint as string | null,
        externalPlatform: t.external_platform as string | null,
        source: (t.source ?? "perpspad") as "perpspad" | "external",
        router: (String(t.router ?? "imperial").toLowerCase() === "imperial"
          ? "imperial"
          : "jupiter") as "imperial" | "jupiter",
        dbcPoolAddress: t.dbc_pool_address as string | null,
        dbcConfigAddress: t.dbc_config_address as string | null,
        graduatedPoolAddress: t.graduated_pool_address as string | null,
        quoteToken: (t.quote_token === "USDC" ? "USDC" : "SOL") as "SOL" | "USDC",
        // Display-only pairing info (the real quote, incl. ANSEM/UWU/custom).
        quoteSymbol,
        quoteMint,
        curvePreset: t.curve_preset as string,
        raydiumPoolId: null as string | null,
        poolSeededAt: null as string | null,
        treasurySol: Number(t.treasury_sol ?? 0),
        feesAccruedUsd: Number(t.fees_accrued_usd ?? 0),
        treasuryWalletAddress: (t.treasury_wallet_address as string | null) ?? null,
      },
      error: null as string | null,
    };
  });

// ---------- recent trades (now on-chain; stub returns empty) ----------
export type TradeRow = {
  id: string;
  side: "buy" | "sell";
  amount_usdc: number;
  amount_tokens: number;
  price_usd: number;
  trader_address: string | null;
  created_at: string;
};

export const getRecentTrades = createServerFn({ method: "GET" })
  .inputValidator((d: { tokenId?: string; limit?: number } | undefined) =>
    z
      .object({
        tokenId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(25),
      })
      .parse(d ?? {}),
  )
  .handler(async (): Promise<{ trades: TradeRow[]; error: string | null }> => {
    return { trades: [], error: null };
  });

// ---------- holders (now on-chain; stub returns empty) ----------
export type HolderRow = {
  id: string;
  holder_address: string | null;
  balance: number;
};

export const getHolders = createServerFn({ method: "GET" })
  .inputValidator((d: { tokenId: string }) => z.object({ tokenId: z.string().uuid() }).parse(d))
  .handler(async (): Promise<{ holders: HolderRow[]; error: string | null }> => {
    return { holders: [], error: null };
  });

// ---------- wallet balance (now on-chain; stub returns 0) ----------
export const getMyBalance = createServerFn({ method: "GET" })
  .inputValidator((d: { tokenId: string; address: string }) =>
    z.object({ tokenId: z.string().uuid(), address: z.string().min(4).max(80) }).parse(d),
  )
  .handler(async () => {
    return { balance: 0 };
  });

// ---------- open perp positions (treasury-backed) ----------
export type OpenPerpPosition = {
  id: string;
  ticker: string;
  name: string;
  underlying: string;
  leverage: number;
  direction: "long" | "short";
  sizeUsd: number;
  pnlUsd: number;
  pnlPct: number;
  entryMid: number;
  currentMid: number;
  openedAt: string | null;
};

export const getOpenPerpPositions = createServerFn({ method: "GET" })
  .inputValidator((d: { limit?: number } | undefined) =>
    z.object({ limit: z.number().min(1).max(50).default(20) }).parse(d ?? {}),
  )
  .handler(async ({ data }): Promise<{ positions: OpenPerpPosition[]; error: string | null }> => {
    try {
      // Pull every live token that has a treasury wallet. We then merge in
      // each wallet's live Jupiter perps position so the sidebar reflects
      // on-chain reality even when the keeper hasn't yet written
      // position_size_usd / position_opened_at to the DB (or when a
      // position was opened outside the keeper's normal flow).
      const { data: rows, error } = await supabaseAdmin
        .from("tokens")
        .select(
          "id,ticker,name,underlying,leverage,direction,position_size_usd,position_collateral_usd,treasury_pnl_usd,launch_mid,last_tick_mid,position_opened_at,status,treasury_wallet_address,router",
        )
        .not("status", "in", HIDDEN_STATUS_PG_LIST)
        .not("treasury_wallet_address", "is", null);
      if (error) throw error;
      const mids = await fetchAllMids();
      const jupByWallet = new Map<string, JupPerpPosition | null>();
      await Promise.all(
        (rows ?? []).map(async (t) => {
          if (
            String((t as { router?: string | null }).router ?? "jupiter").toLowerCase() ===
            "imperial"
          )
            return;
          const w = t.treasury_wallet_address as string | null;
          if (!w || jupByWallet.has(w)) return;
          jupByWallet.set(w, await fetchJupiterPerpPosition(w));
        }),
      );
      const positions: OpenPerpPosition[] = (rows ?? [])
        .map((t) => {
          const entryMid = Number(t.launch_mid ?? 0);
          const currentMid = Number(mids[t.underlying] ?? t.last_tick_mid ?? entryMid);
          const dbSize = Number(t.position_size_usd ?? 0);
          const dbPnl = Number(t.treasury_pnl_usd ?? 0);
          const isImperial =
            String((t as { router?: string | null }).router ?? "jupiter").toLowerCase() ===
            "imperial";
          const jup =
            !isImperial && t.treasury_wallet_address
              ? (jupByWallet.get(t.treasury_wallet_address as string) ?? null)
              : null;
          const rawSizeUsd = jup?.sizeUsd && jup.sizeUsd > 0 ? jup.sizeUsd : dbSize;
          const collateralUsd = jup?.collateralUsd ?? Number(t.position_collateral_usd ?? 0);
          const lev = Math.max(1, Number(t.leverage ?? 1));
          // Imperial positions sometimes have a stale/doubled position_size_usd
          // in the DB (legacy bug). Clamp to collateral * leverage so the UI
          // never displays an impossible notional.
          const maxImperialSize = collateralUsd * lev;
          const sizeUsd =
            isImperial && collateralUsd > 0 ? Math.min(rawSizeUsd, maxImperialSize) : rawSizeUsd;
          // Live PnL: Jupiter gives us mark-to-market directly. For Imperial
          // (no live read here) derive it from the underlying mid so the UI
          // doesn't show a permanent $0.00 between keeper ticks.
          const dirSign = (t.direction as string) === "short" ? -1 : 1;
          const priceChangePct = entryMid > 0 ? ((currentMid - entryMid) / entryMid) * dirSign : 0;
          const livePnl = sizeUsd * priceChangePct;
          const pnlUsd = jup ? jup.pnlUsd : isImperial ? livePnl : dbPnl;
          const pnlPct =
            collateralUsd > 0 ? (pnlUsd / collateralUsd) * 100 : priceChangePct * lev * 100;
          return {
            id: t.id,
            ticker: t.ticker,
            name: t.name,
            underlying: t.underlying,
            leverage: jup?.leverage && jup.leverage > 0 ? jup.leverage : Number(t.leverage),
            direction:
              (jup?.side as "long" | "short" | undefined) ?? (t.direction as "long" | "short"),
            sizeUsd,
            pnlUsd,
            pnlPct,
            entryMid,
            currentMid,
            openedAt: t.position_opened_at,
          };
        })
        .filter((p) => p.sizeUsd > 0)
        .sort((a, b) => b.sizeUsd - a.sizeUsd)
        .slice(0, data.limit);
      return { positions, error: null };
    } catch (e) {
      console.error("getOpenPerpPositions", e);
      return { positions: [], error: "Failed to load positions" };
    }
  });

// Protocol-wide stats: total bought back (SOL spent on buybacks across perpspad
// + external/pump.fun routed tokens) and total volume (every SOL that moved
// through any treasury event — claims, buybacks, sweeps, perp opens, etc.).
export const getProtocolStats = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { data, error } = await supabaseAdmin
      .from("treasury_events")
      .select("kind, sol_amount")
      .not("sol_amount", "is", null);
    if (error) throw error;
    let buybackSol = 0;
    let volumeSol = 0;
    for (const r of data ?? []) {
      const sol = Number(r.sol_amount ?? 0);
      if (!sol) continue;
      volumeSol += sol;
      if (r.kind === "buyback" || r.kind === "external_buyback") buybackSol += sol;
    }
    return { buybackSol, volumeSol, error: null as string | null };
  } catch (e) {
    console.error("getProtocolStats", e);
    return { buybackSol: 0, volumeSol: 0, error: "Failed to load stats" };
  }
});
