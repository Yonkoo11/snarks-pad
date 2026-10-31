// The reactions Snarks has waiting: one per kind of event (a newer one replaces an older of the same key), none older than a few minutes,
// and not more often than once a minute, so a busy coin cannot make it chatter. Pure, so a test can read it.
export interface Reaction { key: string; at: number; run: () => Promise<void> }

export class ReactionQueue {
  private items: Reaction[] = []
  private lastRun = -Infinity
  constructor(private cooldown = 60_000, private ttl = 180_000) {}

  push(key: string, run: () => Promise<void>, now: number): void {
    this.items = this.items.filter((x) => x.key !== key)
    this.items.push({ key, at: now, run })
  }
  /** The next reaction to play, or null: expired ones are dropped, and nothing plays inside the cooldown. */
  next(now: number): Reaction | null {
    this.items = this.items.filter((x) => now - x.at <= this.ttl)
    if (this.items.length === 0 || now - this.lastRun < this.cooldown) return null
    return this.items[0]
  }
  played(r: Reaction, now: number): void {
    this.items = this.items.filter((x) => x !== r)
    this.lastRun = now
  }
  drop(prefix: string): void { this.items = this.items.filter((x) => !x.key.startsWith(prefix)) }
  get size(): number { return this.items.length }
}
