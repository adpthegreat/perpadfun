import { Connection, PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const c = new DynamicBondingCurveClient(conn, 'confirmed');
const pool = new PublicKey('Cx1wFKqd23Vx21DxuGpP4g8XmjShdp31yG3qyHtxvhTf');
const treasury = new PublicKey('9Kxfhk9JMckpzAmGm1hXFjdfdL4VjpHvBKu9p4kJWHB7');
const U64_MAX = new BN('18446744073709551615');
try {
  const tx = await c.partner.claimPartnerTradingFee2({
    feeClaimer: treasury, payer: treasury, pool,
    maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX, receiver: treasury,
  });
  console.log('OK tx ix count:', tx?.instructions?.length);
} catch (e) {
  console.log('ERR:', e.message);
}
