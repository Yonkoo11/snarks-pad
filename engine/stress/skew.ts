// Preload for the chaos runs (bun --preload stress/skew.ts): shifts this process's clock by SKEW_MS (can be
// negative), the way a VPS with a wrong clock would see time. Date.now() and new Date() both move.
const skew = Number(process.env.SKEW_MS ?? 0);
if (skew !== 0) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class SkewedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(realNow() + skew);
      else super(...(args as [string]));
    }
    static override now(): number {
      return realNow() + skew;
    }
  }
  globalThis.Date = SkewedDate as DateConstructor;
}
