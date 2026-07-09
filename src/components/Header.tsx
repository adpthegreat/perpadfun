import { Link, useNavigate } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ZapButton } from "@/components/ZapButton";
import { searchTokens } from "@/lib/tokens.functions";
import logo from "@/assets/logo.png";
import logoDark from "@/assets/logo-dark.png";

// Global search with live auto-suggest. Matches ticker / name / pasted mint under
// the same visibility gate as the market feed; picking a result jumps to its
// token page. Enter → first result (or the market page if none).
function HeaderSearch() {
  const navigate = useNavigate();
  const searchFn = useServerFn(searchTokens);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // debounce the query so we don't hit the server on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 180);
    return () => clearTimeout(t);
  }, [q]);

  const enabled = debounced.length >= 2;
  const suggestQ = useQuery({
    queryKey: ["token-search", debounced],
    queryFn: () => searchFn({ data: { q: debounced } }),
    enabled,
    staleTime: 10_000,
  });
  const results = enabled ? (suggestQ.data?.results ?? []) : [];

  // close on outside click
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => setActive(0), [debounced]);

  function go(id: string) {
    setOpen(false);
    setQ("");
    navigate({ to: "/token/$id", params: { id } });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (results[active]) go(results[active].id);
      else if (q.trim()) {
        setOpen(false);
        navigate({ to: "/tokens" });
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative ml-auto hidden w-72 md:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="search ticker, name or mint"
        className="h-8 rounded-none border-border bg-secondary/40 pl-8 text-xs placeholder:text-muted-foreground/70"
      />

      {open && enabled && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-auto border border-border bg-popover shadow-lg">
          {suggestQ.isLoading ? (
            <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              searching…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              no coins match
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus so the click lands before blur
                  go(r.id);
                }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  i === active ? "bg-muted" : "hover:bg-muted/60"
                }`}
              >
                {r.imageUrl ? (
                  <img src={r.imageUrl} alt={r.ticker} className="h-6 w-6 shrink-0 object-cover" />
                ) : (
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center bg-accent text-[9px] font-semibold text-accent-foreground">
                    {r.ticker.slice(0, 2)}
                  </div>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-semibold">${r.ticker}</span>
                    {r.source === "external" && (
                      <span className="shrink-0 border border-green-500/40 bg-green-500/10 px-1 font-mono text-[8px] uppercase tracking-wider text-green-400">
                        {r.externalPlatform === "pump_fun" ? "pump.fun" : "routed"}
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">{r.name}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-4">
        <Link to="/" className="flex items-center">
          <img src={logo} alt="perpspad" className="h-8 w-8 object-contain block dark:hidden" />
          <img src={logoDark} alt="perpspad" className="h-8 w-8 object-contain hidden dark:block" />
        </Link>

        <nav className="hidden items-center gap-6 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground md:flex">
          <Link to="/tokens" className="transition-colors hover:text-foreground">
            market
          </Link>
          <Link to="/launch" className="transition-colors hover:text-foreground">
            create
          </Link>
          <Link to="/route-fees" className="transition-colors hover:text-foreground">
            route fees
          </Link>
          <Link to="/paper" className="transition-colors hover:text-foreground">
            paper
          </Link>
        </nav>

        <ZapButton />

        <HeaderSearch />

        <ThemeToggle />
        <ConnectWalletButton />
      </div>
    </header>
  );
}
