import { Connection, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk';

const RPC = process.env.SOLANA_RPC_URL;
const conn = new Connection(RPC, 'confirmed');
const client = new DynamicBondingCurveClient(conn, 'confirmed');

const POOL = new PublicKey('GrdVCkbBjoTVcfXCj4SWMQNZZDCmEKGzfW7RY9WytVdr');
const CFG = new PublicKey('D7Vy1WsnnKsTquDyjAyyX1t7FS9RzeULspThWgibcBtu');

const pool = await client.state.getPool(POOL);
const cfg = await client.state.getPoolConfig(CFG);

const quoteRes = BigInt(pool.quoteReserve.toString()) / 1_000_000_000n;
const sqrtPrice = pool.sqrtPrice?.toString();
const price = sqrtPrice ? Number(getPriceFromSqrtPrice(pool.sqrtPrice, 6, 9).toString()) : 0;

console.log('POOL STATE');
console.log('  quoteReserve (SOL):', Number(pool.quoteReserve.toString()) / 1e9);
console.log('  sqrtPrice:', sqrtPrice);
console.log('  current price (SOL/token):', price);
console.log('  isMigrated:', pool.isMigrated);

const thresh = await client.state.getPoolMigrationQuoteThreshold(POOL);
console.log('  migration threshold (SOL):', Number(thresh.toString()) / 1e9);

const progQ = await client.state.getPoolQuoteTokenCurveProgress(POOL);
const progB = await client.state.getPoolBaseTokenCurveProgress(POOL);
console.log('  quote progress:', progQ);
console.log('  base progress:', progB);

console.log('\nCONFIG');
console.log('  migrationQuoteThreshold:', cfg.migrationQuoteThreshold?.toString());
console.log('  migrationOption:', cfg.migrationOption);
console.log('  migrationFeeOption:', cfg.migrationFeeOption);
console.log('  tokenType:', cfg.tokenType);
console.log('  quoteMint:', cfg.quoteMint?.toString?.());
console.log('  sqrtStartPrice:', cfg.sqrtStartPrice?.toString());
console.log('  migrationSqrtPrice:', cfg.migrationSqrtPrice?.toString());
console.log('  tokenSupply:', JSON.stringify(cfg.tokenSupply));
console.log('  curve points:', cfg.curve?.length);
