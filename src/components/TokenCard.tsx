import { Link } from "@tanstack/react-router";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import type { AltToken } from "@/lib/tokens";
import { formatUsd } from "@/lib/tokens";

export function TokenCard({ token }: { token: AltToken }) {
  const up = token.change24h >= 0;
  return (
    <Link
      to="/token/$id"
      params={{ id: token.id }}
      className="group block rounded-xl border border-border bg-card p-5 transition-all hover:border-primary/40 hover:shadow-sm"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
            {token.ticker.slice(0, 2)}
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">${token.ticker}</div>
            <div className="text-xs text-muted-foreground">{token.name}</div>
          </div>
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">
          {token.leverage}x {token.direction} {token.underlying}
        </Badge>
      </div>

      <div className="mt-5 flex items-end justify-between">
        <div>
          <div className="text-lg font-semibold tabular-nums">{formatUsd(token.priceUsd)}</div>
          <div className={`text-xs tabular-nums ${up ? "text-primary" : "text-destructive"}`}>
            {up ? "+" : ""}{token.change24h.toFixed(2)}% 24h
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Market cap</div>
          <div className="text-sm font-medium tabular-nums">{formatUsd(token.marketCap)}</div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Graduation</span>
          <span className="tabular-nums">{Math.round(token.graduationProgress * 100)}%</span>
        </div>
        <Progress value={token.graduationProgress * 100} className="h-1" />
      </div>
    </Link>
  );
}
