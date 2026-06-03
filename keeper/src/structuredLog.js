function base(level, message, fields = {}) {
  const row = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(row);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(message, fields = {}) {
  base("info", message, fields);
}

export function logWarn(message, fields = {}) {
  base("warn", message, fields);
}

export function logError(message, fields = {}) {
  base("error", message, fields);
}

export function tokenLog(token, step, message, fields = {}) {
  logInfo(message, {
    token_id: token?.id,
    ticker: token?.ticker,
    step,
    ...fields,
  });
}

let _tickSeq = 0;
// Short, time-sortable correlation id for one tick. Lets you grep every line
// (and the per-token summaries) from a single tick together in the Fly stream.
export function newTickId() {
  return `t${Date.now().toString(36)}${(_tickSeq++ % 1000).toString(36).padStart(2, "0")}`;
}

// One structured summary line per token per tick. `event:"token_tick"` is a
// stable filter key; the numeric fields are the per-token metrics. See
// KEEPER_OBSERVABILITY.md.
export function tokenTickSummary(tickId, token, fields = {}) {
  base("info", "token tick", {
    event: "token_tick",
    tick_id: tickId,
    token_id: token?.id,
    ticker: token?.ticker,
    ...fields,
  });
}

// One structured aggregate line per tick (`event:"tick_summary"`).
export function tickSummary(tickId, fields = {}) {
  base("info", "tick summary", {
    event: "tick_summary",
    tick_id: tickId,
    ...fields,
  });
}
