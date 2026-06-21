/**
 * Race a promise against a deadline. On timeout, resolve to `fallback` instead
 * of rejecting — callers use this to bound work on a latency-critical path
 * (e.g. proactive recall on UserPromptSubmit) and degrade to "skip" rather
 * than stall the turn. The timer is always cleared so the process can exit.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!(ms > 0)) return p;
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}
