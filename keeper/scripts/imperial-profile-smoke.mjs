// Smoke test for the new imperial.js read helpers.
// Run: cd keeper && node scripts/imperial-profile-smoke.mjs
import 'dotenv/config';
import { getBalances, getProfile, getPositions, getOrders, MIN_COLLATERAL_USD } from '../src/imperial.js';

console.log(`MIN_COLLATERAL_USD = $${MIN_COLLATERAL_USD}\n`);

const bal = await getBalances();
console.log(`wallet: ${bal.wallet}`);
console.log(`profiles: ${bal.profiles.length}`);
for (const p of bal.profiles) {
  console.log(`  [${p.profileIndex}] ${p.profilePda}  $${(p.usdc / 1e6).toFixed(4)}`);
}

console.log('\ngetProfile(index=0):');
const main = await getProfile({ profileIndex: 0 });
console.log(`  wallet=${main.wallet}`);
console.log(`  pda=${main.profilePda}`);
console.log(`  usdc=$${main.usdcUi.toFixed(4)} (base=${main.usdcBase})`);

console.log('\ngetPositions(wallet):');
const pos = await getPositions(bal.wallet);
console.log(`  totalCount=${pos.totalCount} count=${pos.count}`);
console.log(`  lifetimePnl=$${pos.lifetimePnlUsd}  lifetimeFees=$${pos.lifetimeFeesUsd}`);
for (const p of pos.dataList) {
  console.log(
    `  - ${p.asset.padEnd(6)} ${p.side.padEnd(5)} src=${p.source.padEnd(15)} ` +
    `size=$${Number(p.sizeUsd).toFixed(2)} coll=$${Number(p.collateralUsd).toFixed(2)} ` +
    `lev=${Number(p.leverageX).toFixed(2)}x entry=${p.entryPrice} mark=${p.markPrice} ` +
    `pnl=$${Number(p.pnlUsd).toFixed(2)}`,
  );
}

console.log('\ngetOrders(wallet):');
const ord = await getOrders(bal.wallet);
console.log(`  total=${ord.totalCount}  jupiter=${ord.jupiterOrders.length}  passthrough=${ord.passthroughOrders.length}`);

console.log('\n=== ok ===');
