import 'dotenv/config';

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function fingerprint(value) {
  if (!value) return null;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

export function describeRpcUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const key = url.searchParams.get('api-key') ?? url.searchParams.get('apikey') ?? url.searchParams.get('key');
    for (const name of ['api-key', 'apikey', 'key', 'token']) {
      if (url.searchParams.has(name)) url.searchParams.set(name, '[redacted]');
    }
    return {
      host: url.host,
      path: url.pathname,
      redactedUrl: url.toString(),
      keyFingerprint: fingerprint(key),
    };
  } catch {
    return {
      host: 'invalid-url',
      path: '',
      redactedUrl: '[invalid RPC URL]',
      keyFingerprint: null,
    };
  }
}

// PERP_HEDGE_MODE:
//   'off'      -> never build/submit perp tx. Stub only. (default, safest)
//   'simulate' -> build real tx, RPC-simulate, log result. No submission.
//   'live'     -> build, simulate, then submit. Real positions get opened.
const RAW_MODE = (process.env.PERP_HEDGE_MODE || 'off').toLowerCase();
const HEDGE_MODE = ['off', 'simulate', 'live'].includes(RAW_MODE) ? RAW_MODE : 'off';

// --- Imperial Exchange (routing layer; off by default) ---
const RAW_IMP_ROUTING = (process.env.IMPERIAL_ROUTING_MODE || 'off').toLowerCase();
const IMP_ROUTING_MODE = ['off', 'shadow', 'live'].includes(RAW_IMP_ROUTING) ? RAW_IMP_ROUTING : 'off';
const RAW_IMP_POSITION = (process.env.IMPERIAL_POSITION_MODE || 'off').toLowerCase();
const IMP_POSITION_MODE = ['off', 'open-only', 'full'].includes(RAW_IMP_POSITION) ? RAW_IMP_POSITION : 'off';
// off    -> never deposit fees into Imperial profiles
// shadow -> log what we WOULD deposit, no on-chain action
// live   -> actually sign and submit /deposit/build-tx
const RAW_IMP_DEPOSIT = (process.env.IMPERIAL_DEPOSIT_MODE || 'off').toLowerCase();
const IMP_DEPOSIT_MODE = ['off', 'shadow', 'live'].includes(RAW_IMP_DEPOSIT) ? RAW_IMP_DEPOSIT : 'off';

const RAW_BUYBACK_FROM_FEES_RATIO = Math.min(1, Math.max(0, Number(process.env.BUYBACK_FROM_FEES_RATIO ?? 0.25)));
const RAW_PERP_MARGIN_RATIO = Math.min(1, Math.max(0, Number(process.env.PERP_MARGIN_RATIO ?? 0.5)));
const RAW_TREASURY_HOLD_RATIO = Math.min(1, Math.max(0, Number(process.env.TREASURY_HOLD_RATIO ?? 0.25)));
const BUYBACK_FROM_FEES_RATIO = RAW_BUYBACK_FROM_FEES_RATIO;
const PERP_MARGIN_RATIO = Math.min(RAW_PERP_MARGIN_RATIO, Math.max(0, 1 - BUYBACK_FROM_FEES_RATIO));
const TREASURY_HOLD_RATIO = Math.min(RAW_TREASURY_HOLD_RATIO, Math.max(0, 1 - BUYBACK_FROM_FEES_RATIO - PERP_MARGIN_RATIO));

export const config = {
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  treasuryKey: req('TREASURY_SOLANA_PRIVATE_KEY'),
  perpadBaseUrl: process.env.PERPAD_BASE_URL || 'https://perpad.fun',
  keeperSecret: req('KEEPER_SECRET'),
  loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS ?? 6_000),
  externalSweepTickMs: Number(process.env.EXTERNAL_SWEEP_TICK_MS ?? 30_000),
  port: Number(process.env.PORT ?? 8080),

  // --- hedge economics ---
  hedgeMode: HEDGE_MODE,
  feeGateUsd: Number(process.env.FEE_GATE_USD ?? 20),
  openCollateralUsd: Number(process.env.OPEN_COLLATERAL_USD ?? 20),
  topUpFeeGateUsd: Number(process.env.TOPUP_FEE_GATE_USD ?? 20),
  topUpCollateralUsd: Number(process.env.TOPUP_COLLATERAL_USD ?? 20),
  minDepositUsd: Number(process.env.MIN_DEPOSIT_USD ?? 2),
  walletSolReserve: Number(process.env.WALLET_SOL_RESERVE ?? 0.01),
  minTopUpUsd: Number(process.env.MIN_TOPUP_USD ?? 25),
  pnlTriggerUsd: Number(process.env.PNL_TRIGGER_USD ?? 25),
  pnlRealizeMaxUsd: Number(process.env.PNL_REALIZE_MAX_USD ?? 250),
  leverageCapMult: Number(process.env.LEVERAGE_CAP_MULT ?? 2),
  minLiqBufferPct: Number(process.env.MIN_LIQ_BUFFER_PCT ?? 0.25),
  slippageBps: Number(process.env.HEDGE_SLIPPAGE_BPS ?? 100),
  maxBuybackPerTickUsd: Number(process.env.MAX_BUYBACK_PER_TICK_USD ?? 25),

  // --- fee split ---
  buybackFromFeesRatio: BUYBACK_FROM_FEES_RATIO,
  perpMarginRatio: PERP_MARGIN_RATIO,
  minBuybackSol: Number(process.env.MIN_BUYBACK_SOL ?? 0.0005),
  minBuybackUsd: Number(process.env.MIN_BUYBACK_USD ?? 25),
  treasuryHoldRatio: TREASURY_HOLD_RATIO,

  // --- Imperial Exchange routing layer ---
  imperial: {
    enabled: String(process.env.IMPERIAL_ENABLED ?? 'false').toLowerCase() === 'true',
    baseUrl: process.env.IMPERIAL_BASE_URL || 'https://api.imperial.space/api/v1',
    apiKey: process.env.IMPERIAL_API_KEY || null,
    routingMode: IMP_ROUTING_MODE,
    positionMode: IMP_POSITION_MODE,
    depositMode: IMP_DEPOSIT_MODE,
  },

  // --- v6 cleanup flags ---
  // Pending-burn sweeper: scans every managed token's treasury ATA every tick
  // and burns any nonzero balance. This is the safety net that guarantees
  // every buyback ultimately gets burned, even if the original burn tx failed.
  burnSweepEnabled: String(process.env.BURN_SWEEP_ENABLED ?? 'true').toLowerCase() === 'true',
  burnSweepTickMs: Number(process.env.BURN_SWEEP_TICK_MS ?? 60_000),
  // Position reconcile: re-queries Imperial /positions for tokens opened in
  // the last RECONCILE_WINDOW_MIN minutes and corrects DB if venue differs.
  reconcileEnabled: String(process.env.RECONCILE_ENABLED ?? 'true').toLowerCase() === 'true',
  reconcileTickMs: Number(process.env.RECONCILE_TICK_MS ?? 90_000),
  reconcileWindowMin: Number(process.env.RECONCILE_WINDOW_MIN ?? 15),
  // State reconcile (Fix 3c): scans token_workflows and nudges stuck tokens back
  // into the forward tick (error->idle, clear stale pending, escalate blocked).
  // PASSIVE — never trades. See KEEPER_RECONCILE.md.
  stateReconcileEnabled: String(process.env.STATE_RECONCILE_ENABLED ?? 'true').toLowerCase() === 'true',
  // Quiet the per-call Imperial handshake fallback log unless set.
  logVerbose: String(process.env.LOG_VERBOSE ?? 'false').toLowerCase() === 'true',
};

