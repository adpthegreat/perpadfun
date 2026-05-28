import { Connection, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
const conn = new Connection(process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const client = new DynamicBondingCurveClient(conn, "confirmed");
const poolArg = process.argv[2] || process.env.DBC_POOL_ADDRESS;
if (!poolArg) {
  console.error("Usage: node fees.mjs <DBC_POOL_ADDRESS>");
  process.exit(1);
}
const POOL = new PublicKey(poolArg);
const pool = await client.state.getPool(POOL);
console.log("config:", pool.config.toString());
const cfg = await client.state.getPoolConfig(pool.config);
console.log("poolFees:", JSON.stringify(cfg.poolFees, (k,v)=>typeof v==="bigint"||v?.toNumber?v.toString():v, 2));
console.log("creator (partner) trading fee pct:", cfg.poolFees?.protocolFeePercent, "creator pct:", cfg.poolFees?.creatorTradingFeePercent ?? cfg.creatorTradingFeePercentage);
console.log("creator pct field:", cfg.creatorTradingFeePercentage);
// fee metrics on pool
console.log("pool metrics:", JSON.stringify(pool.metrics, (k,v)=>v?.toString?v.toString():v, 2));
console.log("partnerBaseFee:", pool.partnerBaseFee?.toString(), "partnerQuoteFee:", pool.partnerQuoteFee?.toString());
console.log("creatorBaseFee:", pool.creatorBaseFee?.toString(), "creatorQuoteFee:", pool.creatorQuoteFee?.toString());
console.log("partnerQuoteSol:", Number(pool.partnerQuoteFee?.toString?.() ?? 0) / 1e9);
console.log("creatorQuoteSol:", Number(pool.creatorQuoteFee?.toString?.() ?? 0) / 1e9);
