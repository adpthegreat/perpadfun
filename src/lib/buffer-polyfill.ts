// Side-effect polyfill: ensure Buffer exists as a global before any Solana/bn.js
// module evaluates. Must be imported BEFORE any @solana/* import.
import { Buffer } from "buffer";
import * as buffer from "buffer";

type BufferGlobal = typeof globalThis & {
  Buffer?: typeof Buffer;
  buffer?: typeof buffer;
  global?: typeof globalThis;
};

export function ensureBufferPolyfill() {
  const g = globalThis as BufferGlobal;
  g.Buffer ??= Buffer;
  g.buffer ??= buffer;
  g.global ??= g;

  if (typeof window !== "undefined") {
    const w = window as Window & BufferGlobal;
    w.Buffer ??= Buffer;
    w.buffer ??= buffer;
    w.global ??= g;
  }
}

ensureBufferPolyfill();
