import { Connection, PublicKey } from '@solana/web3.js';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
const conn = new Connection(process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const amm = new CpAmm(conn);
const pool = new PublicKey('FkixVveAtBP9E8boefRWbVpMs5nyVk2uKW8PLVt9txUm');
const treasury = new PublicKey('9Kxfhk9JMckpzAmGm1hXFjdfdL4VjpHvBKu9p4kJWHB7');
const poolState = await amm.fetchPoolState(pool);
console.log('tokenAMint:', poolState.tokenAMint.toBase58());
console.log('tokenBMint:', poolState.tokenBMint.toBase58(), '(SOL=So111...)');
const positions = await amm.getUserPositionByPool(pool, treasury);
for (const p of positions) {
  const s = p.positionState;
  console.log('\nposition:', p.position.toBase58());
  console.log('  feeAPending:', s.feeAPending?.toString());
  console.log('  feeBPending:', s.feeBPending?.toString(), '(SOL lamports)');
  console.log('  unlockedLiquidity:', s.unlockedLiquidity?.toString());
  console.log('  permanentLockedLiquidity:', s.permanentLockedLiquidity?.toString());
}
