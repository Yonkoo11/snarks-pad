// A value worked out at most once per window, for public routes that many callers hit at once: the stress API load run
// (audit/STRESS-REPORT.md D6, D7) showed that work done per request does not survive load, work done per window does.

export interface TtlMemo<T> {
  get(): T;
  /** Forgets the kept value, so the next get() works it out again. */
  clear(): void;
}

/**
 * `compute(nowMs)` runs on the first get() and again once the kept value is `maxAgeMs` old (0 = every call). It receives
 * the time the window was judged at, so a window that ends "now" and the clock that ages the value are the same reading.
 * A compute that throws keeps nothing: the next get() tries again. A clock that moves backwards ages the value out
 * rather than freezing it.
 */
export function makeTtlMemo<T>(compute: (nowMs: number) => T, maxAgeMs: number, now: () => number = Date.now): TtlMemo<T> {
  let kept: { atMs: number; value: T } | null = null;
  return {
    get() {
      const t = now();
      const age = kept ? t - kept.atMs : -1;
      if (kept && age >= 0 && age < maxAgeMs) return kept.value;
      const value = compute(t);
      kept = { atMs: t, value };
      return value;
    },
    clear() {
      kept = null;
    },
  };
}
