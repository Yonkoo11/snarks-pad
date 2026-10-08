// Pro-rata integer distribution. Every amount is base units (zats or raw token
// units) as bigint. Largest-remainder method: sum of shares == total, exactly,
// no matter how badly floor() rounding would otherwise lose or gain units.
export interface WeightedHolder {
  wallet: string;
  balance: bigint; // weight (token balance at snapshot time)
}

export interface Share {
  wallet: string;
  amount: bigint;
}

/** Splits `total` across holders proportional to balance. Total balance must be > 0. */
export function proRataSplit(total: bigint, holders: WeightedHolder[]): Share[] {
  if (total < 0n) throw new Error("total must be >= 0");
  const totalBalance = holders.reduce((acc, h) => acc + h.balance, 0n);
  if (holders.length === 0 || totalBalance === 0n) return [];

  const floors = holders.map((h) => ({
    wallet: h.wallet,
    floor: (total * h.balance) / totalBalance,
    remainder: (total * h.balance) % totalBalance,
  }));
  const distributed = floors.reduce((acc, f) => acc + f.floor, 0n);
  let leftover = total - distributed; // always >= 0 and < holders.length

  // Largest remainder first gets the leftover units, so the sum matches exactly.
  const order = [...floors].sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0));
  const bump = new Set<string>();
  for (const f of order) {
    if (leftover <= 0n) break;
    bump.add(f.wallet);
    leftover -= 1n;
  }
  return floors.map((f) => ({ wallet: f.wallet, amount: f.floor + (bump.has(f.wallet) ? 1n : 0n) }));
}

export interface CarryResult {
  toSend: Share[]; // amount >= dustFloor
  toCarry: Share[]; // amount < dustFloor, rolls into next epoch
}

/** Applies a dust floor: shares (after adding any prior carry) below the floor are held back. */
export function applyDustFloor(shares: Share[], carryIn: Map<string, bigint>, dustFloorZats: bigint): CarryResult {
  const toSend: Share[] = [];
  const toCarry: Share[] = [];
  for (const s of shares) {
    const amount = s.amount + (carryIn.get(s.wallet) ?? 0n);
    if (amount >= dustFloorZats && amount > 0n) toSend.push({ wallet: s.wallet, amount });
    else if (amount > 0n) toCarry.push({ wallet: s.wallet, amount });
  }
  return { toSend, toCarry };
}

export interface ShieldedPolicy {
  /** A holder's shielded share is held (carried) until it reaches this: the Zcash fee is 5,000 zats per output. */
  perHolderMinZats: bigint;
  /** The 1Click swap runs only when the shielded total is at least this (its withdrawFee is 32,000 zats); below it everyone carries. */
  swapMinZats: bigint;
  /**
   * The most the holders' part of one swap may be (audit S6, product decision 2). Above it every share is scaled down to fit,
   * rounded down, and the rest of each carries to the next shielded round: the leg never goes to the public rail for being
   * large. Omitted: no cap here (the adapter's own cap then refuses, which also carries).
   */
  swapMaxZats?: bigint;
}

/**
 * Payout policy for the shielded leg (plan 4, review 2026-09-30): each opted-in
 * holder's share (plus anything carried) is sent only once it reaches
 * `perHolderMinZats`, and the whole leg only runs when the sendable total
 * reaches `swapMinZats`. Anything not sent is carried, never dropped.
 */
export function applyShieldedPolicy(shares: Share[], carryIn: Map<string, bigint>, policy: ShieldedPolicy): CarryResult {
  const held = applyDustFloor(shares, carryIn, policy.perHolderMinZats);
  const sendable = held.toSend.reduce((acc, s) => acc + s.amount, 0n);
  if (sendable < policy.swapMinZats) return { toSend: [], toCarry: [...held.toSend, ...held.toCarry] };
  if (policy.swapMaxZats === undefined || sendable <= policy.swapMaxZats) return held;
  // Over the cap: each share sends its pro-rata part of the cap (rounded down, so the sum never passes it) and carries the
  // rest; a part that would fall under the per-holder minimum carries whole, which only lowers the sum. A wallet can then be
  // in both lists: the planner applies toSend first and toCarry after, so its carry ends as the remainder.
  const toSend: Share[] = [];
  const toCarry: Share[] = [...held.toCarry];
  for (const s of held.toSend) {
    const part = (s.amount * policy.swapMaxZats) / sendable;
    if (part < policy.perHolderMinZats) {
      toCarry.push(s);
      continue;
    }
    toSend.push({ wallet: s.wallet, amount: part });
    if (s.amount > part) toCarry.push({ wallet: s.wallet, amount: s.amount - part });
  }
  return { toSend, toCarry };
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
