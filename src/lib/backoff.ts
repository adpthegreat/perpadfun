// Exponential backoff (coveooss/exponential-backoff, Apache-2.0) — trimmed +
// typed for the app side. Mirrors keeper/src/backoff.js. Runs `request`; on a
// thrown error, retries with exponential delay (startingDelay * timeMultiple^n,
// capped at maxDelay), optional jitter, up to numOfAttempts. `retry(err, n)`
// returns false to surface the error immediately.

export type BackoffOptions = {
  delayFirstAttempt?: boolean;
  jitter?: "none" | "full";
  maxDelay?: number;
  numOfAttempts?: number;
  retry?: (e: unknown, attemptNumber: number) => boolean | Promise<boolean>;
  startingDelay?: number;
  timeMultiple?: number;
};

const DEFAULTS: Required<BackoffOptions> = {
  delayFirstAttempt: false,
  jitter: "none",
  maxDelay: Infinity,
  numOfAttempts: 10,
  retry: () => true,
  startingDelay: 100,
  timeMultiple: 2,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function backOff<T>(request: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const o = { ...DEFAULTS, ...options };
  if (o.numOfAttempts < 1) o.numOfAttempts = 1;

  let attempt = 0;
  while (attempt < o.numOfAttempts) {
    try {
      if (attempt > 0 || o.delayFirstAttempt) {
        const power = o.delayFirstAttempt ? attempt : attempt - 1;
        let delay = Math.min(o.startingDelay * Math.pow(o.timeMultiple, Math.max(0, power)), o.maxDelay);
        if (o.jitter === "full") delay = Math.round(Math.random() * delay);
        await sleep(delay);
      }
      return await request();
    } catch (e) {
      attempt += 1;
      const shouldRetry = await o.retry(e, attempt);
      if (!shouldRetry || attempt >= o.numOfAttempts) throw e;
    }
  }
  throw new Error("backOff: exhausted attempts");
}
