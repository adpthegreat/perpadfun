import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { apiOk, apiErr } from "@/lib/api/respond";
import { rateLimit } from "@/lib/api/rateLimit";
import { buildPublicLaunchTx, launchAdmin, previewLaunch, type FeeSchedule } from "@/lib/launch/pipeline";
import { getTreasuryKeypair } from "@/lib/solana/treasury.server";

// THE single launch route. Mode is chosen by the x-keeper-secret header:
//   - present + valid  -> ADMIN mode: treasury signs + sends + records atomically; may set
//                         leftover + anti-snipe fee + creatorAddress; supports ?dryRun=1.
//   - absent           -> PUBLIC mode: keyless + permissionless. Returns unsigned config +
//                         pool txs for the caller to sign + pay (incl. the 0.01 SOL fee);
//                         a transient row is recorded and the keeper promotes it on-chain.
function normalizeSecret(v: string | null | undefined) {
  const t = v?.trim();
  if (!t) return "";
  const f = t[0],
    l = t[t.length - 1];
  return (f === '"' && l === '"') || (f === "'" && l === "'") ? t.slice(1, -1).trim() : t;
}
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

const Base = {
  ticker: z.string().min(1).max(12).regex(/^[A-Z0-9]+$/),
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  imageUrl: z.string().url().max(500).optional(),
  websiteUrl: z.string().url().max(300).optional(),
  twitterUrl: z.string().url().max(300).optional(),
  underlying: z.string().min(1).max(20),
  leverage: z.number().int().positive(),
  direction: z.enum(["long", "short"]),
  quote: z.enum(["SOL", "USDC"]).default("SOL"),
};
const PublicBody = z.object({ ...Base, creatorAddress: z.string().min(32).max(44), devBuy: z.number().positive() });
const AdminBody = z.object({
  ...Base,
  creatorAddress: z.string().min(32).max(44).optional(), // default = treasury
  tokenId: z.string().uuid().optional(), // re-run a prepared+funded sub-wallet
  devBuy: z.number().nonnegative().default(0),
  leftoverTokens: z.number().nonnegative().optional(),
  feeSchedule: z.object({ startingFeeBps: z.number().int(), endingFeeBps: z.number().int(), numberOfPeriod: z.number().int(), totalDuration: z.number().int() }).optional(),
});

export const Route = createFileRoute("/api/v1/launch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const adminSecret = normalizeSecret(process.env.KEEPER_SECRET);
        const provided = normalizeSecret(request.headers.get("x-keeper-secret"));
        if (provided && (!adminSecret || provided !== adminSecret))
          return apiErr(401, "unauthorized", "bad x-keeper-secret");
        const isAdmin = !!adminSecret && provided === adminSecret;

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return apiErr(400, "bad_json", "invalid JSON body");
        }

        // ── ADMIN MODE ──────────────────────────────────────────────────────
        if (isAdmin) {
          const parsed = AdminBody.safeParse(body);
          if (!parsed.success) {
            const i = parsed.error.issues[0];
            return apiErr(422, "validation", i.message, i.path.join("."));
          }
          const d = parsed.data;
          try {
            // dry-run only previews the supply split — no treasury key needed.
            if (new URL(request.url).searchParams.get("dryRun") === "1") {
              const { supplyBreakdown } = await previewLaunch({ quote: d.quote, leverage: d.leverage, leftoverTokens: d.leftoverTokens, feeSchedule: d.feeSchedule as FeeSchedule | undefined });
              return apiOk({ dryRun: true, supplyBreakdown, leftoverTokens: d.leftoverTokens ?? 0 });
            }
            // default the creator to the treasury (needs TREASURY_SECRET_KEY) only when actually launching.
            const creatorAddress = d.creatorAddress ?? getTreasuryKeypair().publicKey.toBase58();
            const res = await launchAdmin({ ...d, creatorAddress, feeSchedule: d.feeSchedule as FeeSchedule | undefined });
            return apiOk(res, { status: 201 });
          } catch (e) {
            return apiErr(400, "launch_failed", (e as Error).message);
          }
        }

        // ── PUBLIC MODE ─────────────────────────────────────────────────────
        const rl = rateLimit(`ip:${clientIp(request)}:launch`, 20);
        if (!rl.ok) return apiErr(429, "rate_limited", "slow down", undefined, { "Retry-After": String(rl.retryAfter ?? 60) });

        const parsed = PublicBody.safeParse(body);
        if (!parsed.success) {
          const i = parsed.error.issues[0];
          return apiErr(422, "validation", i.message, i.path.join("."));
        }
        const d = parsed.data;
        const bounds = d.quote === "USDC" ? { min: 5, max: 5000 } : { min: 0.1, max: 5 };
        if (d.devBuy < bounds.min || d.devBuy > bounds.max)
          return apiErr(422, "validation", `devBuy must be ${bounds.min}–${bounds.max} ${d.quote}`, "devBuy");
        try {
          const res = await buildPublicLaunchTx(d);
          return apiOk(res, { status: 200 });
        } catch (e) {
          return apiErr(400, "launch_failed", (e as Error).message);
        }
      },
    },
  },
});
