// S4-03 (audit/S4-DIFFERENTIAL-REVIEW.md): an upload just under the pixel limit decodes to hundreds of megabytes, and four at once could take the API unit past its
// 1 GiB. Now at most 2 pictures are decoded at once, 9 more wait their turn, and one more upload is refused 503 busy with retry-after
// (src/publicFiles/decodeGate.ts, src/publicFiles/image.ts, src/api/uploadRoutes.ts, docs/API.md v2.8.2. The limit on the pixels is tested with the images (uploads.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { handleRequest } from "../src/api";
import { MAX_UPLOADS_IN_FLIGHT, uploadLimiter } from "../src/api/uploadRoutes";
import { DecodeQueueFull, makeDecodeGate } from "../src/publicFiles/decodeGate";
import { MAX_DECODES, MAX_WAITING_DECODES, decodeGate, processImage } from "../src/publicFiles/image";

const B = "http://pad.test/api";

/** A task that is running until `release()` is called; `started` says whether the gate has begun it. */
function held() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const task = { started: false, release, run: async () => ((task.started = true), done) };
  return task;
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("the gate", () => {
  test("the stated numbers: 2 at once, 9 waiting, so 11 uploads in flight", () => {
    expect([MAX_DECODES, MAX_WAITING_DECODES, MAX_UPLOADS_IN_FLIGHT]).toEqual([2, 9, 11]);
  });

  test("2 run at once, the third waits and starts when one of them ends, in the order they came; the tenth waiting is refused", async () => {
    const gate = makeDecodeGate(2, 9);
    const tasks = Array.from({ length: 11 }, held);
    const results = tasks.map((t) => gate.run(t.run));
    await tick();
    expect(tasks.map((t) => t.started)).toEqual([true, true, ...Array<boolean>(9).fill(false)]);
    expect(gate.stats()).toEqual({ running: 2, waiting: 9 });
    await expect(gate.run(async () => "never")).rejects.toBeInstanceOf(DecodeQueueFull); // the 10th in the queue
    tasks[0]!.release();
    await tick();
    expect(tasks.map((t) => t.started).indexOf(false)).toBe(3); // the third began, nobody ahead of it was passed over
    expect(gate.stats()).toEqual({ running: 2, waiting: 8 });
    for (const t of tasks) {
      t.release();
      await tick();
    }
    await Promise.all(results);
    expect(tasks.every((t) => t.started)).toBe(true);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0 });
  });

  test("a task that fails gives its place to the next one, and the failure reaches its caller", async () => {
    const gate = makeDecodeGate(1, 3);
    const second = held();
    const first = gate.run(async () => {
      throw new Error("did not decode");
    });
    const next = gate.run(second.run);
    await expect(first).rejects.toThrow("did not decode");
    await tick();
    expect(second.started).toBe(true);
    second.release();
    await next;
    expect(gate.stats()).toEqual({ running: 0, waiting: 0 });
  });

  test("a refused task takes no place and leaves the count where it was", async () => {
    const gate = makeDecodeGate(1, 1);
    const a = held();
    const b = held();
    const ra = gate.run(a.run);
    const rb = gate.run(b.run);
    await expect(gate.run(async () => 0)).rejects.toBeInstanceOf(DecodeQueueFull);
    expect(gate.stats()).toEqual({ running: 1, waiting: 1 });
    a.release();
    b.release();
    await Promise.all([ra, rb]);
    expect(gate.stats()).toEqual({ running: 0, waiting: 0 });
  });
});

describe("the decoder is behind it", () => {
  const picture = (n: number) => sharp({ create: { width: 1_800 + n, height: 1_800, channels: 3, background: { r: n, g: 90, b: 160 } } }).png({ compressionLevel: 1 }).toBuffer();

  test("six pictures sent at once are decoded two at a time, and all six come out", async () => {
    const inputs = await Promise.all([0, 1, 2, 3, 4, 5].map(picture));
    let peak = 0;
    let waited = 0;
    const watcher = setInterval(() => {
      const { running, waiting } = decodeGate.stats();
      peak = Math.max(peak, running);
      waited = Math.max(waited, waiting);
    }, 1);
    const out = await Promise.all(inputs.map((b) => processImage(b)));
    clearInterval(watcher);
    expect(out.every((o) => o.kind === "png" && o.width === 1_000)).toBe(true);
    expect(peak).toBe(2);
    expect(waited).toBeGreaterThanOrEqual(1);
    expect(decodeGate.stats()).toEqual({ running: 0, waiting: 0 });
  });

  test("the 12th picture sent at once is refused (2 running, 9 waiting, then none), the other 11 are decoded", async () => {
    const one = new Uint8Array(await picture(7));
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => processImage(one)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(11);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toBeInstanceOf(DecodeQueueFull);
  });
});

describe("the upload route", () => {
  let ipCounter = 0;
  const freshIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;
  const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: "#c42f6c" } }).png().toBuffer();
  const form = async () => {
    const f = new FormData();
    f.append("file", new File([await png()], "p.png", { type: "image/png" }));
    return f;
  };
  afterEach(() => uploadLimiter.clear());

  test("with the decoder's queue full an upload is 503 busy with retry-after 5, and the same upload goes through once a place opens", async () => {
    const holds = Array.from({ length: MAX_DECODES + MAX_WAITING_DECODES }, held);
    const running = holds.map((h) => decodeGate.run(h.run));
    await tick();
    expect(decodeGate.stats()).toEqual({ running: MAX_DECODES, waiting: MAX_WAITING_DECODES });
    const refused = await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: await form() }), { ip: freshIp() });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "busy" });
    expect(refused.headers.get("retry-after")).toBe("5");
    for (const h of holds) h.release();
    await Promise.all(running);
    const ok = await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: await form() }), { ip: freshIp() });
    expect(ok.status).toBe(200);
  });

  test("11 uploads in flight fill the route: the 12th is 503 busy at once, before its body is read, and slow senders do not hold a decoder", async () => {
    const stalled: { close(): void }[] = [];
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < MAX_UPLOADS_IN_FLIGHT; i++) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
      stalled.push({ close: () => controller.close() });
      pending.push(handleRequest(new Request(`${B}/uploads`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" }, body, duplex: "half" } as RequestInit), { ip: freshIp() }));
    }
    await tick();
    expect(decodeGate.stats()).toEqual({ running: 0, waiting: 0 }); // nothing is decoding: the senders have not sent a file
    const twelfth = await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: await form() }), { ip: freshIp() });
    expect(twelfth.status).toBe(503);
    expect(await twelfth.json()).toEqual({ error: "busy" });
    expect(twelfth.headers.get("retry-after")).toBe("5");
    for (const s of stalled) s.close();
    const answers = await Promise.all(pending);
    expect(answers.map((r) => r.status)).toEqual(Array<number>(MAX_UPLOADS_IN_FLIGHT).fill(400)); // an empty multipart body: bad_request, and the place is given back
    const after = await handleRequest(new Request(`${B}/uploads`, { method: "POST", body: await form() }), { ip: freshIp() });
    expect(after.status).toBe(200);
  });
});
