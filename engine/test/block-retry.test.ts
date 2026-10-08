// Server soak 2026-10-03: Helius devnet sometimes answered the quote's getBlockTime(slot) with "Block not available",
// failing the trade quote (POST /coins/:mint/trade-tx would answer 500). The read is retried a few times.
import { describe, expect, test } from "bun:test";
import { withBlockRetry } from "../src/dbc/trade";

const notYet = () => new Error("failed to get block time for slot 507077553: Block not available for slot 507077553");

describe("withBlockRetry", () => {
  test("a block that is not yet available is read again, and the later answer is used", async () => {
    let calls = 0;
    const v = await withBlockRetry(async () => {
      calls++;
      if (calls < 3) throw notYet();
      return 42;
    }, 4, 1);
    expect(v).toBe(42);
    expect(calls).toBe(3);
  });

  test("any other error is thrown at once", async () => {
    let calls = 0;
    const err = await withBlockRetry(async () => {
      calls++;
      throw new Error("429 Too Many Requests");
    }, 4, 1).catch((e: Error) => e.message);
    expect(err).toBe("429 Too Many Requests");
    expect(calls).toBe(1);
  });

  test("a block that never becomes available fails after the last try", async () => {
    let calls = 0;
    const err = await withBlockRetry(async () => {
      calls++;
      throw notYet();
    }, 4, 1).catch((e: Error) => e.message);
    expect(err).toContain("Block not available");
    expect(calls).toBe(4);
  });
});
