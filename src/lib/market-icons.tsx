type IconDef = { url: string } | { svg: React.ReactNode };

// Hyperliquid serves clean svg icons for every perp symbol they list.
// Pattern: https://app.hyperliquid.xyz/coins/<SYMBOL>.svg
const hl = (sym: string): IconDef => ({ url: `https://app.hyperliquid.xyz/coins/${sym}.svg` });

function textIcon(label: string, bg: string, fg = "#fff", font = "system-ui, sans-serif", size = 9): IconDef {
  return {
    svg: (
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="12" fill={bg} />
        <text x="12" y="15.5" textAnchor="middle" fontFamily={font} fontSize={size} fontWeight="900" fill={fg}>{label}</text>
      </svg>
    ),
  };
}

// Map every supported symbol to the Hyperliquid icon endpoint. All entries
// verified 200 OK. Legacy aliases kept so old data still renders.
const ICONS: Record<string, IconDef> = {
  // Crypto majors
  BTC: hl("BTC"), ETH: hl("ETH"), SOL: hl("SOL"), BNB: hl("BNB"), XRP: hl("XRP"),
  TON: hl("TON"), DOGE: hl("DOGE"), SUI: hl("SUI"), ADA: hl("ADA"), LTC: hl("LTC"),
  BCH: hl("BCH"), AVAX: hl("AVAX"), LINK: hl("LINK"), DOT: hl("DOT"), TRX: hl("TRX"),
  NEAR: hl("NEAR"), XLM: hl("XLM"),
  // Sol-eco / DeFi
  JUP: hl("JUP"), PYTH: hl("PYTH"), JTO: hl("JTO"),
  HYPE: hl("HYPE"), ENA: hl("ENA"), AAVE: hl("AAVE"), UNI: hl("UNI"),
  ARB: hl("ARB"), GMX: hl("GMX"),
  // Memes
  BONK: hl("BONK"), PENGU: hl("PENGU"), PUMP: hl("PUMP"), WIF: hl("WIF"),
  FARTCOIN: hl("FARTCOIN"), PEPE: hl("PEPE"), kPEPE: hl("PEPE"), BOME: hl("BOME"),
  SHIB: hl("SHIB"), TRUMP: hl("TRUMP"), MELANIA: hl("MELANIA"), APE: hl("APE"),
  // Privacy / AI
  ZEC: hl("ZEC"), TAO: hl("TAO"),
  WLD: textIcon("WLD", "#000", "#fff", "system-ui", 7),
  KMNO: textIcon("KMN", "#ff5a1f", "#fff", "system-ui", 7),
  // Stocks (no HL icon, use branded text badges)
  SPY: textIcon("SPY", "#1e3a8a", "#fff", "system-ui", 7),
  NVDA: textIcon("NV", "#76b900", "#000", "system-ui", 8),
  TSLA: textIcon("T", "#e31937", "#fff", "system-ui", 11),
  AAPL: textIcon("", "#a1a1a6", "#fff", "system-ui", 11),
  AMD: textIcon("AMD", "#000", "#fff", "system-ui", 7),
  AMZN: textIcon("a", "#ff9900", "#fff", "system-ui", 12),
  META: textIcon("M", "#0668e1", "#fff", "system-ui", 11),
  MSFT: textIcon("MS", "#00a4ef", "#fff", "system-ui", 8),
  GOOGL: textIcon("G", "#4285f4", "#fff", "system-ui", 11),
  MU: textIcon("MU", "#4e2a84", "#fff", "system-ui", 8),
  MSTR: textIcon("MS", "#f7931a", "#fff", "system-ui", 8),
  // Commodities
  XAU: textIcon("Au", "#d4af37", "#000", "system-ui", 9),
  XAG: textIcon("Ag", "#c0c0c0", "#000", "system-ui", 9),
  WTI: textIcon("OIL", "#1a1a1a", "#fff", "system-ui", 7),
  CRUDEOIL: textIcon("OIL", "#1a1a1a", "#fff", "system-ui", 7),
  NATGAS: textIcon("NG", "#1d4ed8", "#fff", "system-ui", 8),
  COPPER: textIcon("Cu", "#b87333", "#fff", "system-ui", 9),
  // Forex
  EUR: textIcon("€", "#003399", "#ffcc00", "system-ui", 12),
  GBP: textIcon("£", "#012169", "#fff", "system-ui", 12),
  USDJPY: textIcon("¥", "#bc002d", "#fff", "system-ui", 12),
  USDCHF: textIcon("Fr", "#d52b1e", "#fff", "system-ui", 8),
  USDCAD: textIcon("C$", "#d80621", "#fff", "system-ui", 8),
  AUD: textIcon("A$", "#012169", "#fff", "system-ui", 8),
  NZD: textIcon("NZ", "#000", "#fff", "system-ui", 8),
  // Legacy aliases
  CL: hl("WTI"), BRENTOIL: hl("WTI"),
  GOLD: hl("XAU"), SILVER: hl("XAG"),
  SP500: hl("SPY"),
  XYZ100: textIcon("100", "#1a237e", "#fff", "system-ui", 8),
};

export function MarketIcon({ name, size = 22 }: { name: string; size?: number }) {
  const ic = ICONS[name];
  const px = `${size}px`;
  const style = { width: px, height: px } as const;
  if (ic && "url" in ic) {
    return (
      <img
        src={ic.url}
        alt={name}
        width={size}
        height={size}
        className="shrink-0 rounded-full"
        style={style}
        loading="lazy"
      />
    );
  }
  if (ic && "svg" in ic) {
    return (
      <span className="shrink-0 inline-flex" style={style}>
        {ic.svg}
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-bold"
      style={style}
    >
      {name.slice(0, 1)}
    </span>
  );
}
