// Enumerate all supported Imperial perp markets by probing /route with a
// wide list of common base symbols. A 200 means the venue router accepted
// the symbol (i.e. it's a tradable market on at least one venue).

const BASE = process.env.IMPERIAL_BASE_URL || 'https://api.imperial.space/api/v1';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Broad universe of perp tickers across major venues (Hyperliquid, dYdX,
// Drift, Phoenix, GMTrade, Jupiter Perps, Binance/Bybit-style listings).
const SYMBOLS = [
  // L1 / majors
  'BTC','ETH','SOL','BNB','XRP','ADA','AVAX','DOGE','TRX','TON','DOT','LTC','BCH','ETC','ATOM','NEAR','APT','SUI','SEI','TIA','INJ','ICP','FIL','HBAR','XLM','XMR','ALGO','EGLD','FLOW','KAS','MINA','XTZ','ZEC','DASH','NEO','QTUM','WAVES','IOTA',
  // L2 / scaling
  'ARB','OP','MATIC','POL','STRK','MNT','METIS','IMX','LRC','BLAST','MANTA','ZK','ZKS','SCROLL','LINEA','BASE',
  // DeFi blue chips
  'UNI','AAVE','MKR','SNX','CRV','COMP','SUSHI','1INCH','LDO','RPL','FXS','BAL','YFI','DYDX','GMX','PENDLE','ENA','ETHFI','EIGEN','REZ','OMNI','W','TNSR','JTO','JUP','PYTH','RAY','ORCA','KMNO','DRIFT',
  // Memes
  'WIF','BONK','PEPE','SHIB','FLOKI','MEME','BOME','POPCAT','MEW','MOTHER','BRETT','TURBO','NEIRO','PNUT','GOAT','MOODENG','FARTCOIN','PONKE','BODEN','TRUMP','MELANIA','AI16Z','GRIFFAIN','ARC','ZEREBRO','GIGA','SPX','PEPECOIN','CHILLGUY','ACT','HIPPO',
  // AI / data
  'TAO','FET','RNDR','RENDER','AGIX','OCEAN','GRT','WLD','IO','AKT','VIRTUAL','AIXBT','GAME','SWARMS',
  // Gaming / metaverse
  'AXS','SAND','MANA','GALA','ENJ','APE','BEAM','PIXEL','RON','PRIME','SUPER','ILV','MAGIC','GMT',
  // Infra / oracles / others
  'LINK','RUNE','KAVA','ROSE','CFX','THETA','VET','XEC','BSV','ZIL','CHZ','BAT','ZRX','ANKR','SKL','CKB','ARKM','BLUR','ENS','MASK','AR','STX','ORDI','SATS','RATS','TIA','DYM','PYTH','JTO','WEN','TENSOR',
  // Stables / wrapped (likely not perp, but probe anyway)
  'USDT','USDC','DAI','WBTC','WETH','STETH','WSTETH','CBBTC','MSOL','JITOSOL','BSOL',
];

async function probe(asset) {
  const params = new URLSearchParams({
    asset,
    side: 'long',
    amount: '10000000',
    collateralAsset: USDC,
    notional: '20',
    desiredLeverage: '2',
    slippageBps: '100',
  });
  const url = `${BASE}/route?${params}`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    return { asset, status: res.status, text };
  } catch (e) {
    return { asset, status: 0, text: String(e?.message || e) };
  }
}

console.log(`Probing ${BASE}/route for ${SYMBOLS.length} symbols...\n`);

const supported = [];
const unsupported = [];

const CONCURRENCY = 8;
let i = 0;
async function worker() {
  while (i < SYMBOLS.length) {
    const sym = SYMBOLS[i++];
    const r = await probe(sym);
    if (r.status === 200) {
      let venue = '?', maxLev = '?';
      try { const j = JSON.parse(r.text); venue = j.venue; maxLev = j.maxLeverage; } catch {}
      console.log(`[200] ${sym.padEnd(12)} venue=${venue} maxLev=${maxLev}`);
      supported.push({ sym, venue, maxLev });
    } else {
      unsupported.push(sym);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\n=== Supported (${supported.length}) ===`);
console.log(supported.map(s => `${s.sym} (${s.venue}, ${s.maxLev}x)`).join('\n'));
console.log(`\n=== Unsupported (${unsupported.length}) ===`);
console.log(unsupported.join(', '));
