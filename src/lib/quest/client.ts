// Browser-side client for the quest API. Thin fetch wrappers over /api/public/quest/* with
// session persistence in localStorage. Responses use the apiOk/apiErr envelope.
import type { QuestSteps } from "@/lib/quest/shared";

const STORAGE_KEY = "perpspad_quest_session";

export type QuestSession = {
  session_id: string;
  referral_code: string;
  referred_by: string | null;
  sol_address: string | null;
  steps: QuestSteps;
};

export type TelegramStatus = { bound: boolean; joined: boolean; status?: string | null };

export function loadSessionId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSessionId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // private mode / disabled storage — session just won't persist across reloads
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: { message?: string } }
    | null;
  if (!res.ok || !json || !json.ok) {
    const msg = (json && !json.ok && json.error?.message) || `request failed (${res.status})`;
    throw new Error(msg);
  }
  return json.data;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return unwrap<T>(res);
}

// Create or resume the quest session. Persists the returned session_id.
export async function startSession(ref?: string | null): Promise<QuestSession> {
  const data = await postJson<QuestSession>("/api/public/quest/session", {
    session_id: loadSessionId() ?? undefined,
    ref: ref ?? undefined,
  });
  saveSessionId(data.session_id);
  return data;
}

export async function recordStep(
  sessionId: string,
  step: "x_follow" | "x_retweet",
): Promise<{ steps: QuestSteps }> {
  return postJson("/api/public/quest/step", { session_id: sessionId, step });
}

export async function fetchTelegramStatus(sessionId: string): Promise<TelegramStatus> {
  const res = await fetch(
    `/api/public/quest/telegram/status?session_id=${encodeURIComponent(sessionId)}`,
  );
  return unwrap<TelegramStatus>(res);
}

export async function submitWallet(
  sessionId: string,
  solAddress: string,
): Promise<{ sol_address: string; steps: QuestSteps }> {
  return postJson("/api/public/quest/wallet", { session_id: sessionId, sol_address: solAddress });
}
