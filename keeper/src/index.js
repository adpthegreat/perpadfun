import Fastify from 'fastify';
import { config } from './config.js';
import { tick, adminCloseHedge, adminForceOpen } from './loop.js';
import { getJupPerps, getFreeCollateralUsd } from './jupiterPerps.js';
import { runBurnSweepTick, getBurnSweepStatus } from './buybackQueue.js';
import { runReconcileTick, getReconcileStatus } from './positionReconcile.js';
import { runStateReconcileTick, getStateReconcileStatus } from './stateReconcile.js';
import { sweepExternalRouters, getExternalSweepStatus } from './externalRouters.js';
import { runMarketSyncTick, getMarketSyncStatus } from './marketSync.js';
import { flushWorkflow, listWorkflows } from './workflow.js';

const app = Fastify({ logger: true });

let lastRun = null;
let lastResult = null;
let lastError = null;
let running = false;
let tickStartedAt = null;

async function safeTick() {
  if (running) {
    const ageSec = tickStartedAt ? Math.round((Date.now() - tickStartedAt) / 1000) : null;
    app.log.warn(`safeTick already running, skipping${ageSec ? ` (age=${ageSec}s)` : ''}`);
    return;
  }
  running = true;
  tickStartedAt = Date.now();
  const watchdog = setTimeout(() => {
    if (running) {
      app.log.error('safeTick watchdog fired after 240s, tick still running. Holding lock to prevent overlap');
    }
  }, 240_000);
  try {
    lastResult = await tick();
    await flushWorkflow();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    app.log.error(e);
  } finally {
    clearTimeout(watchdog);
    lastRun = new Date().toISOString();
    running = false;
    tickStartedAt = null;
  }
}

async function runForever() {
  await safeTick();
  setTimeout(runForever, config.loopIntervalMs);
}

async function runExternalSweepForever() {
  try {
    const sweep = await sweepExternalRouters();
    if (sweep.scanned > 0) {
      app.log.info(
        `[external-sweep] scanned=${sweep.scanned} processed=${sweep.processed} events=${sweep.events ?? 0} totalSol=${sweep.totalSol.toFixed(6)}`,
      );
    }
  } catch (e) {
    app.log.error({ err: e.message }, 'external-sweep tick failed');
  }
  setTimeout(runExternalSweepForever, config.externalSweepTickMs);
}

// Dedicated burn-sweep tick: independent of the main perp tick so a slow
// perp tick can't starve burn retries. Guarded internally by buybackQueue.
async function runBurnSweepForever() {
  try { await runBurnSweepTick(); }
  catch (e) { app.log.error({ err: e.message }, 'burn-sweep tick failed'); }
  setTimeout(runBurnSweepForever, config.burnSweepTickMs);
}

// Dedicated reconcile tick: re-queries Imperial for recently opened positions
// and writes the venue's truth back into the DB.
async function runReconcileForever() {
  try { await runReconcileTick(); }
  catch (e) { app.log.error({ err: e.message }, 'reconcile tick failed'); }
  try { await runStateReconcileTick(); }
  catch (e) { app.log.error({ err: e.message }, 'state reconcile tick failed'); }
  setTimeout(runReconcileForever, config.reconcileTickMs);
}

// Phoenix market catalog sync (every 36h). Refreshes SUPPORTED_MARKETS from
// Imperial's /phoenix/markets so new markets appear without a hand-edit.
async function runMarketSyncForever() {
  try {
    const r = await runMarketSyncTick();
    if (r?.changed) app.log.warn({ added: r.added, updated: r.updated }, 'phoenix catalog changed');
  } catch (e) { app.log.error({ err: e.message }, 'market sync tick failed'); }
  setTimeout(runMarketSyncForever, config.marketSyncTickMs);
}

function requireKeeperSecret(req) {
  const got = (req.headers['x-keeper-secret'] || '').toString().trim();
  return got && got === config.keeperSecret.trim();
}

function feeSplitSnapshot() {
  return {
    buybackFromFeesRatio: config.buybackFromFeesRatio,
    treasuryHoldRatio: config.treasuryHoldRatio,
    perpMarginRatio: config.perpMarginRatio,
    minBuybackUsd: config.minBuybackUsd,
    minBuybackSol: config.minBuybackSol,
    maxBuybackPerTickUsd: config.maxBuybackPerTickUsd,
  };
}

app.get('/health', async () => ({
  ok: true, venue: 'jupiter-perps', hedgeMode: config.hedgeMode,
  feeSplit: feeSplitSnapshot(),
  burnSweep: getBurnSweepStatus(),
  reconcile: getReconcileStatus(),
  stateReconcile: getStateReconcileStatus(),
    externalSweep: getExternalSweepStatus(),
  marketSync: getMarketSyncStatus(),
  lastRun, lastResult, lastError,
}));

app.get('/status', async () => {
  await getJupPerps();
  const free = await getFreeCollateralUsd();
  return {
    venue: 'jupiter-perps',
    hedgeMode: config.hedgeMode,
    feeGateUsd: config.feeGateUsd,
    openCollateralUsd: config.openCollateralUsd,
    pnlTriggerUsd: config.pnlTriggerUsd,
    leverageCapMult: config.leverageCapMult,
    feeSplit: feeSplitSnapshot(),
    burnSweep: getBurnSweepStatus(),
    reconcile: getReconcileStatus(),
    stateReconcile: getStateReconcileStatus(),
      externalSweep: getExternalSweepStatus(),
    marketSync: getMarketSyncStatus(),
    freeCollateralUsd: free,
    lastRun, lastResult, lastError,
  };
});

app.post('/tick', async () => {
  await safeTick();
  return { ok: true, lastResult, lastError };
});

// Manual burn-sweep trigger. Useful to drain stranded buybacks on demand.
app.post('/admin/burn-sweep', async (req, reply) => {
  if (!requireKeeperSecret(req)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  try {
    const r = await runBurnSweepTick();
    return { ok: true, ...r };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e.message });
  }
});

// Manual reconcile trigger.
app.post('/admin/reconcile', async (req, reply) => {
  if (!requireKeeperSecret(req)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  try {
    const r = await runReconcileTick();
    return { ok: true, ...r };
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e.message });
  }
});

app.get('/admin/workflows', async (req, reply) => {
  if (!requireKeeperSecret(req)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  try {
    return await listWorkflows({
      token_id: req.query?.token_id,
      limit: req.query?.limit,
    });
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e.message });
  }
});

app.post('/admin/close-hedge', async (req, reply) => {
  if (!requireKeeperSecret(req)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const tokenId = req.body?.token_id;
  if (!tokenId) return reply.code(400).send({ ok: false, error: 'token_id required' });
  try {
    const r = await adminCloseHedge(tokenId);
    return r;
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e.message });
  }
});

app.post('/admin/force-open', async (req, reply) => {
  if (!requireKeeperSecret(req)) return reply.code(401).send({ ok: false, error: 'unauthorized' });
  const tokenId = req.body?.token_id;
  if (!tokenId) return reply.code(400).send({ ok: false, error: 'token_id required' });
  try {
    const r = await adminForceOpen(tokenId, {
      collateralUsd: req.body?.collateralUsd,
      sizeUsd: req.body?.sizeUsd,
      leverage: req.body?.leverage,
    });
    return r;
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e.message });
  }
});

const start = async () => {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`keeper listening on :${config.port} (venue=jupiter-perps mode=${config.hedgeMode})`);
  app.log.info(
    {
      ...feeSplitSnapshot(),
      burnSweepEnabled: config.burnSweepEnabled,
      burnSweepTickMs: config.burnSweepTickMs,
      externalSweepTickMs: config.externalSweepTickMs,
      reconcileEnabled: config.reconcileEnabled,
      reconcileTickMs: config.reconcileTickMs,
      reconcileWindowMin: config.reconcileWindowMin,
      logVerbose: config.logVerbose,
    },
    'keeper config loaded v6-cleanup',
  );

  getJupPerps().catch((e) => app.log.error('jupiter perps init failed: ' + e.message));

  runForever();
  runExternalSweepForever();
  if (config.burnSweepEnabled) {
    setTimeout(runBurnSweepForever, 10_000); // small startup delay
  }
  if (config.reconcileEnabled) {
    setTimeout(runReconcileForever, 20_000); // stagger from burn sweep
  }
  // Refresh the Phoenix market catalog from Imperial shortly after boot, then
  // every 36h. In-memory only; gated by marketSyncEnabled.
  if (config.marketSyncEnabled) {
    setTimeout(runMarketSyncForever, 30_000); // stagger from reconcile
  }
};

start();
