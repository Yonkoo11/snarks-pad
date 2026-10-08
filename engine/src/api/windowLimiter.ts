// A sliding-window counter per key, for the routes a client can call to make this server do real work (an image upload). In memory, per process:
// one API process serves the site, so one count per address is the right size. A key with no recent calls costs nothing and is forgotten.

export interface WindowLimiter {
  /** null when the call may go ahead (it is counted); else the whole seconds until the oldest call in the window ends and a slot frees. */
  take(key: string): number | null;
  /** For tests: forget every count. */
  clear(): void;
}

const PRUNE_ABOVE_KEYS = 5_000;

export function makeWindowLimiter(max: number, windowMs: number, now: () => number = Date.now): WindowLimiter {
  const hits = new Map<string, number[]>();
  const live = (stamps: number[], t: number): number[] => stamps.filter((s) => t - s < windowMs);
  return {
    take(key) {
      const t = now();
      if (hits.size > PRUNE_ABOVE_KEYS) {
        for (const [k, stamps] of hits) if (live(stamps, t).length === 0) hits.delete(k);
      }
      const recent = live(hits.get(key) ?? [], t);
      if (recent.length >= max) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((recent[0]! + windowMs - t) / 1000));
      }
      recent.push(t);
      hits.set(key, recent);
      return null;
    },
    clear() {
      hits.clear();
    },
  };
}
