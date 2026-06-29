import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Twitter, Repeat2, Send, Wallet, ArrowUpRight, Lock } from "lucide-react";
import { toast } from "sonner";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import {
  startSession,
  recordStep,
  fetchTelegramStatus,
  type QuestSession,
} from "@/lib/quest/client";
import { xFollowUrl, xRetweetUrl, tgBotDeepLink } from "@/lib/quest/config";
import { useHonoraryStep } from "@/lib/quest/useHonoraryStep";

export const Route = createFileRoute("/quest")({
  component: QuestPage,
  head: () => ({
    meta: [
      { title: "Join the relaunch · perpspad" },
      {
        name: "description",
        content:
          "Complete the PerpsPad quest — follow on X, retweet, join Telegram, submit your SOL address — to qualify for the $PERPAD airdrop.",
      },
    ],
  }),
});

function StepRow({
  n,
  icon,
  title,
  subtitle,
  done,
  children,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-4">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center border ${
          done ? "border-[#16e0a3]/40 text-[#16e0a3]" : "border-border text-muted-foreground"
        }`}
      >
        {done ? <Check className="h-4 w-4" /> : icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            step {n}
          </span>
        </div>
        <div className="truncate text-sm text-foreground">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function DoneTag() {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#16e0a3]">
      <Check className="h-3.5 w-3.5" /> done
    </span>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> {label}
    </span>
  );
}

function QuestPage() {
  const [ref] = useState(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("ref") : null,
  );

  const sessionQuery = useQuery<QuestSession>({
    queryKey: ["quest-session"],
    queryFn: () => startSession(ref),
    enabled: typeof window !== "undefined",
    staleTime: Infinity,
    retry: 1,
  });
  const session = sessionQuery.data ?? null;
  const sid = session?.session_id ?? null;

  const follow = useHonoraryStep(session?.steps.x_follow ?? false, async () => {
    if (sid) await recordStep(sid, "x_follow");
  });
  const retweet = useHonoraryStep(session?.steps.x_retweet ?? false, async () => {
    if (sid) await recordStep(sid, "x_retweet");
  });

  // Telegram: deep-link to the bot, then poll the real getChatMember check.
  const [tgActive, setTgActive] = useState(false);
  const serverTgJoined = session?.steps.tg_joined ?? false;
  const tgQuery = useQuery({
    queryKey: ["quest-tg", sid],
    queryFn: () => fetchTelegramStatus(sid!),
    enabled: !!sid && tgActive && !serverTgJoined,
    refetchInterval: 2500,
  });
  const tgJoined = serverTgJoined || tgQuery.data?.joined === true;
  const tgBound = tgQuery.data?.bound === true;

  const joinedToastShown = useRef(false);
  useEffect(() => {
    if (tgJoined && !joinedToastShown.current) {
      joinedToastShown.current = true;
      setTgActive(false);
      toast.success("Telegram verified");
    }
  }, [tgJoined]);

  function joinTelegram() {
    if (!sid) return;
    window.open(tgBotDeepLink(sid), "_blank", "noopener,noreferrer");
    setTgActive(true);
  }

  const completed = [follow.status === "done", retweet.status === "done", tgJoined].filter(
    Boolean,
  ).length;
  const totalSteps = 4; // incl. the SOL submit step (built next)
  const pct = Math.round((completed / totalSteps) * 100);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="mx-auto max-w-xl px-6 py-12">
        <div className="mb-8">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
          <div className="mt-4 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            pre-launch · quest
          </div>
          <h1 className="font-display mt-2 text-4xl leading-[0.95] text-foreground">
            Join the relaunch.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-foreground/80">
            Complete the quest to qualify for the <span className="text-foreground">$PERPAD</span>{" "}
            airdrop. Prior holders are detected automatically.
          </p>
        </div>

        {/* Progress */}
        <div className="mb-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          <span>
            {completed} / {totalSteps} complete
          </span>
          <span>{pct}%</span>
        </div>
        <div className="mb-6 h-1 w-full overflow-hidden bg-secondary">
          <div
            className="h-full bg-primary transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>

        {sessionQuery.isError ? (
          <div className="border border-destructive/40 bg-card p-5 text-sm text-destructive">
            Could not start the quest. Refresh to try again.
          </div>
        ) : (
          <div className="divide-y divide-border border border-border bg-card">
            {/* Step 1 — Follow on X (honorary) */}
            <StepRow
              n={1}
              icon={<Twitter className="h-4 w-4" />}
              title="Follow @perpspad on X"
              subtitle="Opens X — come back when you're done"
              done={follow.status === "done"}
            >
              {follow.status === "done" ? (
                <DoneTag />
              ) : follow.status === "verifying" ? (
                <Spinner label="verifying" />
              ) : follow.status === "awaiting" ? (
                <Spinner label="waiting" />
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!sid}
                  onClick={() => follow.open(xFollowUrl())}
                >
                  Follow <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              )}
            </StepRow>

            {/* Step 2 — Retweet (honorary) */}
            <StepRow
              n={2}
              icon={<Repeat2 className="h-4 w-4" />}
              title="Retweet the pinned launch post"
              subtitle="Opens X — come back when you're done"
              done={retweet.status === "done"}
            >
              {retweet.status === "done" ? (
                <DoneTag />
              ) : retweet.status === "verifying" ? (
                <Spinner label="verifying" />
              ) : retweet.status === "awaiting" ? (
                <Spinner label="waiting" />
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!sid}
                  onClick={() => retweet.open(xRetweetUrl())}
                >
                  Retweet <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              )}
            </StepRow>

            {/* Step 3 — Join Telegram (real getChatMember check) */}
            <StepRow
              n={3}
              icon={<Send className="h-4 w-4" />}
              title="Join the Telegram channel"
              subtitle={
                tgActive && !tgJoined
                  ? tgBound
                    ? "Linked — now join the channel in Telegram"
                    : "Open Telegram and press Start"
                  : "Verified automatically once you join"
              }
              done={tgJoined}
            >
              {tgJoined ? (
                <DoneTag />
              ) : tgActive ? (
                <Spinner label="checking" />
              ) : (
                <Button size="sm" variant="outline" disabled={!sid} onClick={joinTelegram}>
                  Join <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              )}
            </StepRow>

            {/* Step 4 — Submit SOL address (built next) */}
            <StepRow
              n={4}
              icon={<Wallet className="h-4 w-4" />}
              title="Submit your SOL address"
              subtitle="Unlocks at token launch to claim your airdrop"
              done={false}
            >
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
                <Lock className="h-3.5 w-3.5" /> soon
              </span>
            </StepRow>
          </div>
        )}

        <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
          one entry per person · sybil-filtered
        </p>
      </div>
    </div>
  );
}
