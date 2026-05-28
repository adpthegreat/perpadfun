import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWallet, truncateAddress, type SolanaWalletName } from "@/lib/wallet/WalletContext";
import { Wallet, LogOut, Copy } from "lucide-react";
import { toast } from "sonner";

const WALLETS: SolanaWalletName[] = ["Phantom", "Solflare", "Backpack"];

export function ConnectWalletButton() {
  const { wallet, connecting, connectSolanaWith, disconnect } = useWallet();

  const handleConnect = async (name: SolanaWalletName) => {
    try {
      await connectSolanaWith(name);
      toast.success(`Connected to ${name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    }
  };

  if (wallet) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-none border-foreground/40 px-4 font-mono text-[10px] uppercase tracking-[0.2em]"
          >
            <Wallet className="mr-1.5 h-3 w-3" />
            {truncateAddress(wallet.address)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="rounded-none font-mono text-[10px] uppercase tracking-[0.18em]">
          <DropdownMenuItem
            onClick={() => {
              navigator.clipboard.writeText(wallet.address);
              toast.success("Address copied");
            }}
          >
            <Copy className="mr-2 h-3 w-3" /> copy address
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={disconnect}>
            <LogOut className="mr-2 h-3 w-3" /> disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={connecting}
          className="h-8 rounded-none border-foreground/40 px-4 font-mono text-[10px] uppercase tracking-[0.2em]"
        >
          <Wallet className="mr-1.5 h-3 w-3" />
          {connecting ? "connecting." : "connect wallet"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="rounded-none font-mono text-[10px] uppercase tracking-[0.18em]">
        {WALLETS.map((name) => (
          <DropdownMenuItem key={name} onClick={() => handleConnect(name)}>
            {name.toLowerCase()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
