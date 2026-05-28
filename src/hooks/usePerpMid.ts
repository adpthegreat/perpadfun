import { useEffect, useRef, useState } from "react";

// Singleton WebSocket connection to the perp price feed, shared across
// every component that subscribes via usePerpMid. Reconnects on close.

type MidMap = Record<string, number>;
type Listener = (mids: MidMap) => void;

let ws: WebSocket | null = null;
let mids: MidMap = {};
const listeners = new Set<Listener>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refCount = 0;

function connect() {
  if (typeof window === "undefined") return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket("wss://api.hyperliquid.xyz/ws");

  ws.onopen = () => {
    ws?.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg?.channel === "allMids" && msg.data?.mids) {
        const next: MidMap = {};
        for (const [k, v] of Object.entries(msg.data.mids as Record<string, string>)) {
          next[k] = Number(v);
        }
        mids = { ...mids, ...next };
        listeners.forEach((l) => l(mids));
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    ws = null;
    if (refCount > 0 && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    }
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  refCount++;
  connect();
  if (Object.keys(mids).length) listener(mids);
  return () => {
    listeners.delete(listener);
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      try { ws?.close(); } catch {}
      ws = null;
    }
  };
}

/** Live mid price for a perp market (e.g. "BTC", "ETH", "SOL"). */
export function usePerpMid(coin: string | undefined, fallback?: number) {
  const [mid, setMid] = useState<number | undefined>(
    coin ? (mids[coin] ?? fallback) : fallback,
  );
  const lastRef = useRef<number | undefined>(mid);

  useEffect(() => {
    if (!coin) return;
    return subscribe((m) => {
      const v = m[coin];
      if (v != null && v !== lastRef.current) {
        lastRef.current = v;
        setMid(v);
      }
    });
  }, [coin]);

  return mid;
}
