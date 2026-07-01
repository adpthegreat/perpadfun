import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  verifyTelegramAuth,
  checkTelegramMembership,
  type TelegramAuth,
} from "@/lib/collab/telegram.server";

// The collab tables aren't in the generated Database types yet, so use a loose
// view of the admin client for them. Rows are typed locally below.
const db = supabaseAdmin as unknown as SupabaseClient;

const X_HANDLE = "perpspadfun";

type SignupRow = {
  wallet_address: string;
  x_followed: boolean;
  x_handle: string | null;
  tg_joined: boolean;
  tg_user_id: number | null;
  tg_username: string | null;
  wallet_verified: boolean;
  code: string | null;
  waitlisted: boolean;
};

// ── helpers ──────────────────────────────────────────────────────────────────
function verifyWalletSignature(wallet: string, message: string, signatureB58: string): boolean {
  try {
    const sig = bs58.decode(signatureB58);
    const msg = new TextEncoder().encode(message);
    const pub = bs58.decode(wallet);
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

// Reject signatures older than 5 minutes to prevent replay.
function isFreshMessage(message: string): boolean {
  const m = message.match(/ts:(\d+)/);
  if (!m) return false;
  return Date.now() - Number(m[1]) < 5 * 60 * 1000;
}

// Bind the signed message to (action, wallet) so a signature for one step or
// wallet can't be replayed for another.
function checkSig(action: string, wallet: string, message: string, signature: string): boolean {
  if (!isFreshMessage(message)) return false;
  if (!message.startsWith(`perpspad-collab:${action}:${wallet}:`)) return false;
  return verifyWalletSignature(wallet, message, signature);
}

const walletSchema = z.string().min(32).max(48);
const signedSchema = {
  wallet: walletSchema,
  message: z.string().min(8).max(200),
  signature: z.string().min(40).max(200),
};

async function getSignup(wallet: string): Promise<SignupRow | null> {
  const { data } = await db
    .from("collab_signups")
    .select("*")
    .eq("wallet_address", wallet)
    .maybeSingle();
  return (data as SignupRow | null) ?? null;
}

async function ensureSignup(wallet: string): Promise<SignupRow> {
  const existing = await getSignup(wallet);
  if (existing) return existing;
  // Upsert with ignoreDuplicates so two simultaneous first-verifies can't 500 on
  // the wallet_address unique constraint — whichever insert lands, we re-read the
  // row afterward.
  const { error } = await db
    .from("collab_signups")
    .upsert({ wallet_address: wallet }, { onConflict: "wallet_address", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  const row = await getSignup(wallet);
  if (!row) throw new Error("Failed to create signup");
  return row;
}

function publicState(row: SignupRow | null) {
  return {
    xFollowed: row?.x_followed ?? false,
    tgJoined: row?.tg_joined ?? false,
    walletVerified: row?.wallet_verified ?? false,
    tgUsername: row?.tg_username ?? null,
    code: row?.code ?? null,
    waitlisted: row?.waitlisted ?? false,
  };
}

async function getCounts() {
  // Read the real pool size so the counter tracks the seeded total (500) and
  // survives any future pool resize — no hardcoded magic number.
  const [{ count: totalCount }, { count: claimedCount }] = await Promise.all([
    db.from("collab_codes").select("*", { count: "exact", head: true }),
    db.from("collab_codes").select("*", { count: "exact", head: true }).eq("assigned", true),
  ]);
  const total = totalCount ?? 0;
  const claimed = claimedCount ?? 0;
  return { claimed, remaining: Math.max(0, total - claimed), total };
}

// ── status: live counts + (optional) this wallet's task state ────────────────
export const getCollabStatus = createServerFn({ method: "GET" })
  .inputValidator((d: { wallet?: string }) =>
    z.object({ wallet: walletSchema.optional() }).parse(d ?? {}),
  )
  .handler(async ({ data }) => {
    const counts = await getCounts();
    const row = data.wallet ? await getSignup(data.wallet) : null;
    return { counts, state: publicState(row), xHandle: X_HANDLE };
  });

// ── task 1: prove wallet ownership (the anchor for every other task) ─────────
export const verifyWallet = createServerFn({ method: "POST" })
  .inputValidator((d: { wallet: string; message: string; signature: string }) =>
    z.object(signedSchema).parse(d),
  )
  .handler(async ({ data }) => {
    if (!checkSig("wallet", data.wallet, data.message, data.signature)) {
      return { ok: false as const, error: "Invalid or stale signature", state: publicState(null) };
    }
    await ensureSignup(data.wallet);
    const { data: updated, error } = await db
      .from("collab_signups")
      .update({ wallet_verified: true })
      .eq("wallet_address", data.wallet)
      .select("*")
      .single();
    if (error) return { ok: false as const, error: error.message, state: publicState(null) };
    return { ok: true as const, error: null, state: publicState(updated as SignupRow) };
  });

// ── task 2: confirm X follow (honor-system; bound to the wallet by signature) ─
// No X developer app is configured, so the follow itself can't be API-verified.
// Adding one later means swapping this body for a real follow lookup — the
// table, the signature binding, and the frontend all stay the same.
export const confirmXFollow = createServerFn({ method: "POST" })
  .inputValidator((d: { wallet: string; message: string; signature: string; handle?: string }) =>
    z.object({ ...signedSchema, handle: z.string().max(40).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    if (!checkSig("x-follow", data.wallet, data.message, data.signature)) {
      return { ok: false as const, error: "Invalid or stale signature", state: publicState(null) };
    }
    const signup = await getSignup(data.wallet);
    if (!signup?.wallet_verified) {
      return { ok: false as const, error: "Verify your wallet first", state: publicState(signup) };
    }
    const { data: updated, error } = await db
      .from("collab_signups")
      .update({ x_followed: true, x_handle: data.handle ?? null })
      .eq("wallet_address", data.wallet)
      .select("*")
      .single();
    if (error) return { ok: false as const, error: error.message, state: publicState(null) };
    return { ok: true as const, error: null, state: publicState(updated as SignupRow) };
  });

// ── task 3: verify Telegram (real — HMAC + bot membership check) ─────────────
export const verifyTelegram = createServerFn({ method: "POST" })
  .inputValidator((d: { wallet: string; auth: TelegramAuth }) =>
    z
      .object({
        wallet: walletSchema,
        auth: z.object({
          id: z.number(),
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          username: z.string().optional(),
          photo_url: z.string().optional(),
          auth_date: z.number(),
          hash: z.string(),
        }),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return { ok: false as const, error: "Telegram not configured", state: publicState(null) };
    }

    const signup = await getSignup(data.wallet);
    if (!signup?.wallet_verified) {
      return { ok: false as const, error: "Verify your wallet first", state: publicState(signup) };
    }

    if (!verifyTelegramAuth(data.auth, botToken)) {
      return { ok: false as const, error: "Telegram verification failed", state: publicState(signup) };
    }

    // If a channel/group is configured, require real membership.
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (chatId) {
      const isMember = await checkTelegramMembership(data.auth.id, botToken, chatId);
      if (!isMember) {
        return {
          ok: false as const,
          error: "Join the Telegram channel first, then retry",
          state: publicState(signup),
        };
      }
    }

    const { data: updated, error } = await db
      .from("collab_signups")
      .update({
        tg_joined: true,
        tg_user_id: data.auth.id,
        tg_username: data.auth.username ?? null,
      })
      .eq("wallet_address", data.wallet)
      .select("*")
      .single();

    // Unique-violation on tg_user_id => this Telegram account already claimed elsewhere.
    if (error) {
      const dup = error.code === "23505";
      return {
        ok: false as const,
        error: dup ? "This Telegram account is already linked to another wallet" : error.message,
        state: publicState(signup),
      };
    }
    return { ok: true as const, error: null, state: publicState(updated as SignupRow) };
  });

// ── claim: atomic code assignment (or waitlist when the pool is empty) ───────
export const claimCode = createServerFn({ method: "POST" })
  .inputValidator((d: { wallet: string; message: string; signature: string }) =>
    z.object(signedSchema).parse(d),
  )
  .handler(async ({ data }) => {
    if (!checkSig("claim", data.wallet, data.message, data.signature)) {
      return { ok: false as const, error: "Invalid or stale signature", code: null, waitlisted: false };
    }

    const { data: code, error } = await db.rpc("claim_collab_code", { p_wallet: data.wallet });

    if (error) {
      const msg =
        error.message?.includes("tasks_incomplete")
          ? "Complete all tasks first"
          : error.message?.includes("no_signup")
            ? "Verify your wallet first"
            : error.message ?? "Claim failed";
      return { ok: false as const, error: msg, code: null, waitlisted: false };
    }

    if (code == null) {
      return { ok: true as const, error: null, code: null, waitlisted: true };
    }
    return { ok: true as const, error: null, code: code as string, waitlisted: false };
  });
