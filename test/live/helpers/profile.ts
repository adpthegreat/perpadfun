// Pick + fund a profile for a live round-trip. Reuses keeper's profileManager
// (the same picker the loop uses) so tests mirror production behaviour.
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { pickProfile, DEFAULT_MIN_USDC } from "../../../keeper/src/profileManager.js";
import { getBalances, getPositions } from "../../../keeper/src/imperial.js";
import { config } from "../../../keeper/src/config.js";
import { COLLATERAL_USD } from "./live.js";
import { liveRpcUrl } from "./rpc.js";
import type { LiveAuth } from "./auth.js";

interface ImperialProfileLike {
  profileIndex: number;
  profilePda?: string;
  usdc: number;
}
interface ImperialPositionLike {
  source?: string;
  status?: string;
  profileIndex?: number;
}

const USDC_DECIMALS = 6;

export async function getProfileUsdcUi(token: string, profileIndex: number): Promise<number> {
  const bal = await getBalances(token);
  const p = bal?.profiles?.find((x: ImperialProfileLike) => x.profileIndex === profileIndex);
  return Number(p?.usdc ?? 0) / 10 ** USDC_DECIMALS;
}

export async function fetchOpenPositions(
  token: string,
  wallet: string,
): Promise<ImperialPositionLike[]> {
  const raw = await getPositions(wallet, { token });
  const list = Array.isArray(raw?.dataList)
    ? raw.dataList
    : Array.isArray(raw)
      ? raw
      : raw?.positions || raw?.data || [];
  return list.filter(
    (p: ImperialPositionLike) =>
      (p?.source ?? "imperial") === "imperial" && (p?.status ?? "open") === "open",
  );
}

// Pick a profile, ensuring it has enough USDC for the round-trip. Deposits
// up to DEFAULT_MIN_USDC if it doesn't. Returns the chosen index + the
// USDC balance the profile ended up with.
export async function getProfilePda(token: string, profileIndex: number): Promise<string | null> {
  const bal = await getBalances(token);
  const p = bal?.profiles?.find((x: ImperialProfileLike) => x.profileIndex === profileIndex);
  return p?.profilePda ?? null;
}

export async function pickAndFundProfile(auth: LiveAuth): Promise<{
  profileIndex: number;
  profilePda: string | null;
  usdcUi: number;
  depositedSig: string | null;
}> {
  const override = process.env.LIVE_TEST_PROFILE_INDEX;
  let profileIndex: number;
  let needsDeposit = false;
  let depositAmountUi = DEFAULT_MIN_USDC;

  const bal = await getBalances(auth.token);
  const openList = await fetchOpenPositions(auth.token, auth.wallet);

  if (override !== undefined) {
    profileIndex = Number(override);
    const p = bal?.profiles?.find((x: ImperialProfileLike) => x.profileIndex === profileIndex);
    const ui = Number(p?.usdc ?? 0) / 10 ** USDC_DECIMALS;
    needsDeposit = ui < COLLATERAL_USD + 1;
  } else {
    const pick = pickProfile({
      profiles: bal?.profiles ?? [],
      positions: openList,
    });
    profileIndex = pick.profileIndex;
    needsDeposit = pick.needsDeposit;
    depositAmountUi = pick.depositAmountUi;
  }

  let depositedSig: string | null = null;
  if (needsDeposit) {
    depositedSig = await depositToProfile(auth, profileIndex, depositAmountUi);
  }
  const finalUi = await getProfileUsdcUi(auth.token, profileIndex);
  const pickedRow = bal?.profiles?.find(
    (x: ImperialProfileLike) => x.profileIndex === profileIndex,
  );
  const profilePda = pickedRow?.profilePda ?? null;
  return { profileIndex, profilePda, usdcUi: finalUi, depositedSig };
}

async function depositToProfile(
  auth: LiveAuth,
  profileIndex: number,
  usdAmountUi: number,
): Promise<string> {
  // We don't need a separate import of imperialDeposit — the deposit/build-tx
  // POST is what we want, and we already have call() via authenticated fetch.
  // Use the same body shape as imperial-order-probe.mjs:121-136.
  const baseUrl = config.imperial.baseUrl;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
  };
  if (config.imperial.apiKey) headers["x-api-key"] = config.imperial.apiKey;

  const res = await fetch(`${baseUrl}/deposit/build-tx`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      wallet: auth.wallet,
      profileIndex,
      amount: Math.round(usdAmountUi * 10 ** USDC_DECIMALS),
      mode: "deposit",
    }),
  });
  if (!res.ok) throw new Error(`deposit/build-tx ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!body?.transaction)
    throw new Error(`deposit/build-tx no transaction: ${JSON.stringify(body)}`);

  const conn = new Connection(liveRpcUrl(), "confirmed");
  const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
  tx.sign([auth.kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, "confirmed");
  if (conf.value.err) throw new Error(`deposit on-chain err: ${JSON.stringify(conf.value.err)}`);

  // Poll Imperial's indexer until it sees the new balance.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const ui = await getProfileUsdcUi(auth.token, profileIndex);
    if (ui >= COLLATERAL_USD) return sig;
  }
  throw new Error("Imperial indexer didn't see deposit within 60s");
}
