// Vendored from coveooss/exponential-backoff (Apache-2.0), TypeScript stripped.
// https://github.com/coveooss/exponential-backoff
//
// backOff(request, options): runs `request`, and on a thrown error retries with
// exponential delay (startingDelay * timeMultiple^attempt, capped at maxDelay),
// optional jitter, up to numOfAttempts. The `retry(err, attempt)` predicate
// decides whether to keep going — return false to surface the error immediately.

const defaultOptions = {
  delayFirstAttempt: false,
  jitter: "none",
  maxDelay: Infinity,
  numOfAttempts: 12,
  retry: () => true,
  startingDelay: 100,
  timeMultiple: 2,
};

function getSanitizedOptions(options) {
  const sanitized = { ...defaultOptions, ...options };
  if (sanitized.numOfAttempts < 1) sanitized.numOfAttempts = 1;
  return sanitized;
}

function noJitter(delay) {
  return delay;
}

function fullJitter(delay) {
  return Math.round(Math.random() * delay);
}

function JitterFactory(options) {
  switch (options.jitter) {
    case "full":
      return fullJitter;
    case "none":
    default:
      return noJitter;
  }
}

class Delay {
  constructor(options) {
    this.options = options;
    this.attempt = 0;
  }

  apply() {
    return new Promise((resolve) => setTimeout(resolve, this.jitteredDelay));
  }

  setAttemptNumber(attempt) {
    this.attempt = attempt;
  }

  get jitteredDelay() {
    return JitterFactory(this.options)(this.delay);
  }

  get delay() {
    const constant = this.options.startingDelay;
    const base = this.options.timeMultiple;
    const power = this.numOfDelayedAttempts;
    return Math.min(constant * Math.pow(base, power), this.options.maxDelay);
  }

  get numOfDelayedAttempts() {
    return this.attempt;
  }
}

class AlwaysDelay extends Delay {}

class SkipFirstDelay extends Delay {
  async apply() {
    return this.attempt === 0 ? true : super.apply();
  }

  get numOfDelayedAttempts() {
    return this.attempt - 1;
  }
}

function DelayFactory(options, attempt) {
  const delay = options.delayFirstAttempt ? new AlwaysDelay(options) : new SkipFirstDelay(options);
  delay.setAttemptNumber(attempt);
  return delay;
}

export async function backOff(request, options = {}) {
  const opts = getSanitizedOptions(options);
  let attemptNumber = 0;
  while (attemptNumber < opts.numOfAttempts) {
    try {
      await DelayFactory(opts, attemptNumber).apply();
      return await request();
    } catch (e) {
      attemptNumber++;
      const shouldRetry = await opts.retry(e, attemptNumber);
      if (!shouldRetry || attemptNumber >= opts.numOfAttempts) {
        throw e;
      }
    }
  }
  throw new Error("backOff: exhausted attempts");
}
