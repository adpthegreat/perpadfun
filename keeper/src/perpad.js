// HTTP client for the perpad.fun keeper API.
// Replaces direct Supabase access — the keeper now talks only to the app.

import { config } from './config.js';

const BASE = config.perpadBaseUrl;
const SECRET = config.keeperSecret;

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-keeper-secret': SECRET,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.ok === false) {
    throw new Error(`perpad ${path} ${res.status}: ${json.error ?? text}`);
  }
  return json;
}

export async function listActiveTokens() {
  const r = await call('/api/public/keeper/tokens', { method: 'GET' });
  return r.tokens ?? [];
}

export async function sendReport(reports) {
  if (!reports.length) return { ok: true, tokens_updated: 0, events_inserted: 0 };
  return call('/api/public/keeper/report', {
    method: 'POST',
    body: JSON.stringify({ reports }),
  });
}
