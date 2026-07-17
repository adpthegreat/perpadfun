// Acquire a launch's quote token by swapping SOL for (at least) the amount the
// dev-buy needs. Used by /launch when a creator wants a dev-buy denominated in
// a quote token (ANSEM, a custom mint, USDC…) they don't already hold. The swap
// is a standalone transaction the user signs; the launch flow runs unchanged
// afterwards, once the balance is sufficient.
//
// Jupiter ExactOut is NOT supported for most memecoin routes (pump.fun / bonding
// pools return NO_ROUTES_FOUND), so we can't ask for an exact output. Instead we
// size the SOL input via ExactIn quotes so the output covers the shortfall plus
// a small buffer for slippage/impact — any surplus stays in the creator's wallet.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUP_SWAP = "https://lite-api.jup.ag/swap/v1/swap";
const SWAP_SLIPPAGE_BPS = 100;
// Buy ~3% extra so slippage/price-impact between quoting and landing never
// leaves the dev-buy short. The surplus is the creator's to keep.
const TARGET_BUFFER = 1.03;
// Reference probe used to learn the SOL→token rate before sizing the real swap.
const PROBE_LAMPORTS = 50_000_000; // 0.05 SOL

export type SwapPlan = {
  inLamports: number; // SOL to spend (raw)
  outRaw: number; // token received (raw) — always >= the requested target
  priceImpactPct: number;
  raw: unknown; // Jupiter quoteResponse, passed straight back to the swap call
};

type JupQuote = { outAmount?: string; inAmount?: string; priceImpactPct?: string | number };

// base64 -> bytes without depending on Buffer (browser-safe).
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Raw balance of `mint` held by `owner` (sums its token accounts). Program-
// agnostic: the mint filter finds the account whether it's SPL or Token-2022,
// so an ANSEM (Token-2022) balance is read the same as a USDC one. 0 if none.
export async function quoteTokenBalanceRaw(
  connection: Connection,
  owner: PublicKey,
  mint: string,
): Promise<number> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  return res.value.reduce(
    (sum, a) => sum + Number(a.account.data.parsed?.info?.tokenAmount?.amount ?? 0),
    0,
  );
}

async function jupExactIn(outputMint: string, inLamports: number): Promise<JupQuote | null> {
  const url =
    `${JUP_QUOTE}?inputMint=${WSOL_MINT}&outputMint=${outputMint}` +
    `&amount=${Math.max(1, Math.floor(inLamports))}&swapMode=ExactIn&slippageBps=${SWAP_SLIPPAGE_BPS}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) return null;
  const q = (await r.json()) as JupQuote;
  return q?.outAmount && Number(q.outAmount) > 0 ? q : null;
}

// Plan a SOL->quote swap whose output is AT LEAST `targetOutRaw`. Sizes the SOL
// input from a rate probe, then refines against real (impact-priced) quotes.
// null if no route or the size can't be covered.
export async function planSwapForTarget(
  outputMint: string,
  targetOutRaw: number,
): Promise<SwapPlan | null> {
  if (!Number.isFinite(targetOutRaw) || targetOutRaw <= 0) return null;

  const probe = await jupExactIn(outputMint, PROBE_LAMPORTS);
  if (!probe) return null;

  let inLamports = Math.ceil(
    (targetOutRaw / Number(probe.outAmount)) * PROBE_LAMPORTS * TARGET_BUFFER,
  );
  let plan = await jupExactIn(outputMint, inLamports);
  // Refine up to twice if price impact at the real size left us short.
  for (let i = 0; i < 2 && plan && Number(plan.outAmount) < targetOutRaw; i++) {
    inLamports = Math.ceil(inLamports * (targetOutRaw / Number(plan.outAmount)) * TARGET_BUFFER);
    plan = await jupExactIn(outputMint, inLamports);
  }
  if (!plan || Number(plan.outAmount) < targetOutRaw) return null;
  return {
    inLamports,
    outRaw: Number(plan.outAmount),
    priceImpactPct: Number(plan.priceImpactPct ?? 0),
    raw: plan,
  };
}

// Build, sign, send, and confirm the SOL->quote swap for a prior plan.
// Returns the confirmed signature.
export async function executeSwap(opts: {
  connection: Connection;
  publicKey: PublicKey;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  plan: SwapPlan;
}): Promise<string> {
  const { connection, publicKey, signTransaction, plan } = opts;
  const r = await fetch(JUP_SWAP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      quoteResponse: plan.raw,
      userPublicKey: publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!r.ok) throw new Error(`Could not build the swap (${r.status}).`);
  const j = (await r.json()) as { swapTransaction?: string; lastValidBlockHeight?: number };
  if (!j.swapTransaction) throw new Error("Swap builder returned no transaction.");
  const tx = VersionedTransaction.deserialize(b64ToBytes(j.swapTransaction));
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: j.lastValidBlockHeight ?? (await connection.getBlockHeight()) + 150,
    },
    "confirmed",
  );
  return sig;
}
