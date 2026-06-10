// Embeds the token's own price chart via Birdeye's TradingView widget (iframe).
// Used on the token page next to the backing-asset candle chart.
// See plan/TOKEN_BIRDEYE_CHART.md.

function birdeyeWidgetUrl(mint: string): string {
  const params = new URLSearchParams({
    chain: "solana",
    viewMode: "pair",
    chartInterval: "15",
    chartType: "CANDLE",
    theme: "dark",
  });
  return `https://birdeye.so/tv-widget/${mint}?${params.toString()}`;
}

function birdeyeTokenUrl(mint: string): string {
  return `https://birdeye.so/token/${mint}?chain=solana`;
}

export function BirdeyeChart({
  mint,
  height = 360,
  className = "",
}: {
  mint: string | null | undefined;
  height?: number;
  className?: string;
}) {
  if (!mint) {
    return (
      <div
        className={`flex items-center justify-center font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground ${className}`}
        style={{ height }}
      >
        no token chart yet
      </div>
    );
  }

  return (
    <div className={`relative w-full overflow-hidden ${className}`} style={{ height }}>
      <iframe
        title="Birdeye token chart"
        src={birdeyeWidgetUrl(mint)}
        loading="lazy"
        className="h-full w-full border-0"
        allow="clipboard-write"
        // Birdeye serves the tv-widget for embedding; sandbox kept permissive
        // enough for its TradingView canvas + network calls.
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
      <a
        href={birdeyeTokenUrl(mint)}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-1 right-2 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70 hover:text-foreground"
      >
        Birdeye ↗
      </a>
    </div>
  );
}
