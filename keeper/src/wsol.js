// Close the keeper's wSOL ATA (if it exists) so any wSOL received from a swap
// settlement is unwrapped back to native SOL on the owner. The buyback path
// spends native SOL, so without this the realized PnL would sit as wSOL forever.
//
// Moved out of the legacy jupiterPerps.js (see plan/REMOVE_JUPITER_PERPS.md) into
// a neutral self-contained module — it's generic wSOL cleanup, not perp-specific.
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createCloseAccountInstruction } from '@solana/spl-token';
import { config } from './config.js';
import { WSOL_MINT } from './constants.js';

const WSOL_PK = new PublicKey(WSOL_MINT);
let _conn = null;
function conn() {
  if (!_conn) _conn = new Connection(config.rpcUrl, 'confirmed');
  return _conn;
}

export async function unwrapWsol(kp) {
  if (!kp) return { closed: false, reason: 'no signer' };
  const c = conn();
  const ata = await getAssociatedTokenAddress(WSOL_PK, kp.publicKey);
  const info = await c.getAccountInfo(ata, 'confirmed');
  if (!info) return { closed: false, reason: 'no ata' };
  try {
    const ix = createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey);
    const { blockhash } = await c.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    const sig = await c.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    await c.confirmTransaction(sig, 'confirmed');
    return { closed: true, signature: sig };
  } catch (e) {
    return { closed: false, reason: e.message };
  }
}
