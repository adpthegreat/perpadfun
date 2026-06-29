import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export type HonoraryStatus = "idle" | "awaiting" | "verifying" | "done";

// Open a link; the first time the user returns to this tab, show a ~1s spinner and then mark
// the step complete on the server. "Honorary" — not verified against the destination.
//
// Two correctness hazards this handles deliberately:
//  1. `complete` is a fresh closure on every parent render. Kept in a ref so the listener
//     effect and the pending 1s timer never churn across re-renders — otherwise a re-render
//     triggered by setStatus("verifying") would clear the timer before it fires.
//  2. window.open(..., "noopener") returns null by spec, so its return value can't detect a
//     blocked popup. We track leave/return via blur+visibility, with a fallback timer that
//     honors the step if the user never actually leaves (popup blocked).
export function useHonoraryStep(initialDone: boolean, complete: () => Promise<void>) {
  const [status, setStatus] = useState<HonoraryStatus>(initialDone ? "done" : "idle");
  const armed = useRef(false);
  const left = useRef(false);
  const verifyTimer = useRef<number | undefined>(undefined);
  const fallbackTimer = useRef<number | undefined>(undefined);
  const completeRef = useRef(complete);

  useEffect(() => {
    completeRef.current = complete;
  });

  useEffect(() => {
    if (initialDone) setStatus("done");
  }, [initialDone]);

  const runVerify = useCallback(() => {
    if (!armed.current) return;
    armed.current = false;
    if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    setStatus("verifying");
    verifyTimer.current = window.setTimeout(() => {
      completeRef
        .current()
        .then(() => setStatus("done"))
        .catch((e) => {
          setStatus("idle");
          toast.error(e instanceof Error ? e.message : "Could not save that step");
        });
    }, 1000);
  }, []);

  const open = useCallback(
    (url: string) => {
      if (status === "done") return;
      armed.current = true;
      left.current = false;
      setStatus("awaiting");
      window.open(url, "_blank", "noopener,noreferrer");
      // If the user never actually leaves (popup blocked), honor the step after a beat so it
      // can't get stuck on "awaiting".
      fallbackTimer.current = window.setTimeout(() => {
        if (armed.current && !left.current) runVerify();
      }, 2500);
    },
    [status, runVerify],
  );

  useEffect(() => {
    function markLeft() {
      if (armed.current) left.current = true;
    }
    function tryReturn() {
      if (armed.current && left.current && document.visibilityState === "visible") runVerify();
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") markLeft();
      else tryReturn();
    }
    window.addEventListener("blur", markLeft);
    window.addEventListener("focus", tryReturn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", markLeft);
      window.removeEventListener("focus", tryReturn);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runVerify]);

  // Clear pending timers on unmount only — never on re-render.
  useEffect(
    () => () => {
      if (verifyTimer.current) window.clearTimeout(verifyTimer.current);
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    },
    [],
  );

  return { status, open };
}
