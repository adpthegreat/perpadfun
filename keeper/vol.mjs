import { Connection, PublicKey } from "@solana/web3.js";
const RPC = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");
const POOL = new PublicKey("GrdVCkbBjoTVcfXCj4SWMQNZZDCmEKGzfW7RY9WytVdr");

const sigs = await conn.getSignaturesForAddress(POOL, { limit: 200 });
console.log("tx count (last 200 max):", sigs.length);
if (sigs.length) {
  const oldest = sigs[sigs.length-1].blockTime;
  const newest = sigs[0].blockTime;
  console.log("span:", ((newest-oldest)/3600).toFixed(2), "hours");
}

// pull SOL flow per tx via balance changes on pool's wSOL vault
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const client = new DynamicBondingCurveClient(conn, "confirmed");
const pool = await client.state.getPool(POOL);
console.log("baseReserve:", pool.baseReserve.toString());
console.log("quoteReserve (lamports):", pool.quoteReserve.toString());
console.log("quoteReserve (SOL):", Number(pool.quoteReserve)/1e9);

// volume estimate via parsed txs
let totalSolVolume = 0;
let swaps = 0;
const recent = sigs.slice(0, 50);
for (const s of recent) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const pre = tx.meta?.preBalances || [];
  const post = tx.meta?.postBalances || [];
  // find max abs SOL delta
  let maxDelta = 0;
  for (let i=0;i<pre.length;i++){
    const d = Math.abs((post[i]||0)-(pre[i]||0));
    if (d>maxDelta) maxDelta=d;
  }
  if (maxDelta > 1000) { swaps++; totalSolVolume += maxDelta/1e9; }
}
console.log(`recent ${recent.length} txs: ~${swaps} swaps, est SOL volume ~${totalSolVolume.toFixed(4)} SOL`);
