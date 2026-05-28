"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HelpCircle, ArrowRight, Wallet, Flame, LineChart, ShieldCheck, Zap } from "lucide-react";

export function HowItWorksButton() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <HelpCircle className="h-3.5 w-3.5" />
          How it works
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" />
            How fee routing works
          </DialogTitle>
          <DialogDescription>
            A step-by-step breakdown of what happens when creator fees land in your perpad sub-wallet.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <strong>Important:</strong> Your token must generate at least <strong>$100</strong> in creator fees (with perpad set as the <em>sole</em> fee receiver) before the automation starts working.
        </div>

        <div className="mt-2 space-y-5">
          <Step
            n={1}
            icon={<Wallet className="h-4 w-4" />}
            title="Set your creator-fee receiver"
            body="Paste the generated sub-wallet address into pump.fun as your token's creator-fee receiver. Every trade on your token now sends a slice of fees to this wallet automatically."
          />

          <Step
            n={2}
            icon={<ShieldCheck className="h-4 w-4" />}
            title="Claim from pump.fun vault"
            body="The keeper periodically checks your pump.fun creator vault. Once it holds at least $100, the fees are claimed into the sub-wallet. This is throttled to once every 5 minutes per token so we don't spam transactions."
          />

          <Step
            n={3}
            icon={<ArrowRight className="h-4 w-4" />}
            title="Sweep trigger"
            body="When the sub-wallet itself reaches $100, the keeper splits the balance into three legs in a single transaction batch."
          />

          <Step
            n={4}
            icon={<LineChart className="h-4 w-4" />}
            title="50% backing perp (long or short)"
            body="Half of the swept SOL is converted to collateral and opened (or added to) a Jupiter Perps position on your chosen underlying (BTC, ETH, SOL). This position collateralizes and supports your token's chart. The direction and leverage are set when you create the router. The perp only fires once the collateral value is at least $5."
          />

          <Step
            n={5}
            icon={<Flame className="h-4 w-4" />}
            title="25% buyback and burn"
            body="A quarter of the swept SOL is swapped into your token via Jupiter, then the exact received token amount is burned permanently. Any stranded tokens from prior sweeps are also collected and burned in the same transaction."
          />

          <Step
            n={6}
            icon={<Wallet className="h-4 w-4" />}
            title="~25% treasury runway"
            body="The remainder is sent to the perpad master treasury. This becomes protocol runway and future development reserve."
          />

          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
            All events (perp opens, burns, treasury sends) are posted on-chain and recorded in your dashboard in real time. No manual intervention required.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-[10px] font-semibold">
        {n}
      </div>
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          {icon}
          {title}
        </h4>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
