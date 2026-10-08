// Stress chaos run (audit/STRESS-REPORT.md D5): the keeper and the API are two processes on one SQLite file, and the
// connection had no busy timeout, so a write that met another process's open write transaction failed at once with
// "database is locked" (the keeper died at startup inside tryAcquireLock while another connection was writing).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("two processes writing the same database", () => {
  test("a write that meets another process's write transaction waits for it instead of failing", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "busy-")), "busy.sqlite");
    const env = { ...process.env, PAD_DB_FILE: file };
    // Create the schema first, then hold a write transaction for 1.5 s in another process.
    expect(await Bun.spawn(["bun", "-e", "const db = await import('./src/db'); db.getDb();"], { env }).exited).toBe(0);
    const holder = Bun.spawn(["bun", "-e", `
      const { Database } = await import("bun:sqlite");
      const d = new Database(${JSON.stringify(file)});
      d.exec("BEGIN IMMEDIATE"); d.exec("INSERT INTO meta (key, value) VALUES ('busy', '1')");
      console.log("holding"); await Bun.sleep(1500); d.exec("COMMIT");
    `], { env, stdout: "pipe" });
    const reader = holder.stdout.getReader();
    await reader.read(); // "holding"
    const writer = Bun.spawn(["bun", "-e", "const db = await import('./src/db'); console.log(db.tryAcquireLock('epoch', 'w', 60000));"], { env, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([writer.exited, new Response(writer.stdout).text(), new Response(writer.stderr).text()]);
    await holder.exited;
    expect(err).not.toContain("database is locked");
    expect(code).toBe(0);
    expect(out.trim()).toBe("true");
  }, 30_000);
});
