// Browser-side Jupiter (lite-api) swap helpers — SOL <-> SPL token swaps that the
// user's own wallet signs. Mirrors the keeper's quote/swap calls
// (keeper/src/constants.js: lite-api.jup.ag/swap/v1/{quote,swap}). lite-api is
// CORS-friendly for client use; if that ever changes, proxy these two fetches
// through a createServerFn and keep signing in the browser.

import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const FEE_BPS = 100; // 1% perpspad fee, added as a SOL transfer inside the swap tx
const JUP = "https://lite-api.jup.ag";

export type JupQuote = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  [k: string]: unknown;
};

/** GET a quote. `amount` is in base units (integer) of the input mint. */
export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: number | string;
  slippageBps: number;
}): Promise<JupQuote> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: String(params.slippageBps),
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false",
  });
  const res = await fetch(`${JUP}/swap/v1/quote?${qs.toString()}`);
  if (!res.ok) throw new Error(res.status === 400 ? "No route for this pair/size" : `Quote failed (${res.status})`);
  const json = await res.json();
  if (!json || json.error || !json.outAmount) throw new Error(json?.error ?? "No route");
  return json as JupQuote;
}

/** POST the quote to build a signable VersionedTransaction (base64). */
export async function buildSwapTx(params: {
  quoteResponse: JupQuote;
  userPublicKey: string;
}): Promise<string> {
  const res = await fetch(`${JUP}/swap/v1/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 2_000_000 },
      },
    }),
  });
  if (!res.ok) throw new Error(`Swap build failed (${res.status})`);
  const json = await res.json();
  if (!json?.swapTransaction) throw new Error(json?.error ?? "Swap build failed");
  return json.swapTransaction as string;
}

let _solUsd = { v: 0, at: 0 };
/** SOL price in USD (cached 30s). Same source as the rest of the app. */
export async function getSolUsd(): Promise<number> {
  if (_solUsd.v > 0 && Date.now() - _solUsd.at < 30_000) return _solUsd.v;
  try {
    const res = await fetch(`${JUP}/price/v3?ids=${SOL_MINT}`);
    if (!res.ok) return _solUsd.v;
    const json = (await res.json()) as Record<string, { usdPrice?: number }>;
    const p = Number(json?.[SOL_MINT]?.usdPrice ?? 0);
    if (p > 0) _solUsd = { v: p, at: Date.now() };
  } catch {
    /* keep last */
  }
  return _solUsd.v;
}

/** base64 (Jupiter swapTransaction) -> bytes, browser-safe (no Buffer). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type JupIx = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};
function toIx(ix: JupIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

/** Like buildSwapTx but returns the raw instruction set so we can append our own. */
async function getSwapInstructions(quoteResponse: JupQuote, userPublicKey: string) {
  const res = await fetch(`${JUP}/swap/v1/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 2_000_000 },
      },
    }),
  });
  if (!res.ok) throw new Error(`Swap build failed (${res.status})`);
  const j = await res.json();
  if (j?.error) throw new Error(j.error);
  return j as {
    computeBudgetInstructions?: JupIx[];
    setupInstructions?: JupIx[];
    swapInstruction: JupIx;
    cleanupInstruction?: JupIx;
    addressLookupTableAddresses?: string[];
  };
}

/**
 * Build ONE VersionedTransaction = the Jupiter swap + a 1% SOL fee transfer to
 * `feeWallet`. The fee is appended after the swap's cleanup (so any unwrapped
 * SOL is already on the wallet), and is computed by the caller from amounts it
 * already has — no extra price/quote call.
 */
export async function buildSwapWithFeeTx(params: {
  quoteResponse: JupQuote;
  userPublicKey: string;
  connection: Connection;
  feeWallet: string;
  feeLamports: number;
}): Promise<VersionedTransaction> {
  const user = new PublicKey(params.userPublicKey);
  const ins = await getSwapInstructions(params.quoteResponse, params.userPublicKey);

  const ixs: TransactionInstruction[] = [];
  for (const ix of ins.computeBudgetInstructions ?? []) ixs.push(toIx(ix));
  for (const ix of ins.setupInstructions ?? []) ixs.push(toIx(ix));
  ixs.push(toIx(ins.swapInstruction));
  if (ins.cleanupInstruction) ixs.push(toIx(ins.cleanupInstruction));
  if (params.feeLamports > 0) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: new PublicKey(params.feeWallet),
        lamports: params.feeLamports,
      }),
    );
  }

  const alts: AddressLookupTableAccount[] = [];
  for (const addr of ins.addressLookupTableAddresses ?? []) {
    const r = await params.connection.getAddressLookupTable(new PublicKey(addr));
    if (r.value) alts.push(r.value);
  }

  const { blockhash } = await params.connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);
  return new VersionedTransaction(msg);
}
