import { Link } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import logo from "@/assets/logo.png";
import logoDark from "@/assets/logo-dark.png";

export function Header() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/85 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-4">
        <Link to="/" className="flex items-center">
          <img src={logo} alt="perpspad" className="h-8 w-8 object-contain block dark:hidden" />
          <img src={logoDark} alt="perpspad" className="h-8 w-8 object-contain hidden dark:block" />
        </Link>

        <nav className="hidden items-center gap-6 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground md:flex">
          <Link to="/tokens" className="transition-colors hover:text-foreground">market</Link>
          <Link to="/launch" className="transition-colors hover:text-foreground">create</Link>
          <Link to="/route-fees" className="transition-colors hover:text-foreground">route fees</Link>
          <Link to="/paper" className="transition-colors hover:text-foreground">paper</Link>
        </nav>

        <div className="relative ml-auto hidden w-72 md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="search ticker or underlying"
            className="h-8 rounded-none border-border bg-secondary/40 pl-8 text-xs placeholder:text-muted-foreground/70"
          />
        </div>

        <ThemeToggle />
        <ConnectWalletButton />
      </div>
    </header>
  );
}
