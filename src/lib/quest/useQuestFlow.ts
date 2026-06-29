// All quest state + handlers in one hook, so the funnel can be rendered anywhere (the
// landing splash, a standalone page) without duplicating logic.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWallet } from "@/lib/wallet/WalletContext";
import {
  startSession,
  recordStep,
  submitWallet,
  type QuestSession,
} from "@/lib/quest/client";
import { isLikelySolAddress } from "@/lib/quest/shared";
import { useHonoraryStep } from "@/lib/quest/useHonoraryStep";

export function useQuestFlow() {
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

  // Telegram — honorary (click → open the channel → ~1s spinner → done), same as the X steps.
  const tg = useHonoraryStep(session?.steps.tg_joined ?? false, async () => {
    if (sid) await recordStep(sid, "tg_join");
  });

  // Wallet capture.
  const { wallet } = useWallet();
  const [walletInput, setWalletInput] = useState("");
  const [walletSubmitting, setWalletSubmitting] = useState(false);
  const [savedAddr, setSavedAddr] = useState<string | null>(null);
  const walletDone = !!savedAddr;

  useEffect(() => {
    if (session?.sol_address) setSavedAddr(session.sol_address);
  }, [session?.sol_address]);

  async function submitWalletAddr() {
    if (!sid) return;
    const addr = walletInput.trim();
    if (!isLikelySolAddress(addr)) {
      toast.error("That doesn't look like a Solana address");
      return;
    }
    setWalletSubmitting(true);
    try {
      const r = await submitWallet(sid, addr);
      setSavedAddr(r.sol_address);
      toast.success("Wallet saved — you're in!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save wallet");
    } finally {
      setWalletSubmitting(false);
    }
  }

  // Referral link — the quest lives on "/", so the share link points there.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const referralUrl = session ? `${origin}/?ref=${session.referral_code}` : "";
  const [copied, setCopied] = useState(false);
  function copyReferral() {
    if (!referralUrl) return;
    navigator.clipboard
      ?.writeText(referralUrl)
      .then(() => {
        setCopied(true);
        toast.success("Referral link copied");
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error("Couldn't copy"));
  }

  const completed = [
    follow.status === "done",
    retweet.status === "done",
    tg.status === "done",
    walletDone,
  ].filter(Boolean).length;
  const totalSteps = 4;
  const pct = Math.round((completed / totalSteps) * 100);

  return {
    isError: sessionQuery.isError,
    sid,
    follow,
    retweet,
    tg,
    walletConn: wallet,
    walletInput,
    setWalletInput,
    walletSubmitting,
    savedAddr,
    walletDone,
    submitWalletAddr,
    referralUrl,
    copied,
    copyReferral,
    completed,
    totalSteps,
    pct,
    allDone: completed === totalSteps,
  };
}
