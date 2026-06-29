// @vitest-environment jsdom
//
// Exercises the headline honorary interaction (open link → return → ~1s spinner → done) in a
// real React render cycle with fake timers. The second case is a regression guard: it forces
// re-renders mid-spinner (each passing a fresh `complete` closure, like the real parent). The
// pre-fix hook cleared its timer on every re-render, so this case would hang on "verifying".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen, fireEvent, cleanup } from "@testing-library/react";
import { useHonoraryStep } from "../../src/lib/quest/useHonoraryStep";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function Harness({ complete, tick }: { complete: () => Promise<void>; tick: number }) {
  // `complete` is intentionally a fresh closure each render (mirrors QuestPage). `tick` is just
  // a prop to force extra re-renders in the regression test.
  const step = useHonoraryStep(false, () => complete());
  return (
    <div>
      <span data-testid="status">{step.status}</span>
      <span data-testid="tick">{tick}</span>
      <button onClick={() => step.open("https://x.com/intent/follow?screen_name=perpspad")}>
        go
      </button>
    </div>
  );
}

describe("useHonoraryStep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    vi.spyOn(window, "open").mockReturnValue(null); // window.open(..,"noopener") returns null
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it("spinner on return, then completes after ~1s", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    render(<Harness complete={complete} tick={0} />);
    expect(screen.getByTestId("status").textContent).toBe("idle");

    act(() => {
      fireEvent.click(screen.getByText("go"));
    });
    expect(screen.getByTestId("status").textContent).toBe("awaiting");

    act(() => setVisibility("hidden")); // user leaves to X
    act(() => setVisibility("visible")); // user returns
    expect(screen.getByTestId("status").textContent).toBe("verifying");
    expect(complete).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status").textContent).toBe("done");
  });

  it("regression: re-renders during the spinner do NOT cancel the 1s timer", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<Harness complete={complete} tick={0} />);
    act(() => {
      fireEvent.click(screen.getByText("go"));
    });
    act(() => setVisibility("hidden"));
    act(() => setVisibility("visible")); // → verifying, 1s timer armed
    expect(screen.getByTestId("status").textContent).toBe("verifying");

    // Re-render twice mid-spinner with fresh `complete` closures — the old bug's trigger.
    act(() => rerender(<Harness complete={complete} tick={1} />));
    act(() => rerender(<Harness complete={complete} tick={2} />));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status").textContent).toBe("done");
  });

  it("popup-blocked fallback completes without a return event", async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    render(<Harness complete={complete} tick={0} />);
    act(() => {
      fireEvent.click(screen.getByText("go"));
    });
    expect(screen.getByTestId("status").textContent).toBe("awaiting");

    // User never leaves (popup blocked) → fallback at 2.5s arms the spinner, then 1s → done.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByTestId("status").textContent).toBe("verifying");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status").textContent).toBe("done");
  });
});
