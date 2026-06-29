import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "@/components/ComingSoon";

// The quest funnel now lives on the landing splash. /quest renders the same component so
// existing /quest?ref=<code> share links keep working (the funnel reads ?ref from the URL).
export const Route = createFileRoute("/quest")({
  component: ComingSoon,
  head: () => ({
    meta: [
      { title: "Join the relaunch · perpspad" },
      {
        name: "description",
        content: "Complete the PerpsPad quest — follow on X, retweet, join Telegram, submit your SOL address — to qualify for the $PERPAD airdrop.",
      },
    ],
  }),
});
