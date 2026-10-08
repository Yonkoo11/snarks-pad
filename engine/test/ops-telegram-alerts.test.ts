// Alerts on Telegram: ops/healthcheck.sh sends the health message to the owner's bot, and ops/telegram-setup.sh finds and saves the owner's chat (the pair
// reaches the server through ops/push-secrets.sh, tested in ops-instances.test.ts). Both scripts run here against a stand-in curl in a scratch directory
// first in PATH: it writes down the arguments of every call and the config curl was given on stdin, answers from the test's settings and reaches no network.
// HOME is the scratch directory and the alerts file is named by ALERTS_ENV_FILE, so no test can read the owner's real files or send a real message.
// The engine's open alerts are read from a real database (the engine's own alerts table, made from the DDL in src/db.ts, in WAL mode, held open like the API and keeper hold theirs) by the real sqlite3.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const TOKEN = "123456789:AAH-test_TOKEN0123456789abcdefghijk";
const CHAT = "424242424";
const HOOK = "https://hooks.example.test/api/webhooks/9/hooksecret";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// What the stand-in curl does with its arguments: call-N.argv (NUL-separated), call-N.cfg (what it read from `-K -`), and an answer by address.
const CURL = `
d="$FAKE_DIR"
n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/n"
printf '%s\\0' "$@" > "$d/call-$n.argv"
cfg=""; fmt=""; out=""; prev=""; : > "$d/call-$n.cfg"
for a in "$@"; do
  [ "$prev" = "-K" ] && [ "$a" = "-" ] && { cat > "$d/call-$n.cfg"; cfg="$(cat "$d/call-$n.cfg")"; }
  [ "$prev" = "-w" ] && fmt="$a"
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
code=200; body=""; fail=""
case "$* $cfg" in
  *api.telegram.org*getUpdates*) code="$FAKE_UPDATES_CODE"; body="$(cat "$d/updates.json")"; [ "$FAKE_FAIL" != telegram ] || fail=1 ;;
  *api.telegram.org*sendMessage*) code="$FAKE_SEND_CODE"; body='{"ok":true}'; [ "$FAKE_FAIL" != telegram ] || fail=1 ;;
  *hooks.example.test*) code="$FAKE_HOOK_CODE"; [ "$FAKE_FAIL" != hook ] || fail=1 ;;
  */treasury*) body="$FAKE_TREASURY"; [ -n "$body" ] || body='{"paused":false,"epochsNeedingAttention":0}' ;;
esac
[ -z "$fail" ] || { code=000; body=""; }
[ "$out" = /dev/null ] || printf '%s' "$body"
[ -z "$fmt" ] || printf '%b' "$(printf '%s' "$fmt" | sed "s/%{http_code}/$code/")"
[ -z "$fail" ] || exit 7
exit 0`;

interface Call {
  argv: string[];
  cfg: string;
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b);
/** The values that follow each occurrence of a curl option. */
const after = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag ? [argv[i + 1] ?? ""] : []));

function world() {
  const dir = mkdtempSync(join(tmpdir(), "tgalert-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stand = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stand("curl", CURL);
  return {
    dir,
    stand,
    calls(): Call[] {
      const n = existsSync(join(dir, "n")) ? Number(readFileSync(join(dir, "n"), "utf8")) : 0;
      return Array.from({ length: n }, (_, i) => ({
        argv: readFileSync(join(dir, `call-${i + 1}.argv`), "utf8").split("\0").slice(0, -1),
        cfg: readFileSync(join(dir, `call-${i + 1}.cfg`), "utf8"),
      }));
    },
    run(script: string, env: Record<string, string> = {}) {
      const base = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: dir, FAKE_DIR: dir, FAKE_UPDATES_CODE: "200", FAKE_SEND_CODE: "200", FAKE_HOOK_CODE: "204", FAKE_FAIL: "" };
      const r = Bun.spawnSync(["bash", "-c", script], { cwd: REPO, env: { ...base, ...env } });
      return { code: r.exitCode, out: text(r.stdout), err: text(r.stderr) };
    },
  };
}

/** The health check with everything healthy except, when `clock` is "no", the server's clock: so the clock decides whether there is a message. */
function health(clock: "yes" | "no") {
  const w = world();
  w.stand("systemctl", "exit 0");
  w.stand("df", `printf 'Use%%\\n 12%%\\n'`);
  w.stand("stat", "date +%s"); // the keeper's health log was just written
  w.stand("timedatectl", `echo ${clock}`);
  const keeperLog = join(w.dir, "keeper-health.log");
  writeFileSync(keeperLog, "{}\n");
  return { ...w, check: (env: Record<string, string> = {}) => w.run("ops/healthcheck.sh", { PAD_KEEPER_HEALTH_LOG: keeperLog, HEALTH_API: "http://127.0.0.1:1/api", PAD_HEALTH_PROBLEMS_SENT: join(w.dir, "problems-sent"), ...env }) };
}
const TG = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT };
const messageOf = (err: string): string => err.split("\n")[0]!;
const noSecret = (out: string, calls: Call[]) => {
  expect(out).not.toContain(TOKEN);
  expect(out).not.toContain("api.telegram.org");
  for (const c of calls) expect(c.argv.join(" ")).not.toContain(TOKEN);
};

describe("ops/healthcheck.sh sends the health message to Telegram", () => {
  test("nothing is wrong: nothing is sent, whatever is set", () => {
    const w = health("yes");
    const r = w.check({ ...TG, ALERT_WEBHOOK_URL: HOOK });
    expect([r.code, r.out.trim(), r.err]).toEqual([0, "snarks health: ok", ""]);
    expect(w.calls()).toHaveLength(1); // the API read only
  });

  test("both variables set: one message, the one the journal gets, to the bot's address, which reaches curl on stdin and never on a command line", () => {
    const w = health("no");
    const r = w.check(TG);
    const msg = messageOf(r.err);
    expect(r.code).toBe(1);
    expect(msg).toContain("Test site: server clock is NOT synchronised");
    const calls = w.calls();
    expect(calls).toHaveLength(2); // the API read, then Telegram
    const tg = calls[1]!;
    expect(after(tg.argv, "--max-time")).toEqual(["10"]);
    expect(after(tg.argv, "--data-urlencode").sort()).toEqual([`chat_id=${CHAT}`, `text=${msg}`].sort());
    expect(tg.cfg).toBe(`url = "https://api.telegram.org/bot${TOKEN}/sendMessage"\n`);
    expect(r.err).toContain("telegram answered HTTP 200");
    noSecret(r.out + r.err, calls);
  });

  // a round still not done 2 hours after it was due (devnet 2026-10-06: a dry keeper failed every claim for 21 hours and nothing alerted)
  const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString(); // with milliseconds, as GET /treasury writes it
  const treasury = (o: Record<string, unknown>) => JSON.stringify({ paused: false, epochsNeedingAttention: 0, ...o });
  test("a payout round still not done 2 hours after it was due is a problem, with how late it is and when it was due", () => {
    const r = health("yes").check({ ...TG, FAKE_TREASURY: treasury({ nextEpochAt: iso(3 * 60 + 5) }) });
    expect(r.code).toBe(1);
    expect(messageOf(r.err)).toMatch(/^Test site: payout round overdue by 3h [45]m \(it was due 20\d\d-/);
  }, 20_000);

  test("due 30 minutes ago, or no round planned yet (mainnet before its first), is not a problem", () => {
    const soon = health("yes").check({ ...TG, FAKE_TREASURY: treasury({ nextEpochAt: iso(30) }) });
    expect([soon.code, soon.err]).toEqual([0, ""]);
    const none = health("yes").check({ ...TG, FAKE_TREASURY: treasury({ nextEpochAt: null }) });
    expect([none.code, none.err]).toEqual([0, ""]);
  }, 20_000);

  test("paused payouts are reported as paused, not as overdue; PAD_HEALTH_OVERDUE_MINUTES moves the line", () => {
    const paused = health("yes").check({ ...TG, FAKE_TREASURY: treasury({ paused: true, nextEpochAt: iso(600) }) });
    expect(messageOf(paused.err)).toBe("Test site: payouts are PAUSED");
    const shorter = health("yes").check({ ...TG, PAD_HEALTH_OVERDUE_MINUTES: "20", FAKE_TREASURY: treasury({ nextEpochAt: iso(30) }) });
    expect(messageOf(shorter.err)).toContain("payout round overdue by 0h 30m");
  }, 20_000);

  test("a standing problem reaches the phone once, again only after PAD_HEALTH_REPEAT_MINUTES or when its text changes, and its recovery once (2026-10-07: the same line every 5 minutes)", () => {
    const w = health("no");
    const sends = () => w.calls().filter((c) => c.cfg.includes("sendMessage")).length;
    const r1 = w.check(TG);
    expect([r1.code, sends()]).toEqual([1, 1]);
    const r2 = w.check(TG); // five minutes later, the same problem: the journal gets it, the phone does not
    expect([r2.code, sends()]).toEqual([1, 1]);
    expect(messageOf(r2.err)).toContain("server clock is NOT synchronised");
    const r3 = w.check({ ...TG, PAD_HEALTH_REPEAT_MINUTES: "0" }); // the repeat time has passed
    expect([r3.code, sends()]).toEqual([1, 2]);
    const r4 = w.check({ ...TG, FAKE_TREASURY: JSON.stringify({ paused: true, epochsNeedingAttention: 0 }) }); // a second problem joins: a new text, sent at once
    expect([r4.code, sends()]).toEqual([1, 3]);
    expect(after(w.calls().at(-1)!.argv, "--data-urlencode").join(" ")).toContain("payouts are PAUSED");
    w.stand("timedatectl", "echo yes"); // fixed
    const r5 = w.check(TG);
    expect([r5.code, r5.out.trim(), sends()]).toEqual([0, "snarks health: ok", 4]);
    expect(after(w.calls().at(-1)!.argv, "--data-urlencode").join(" ")).toMatch(/text=Test site: recovered \(was: payouts are PAUSED;server clock is NOT synchronised/);
    const r6 = w.check(TG); // still fine: nothing more
    expect([r6.code, sends()]).toEqual([0, 4]);
  }, 30_000);

  test("a status that is not 200, and a call that fails, are logged as the status alone; the check still fails and no secret is printed", () => {
    for (const [env, status] of [
      [{ FAKE_SEND_CODE: "401" }, "401"],
      [{ FAKE_SEND_CODE: "400" }, "400"],
      [{ FAKE_FAIL: "telegram" }, "000"],
    ] as const) {
      const w = health("no");
      const r = w.check({ ...TG, ...env });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`telegram answered HTTP ${status}`);
      noSecret(r.out + r.err, w.calls());
    }
  });

  test("only one of the two set: nothing is sent to Telegram and the journal names the variables, never a value", () => {
    const halves: Record<string, string>[] = [{ TELEGRAM_BOT_TOKEN: TOKEN }, { TELEGRAM_CHAT_ID: CHAT }];
    for (const only of halves) {
      const w = health("no");
      const r = w.check(only);
      expect(r.code).toBe(1);
      expect(w.calls()).toHaveLength(1);
      expect(r.err).toContain("telegram not used: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set");
      expect(r.err).not.toContain(CHAT);
      noSecret(r.out + r.err, w.calls());
    }
  });

  test("neither set, or both empty as push-secrets.sh writes them: no call and no word about Telegram", () => {
    const unset: Record<string, string>[] = [{}, { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }];
    for (const env of unset) {
      const w = health("no");
      const r = w.check(env);
      expect(r.code).toBe(1);
      expect(w.calls()).toHaveLength(1);
      expect(r.err.toLowerCase()).not.toContain("telegram");
    }
  });

  test("the webhook alone is as it was: the message as {content} JSON to its address, 10 seconds, its status logged, no Telegram", () => {
    const w = health("no");
    const r = w.check({ ALERT_WEBHOOK_URL: HOOK });
    const msg = messageOf(r.err);
    expect(r.code).toBe(1);
    const calls = w.calls();
    expect(calls).toHaveLength(2);
    const hook = calls[1]!;
    expect(after(hook.argv, "--max-time")).toEqual(["10"]);
    expect(after(hook.argv, "-H")).toEqual(["content-type: application/json"]);
    expect(JSON.parse(after(hook.argv, "-d")[0]!)).toEqual({ content: msg });
    expect(hook.argv.at(-1)).toBe(HOOK);
    expect(r.err).toContain("alert webhook answered HTTP 204");
    expect(r.err).not.toContain("hooksecret");
    expect(r.err.toLowerCase()).not.toContain("telegram");
  });

  test("both set: each gets the message and logs its own status, and one failing does not stop the other", () => {
    const both = { ...TG, ALERT_WEBHOOK_URL: HOOK };
    const ok = health("no");
    const r = ok.check(both);
    expect(r.code).toBe(1);
    expect(ok.calls()).toHaveLength(3);
    expect(r.err).toContain("alert webhook answered HTTP 204");
    expect(r.err).toContain("telegram answered HTTP 200");
    for (const [fail, expectLine] of [
      ["telegram", "alert webhook answered HTTP 204"],
      ["hook", "telegram answered HTTP 200"],
    ] as const) {
      const w = health("no");
      const f = w.check({ ...both, FAKE_FAIL: fail });
      expect(f.code).toBe(1);
      expect(w.calls()).toHaveLength(3);
      expect(f.err).toContain(expectLine);
      expect(f.err).not.toContain("hooksecret");
      noSecret(f.out + f.err, w.calls());
    }
  });
});

describe("ops/healthcheck.sh forwards the engine's open alerts", () => {
  // The DDL is read from the engine's source, so a change to the table's columns reaches this test's database and breaks the health check's query here, not on the server.
  const ALERTS_DDL = /CREATE TABLE IF NOT EXISTS alerts \([\s\S]*?\n  \)/.exec(readFileSync(join(REPO, "engine", "src", "db.ts"), "utf8"))?.[0] ?? "";
  const open: Database[] = [];
  afterAll(() => open.forEach((d) => d.close()));

  function setup(clock: "yes" | "no" = "yes") {
    const w = health(clock);
    // a sqlite3 that writes down its arguments, then is the real one (the rest of PATH, without this directory)
    w.stand("sqlite3", `echo "$*" >> "$FAKE_DIR/sqlite3.args"\nPATH="\${PATH#*:}" exec sqlite3 "$@"`);
    const path = join(w.dir, "devnet.sqlite");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(ALERTS_DDL);
    open.push(db);
    let n = 0;
    const raise = (kind: string, message: string, epochId = ""): number => {
      n += 1;
      const at = `2026-10-06T10:${String(n).padStart(2, "0")}:00.000Z`;
      return Number(db.query("INSERT INTO alerts (at,kind,epochId,message) VALUES ($at,$k,$e,$m)").run({ $at: at, $k: kind, $e: epochId, $m: message }).lastInsertRowid);
    };
    const resolve = (id: number) => db.query("UPDATE alerts SET resolvedAt = $t WHERE id = $id").run({ $t: "2026-10-06T12:00:00.000Z", $id: id });
    const state = join(w.dir, "alerts-sent");
    const run = (env: Record<string, string> = {}) => w.check({ PAD_DB_FILE: path, PAD_HEALTH_ALERTS_SENT: state, ...TG, ...env });
    /** The text of every message sent to Telegram, in order. */
    const sends = (): string[] =>
      w.calls().filter((c) => c.cfg.includes("sendMessage")).map((c) => after(c.argv, "--data-urlencode").find((a) => a.startsWith("text="))!.slice("text=".length));
    return { ...w, raise, resolve, state, run, sends, path };
  }

  test("an open alert is sent once, as its kind and text, with the database opened read-only; a resolved one is never sent; the state file is 0600; no secret is printed", () => {
    const s = setup();
    s.resolve(s.raise("faucet_low", "devnet faucet is running low (an old one)"));
    s.raise("rpc_budget", "rpc budget 50%: the last 24 hours cost about 100 credits");
    const first = s.run();
    expect([first.code, first.out.trim()]).toEqual([0, "snarks health: ok"]); // an alert alone does not fail the check
    expect(s.sends()).toEqual(["Test site alert rpc_budget: rpc budget 50%: the last 24 hours cost about 100 credits"]);
    expect(first.err).toContain("telegram answered HTTP 200");
    expect(readFileSync(join(s.dir, "sqlite3.args"), "utf8")).toContain("-readonly");
    expect(statSync(s.state).mode & 0o777).toBe(0o600);
    expect(readFileSync(s.state, "utf8")).toBe("2|2026-10-06T10:02:00.000Z\n");
    const second = s.run();
    expect([second.code, second.out.trim(), second.err]).toEqual([0, "snarks health: ok", ""]);
    expect(s.sends()).toHaveLength(1);
    noSecret(first.out + first.err + second.err, s.calls());
  });

  test("a new alert is sent alone; a resolved one drops out of the file, and raised again it is a new alert and goes out again", () => {
    const s = setup();
    const faucet = s.raise("faucet_low", "devnet faucet is running low");
    s.run();
    s.raise("epoch_parked", "epoch e1 parked", "e1");
    s.run();
    expect(s.sends()).toEqual(["Test site alert faucet_low: devnet faucet is running low", "Test site alert epoch_parked: epoch e1 parked"]);
    s.resolve(faucet);
    s.run();
    expect(s.sends()).toHaveLength(2);
    expect(readFileSync(s.state, "utf8")).toBe("2|2026-10-06T10:02:00.000Z\n");
    s.raise("faucet_low", "devnet faucet is running low");
    s.run();
    expect(s.sends()).toHaveLength(3);
    expect(s.sends()[2]).toBe("Test site alert faucet_low: devnet faucet is running low");
  });

  test("with a health problem too it is one message, the health line and then a line per alert; the exit code is the problem's", () => {
    const s = setup("no");
    s.raise("rpc_budget", "rpc budget 80%: A");
    s.raise("faucet_low", "devnet faucet is running low");
    const r = s.run();
    expect(r.code).toBe(1);
    expect(s.sends()).toHaveLength(1);
    const lines = s.sends()[0]!.split("\n");
    expect(lines[0]).toContain("Test site: server clock is NOT synchronised");
    expect(lines.slice(1)).toEqual(["Test site alert rpc_budget: rpc budget 80%: A", "Test site alert faucet_low: devnet faucet is running low"]);
    expect(r.err.split("\n").slice(0, 3)).toEqual(lines); // the journal gets the same lines
  });

  test("a message nobody accepted is not remembered: a refused send, a call that fails and no channel set all leave it for the next check", () => {
    const s = setup();
    s.raise("rpc_budget", "rpc budget 50%: A");
    expect(s.run({ FAKE_SEND_CODE: "500" }).err).toContain("telegram answered HTTP 500");
    expect(s.run({ FAKE_FAIL: "telegram" }).err).toContain("telegram answered HTTP 000");
    s.run({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" });
    expect(existsSync(s.state)).toBe(false);
    expect(s.sends()).toHaveLength(2); // the two that were tried
    expect(s.run().err).toContain("telegram answered HTTP 200");
    expect(s.sends()).toHaveLength(3);
    expect(s.run().err).toBe("");
    expect(s.sends()).toHaveLength(3);
  });

  test("every channel that is set gets it, and one that accepts is enough to remember it", () => {
    const s = setup();
    s.raise("rpc_budget", "rpc budget 50%: A");
    const r = s.run({ ALERT_WEBHOOK_URL: HOOK, FAKE_SEND_CODE: "500" });
    expect(r.err).toContain("alert webhook answered HTTP 204");
    expect(r.err).toContain("telegram answered HTTP 500");
    const hook = s.calls().find((c) => c.argv.at(-1) === HOOK)!;
    expect(JSON.parse(after(hook.argv, "-d")[0]!)).toEqual({ content: "Test site alert rpc_budget: rpc budget 50%: A" });
    expect(s.run({ ALERT_WEBHOOK_URL: HOOK, FAKE_SEND_CODE: "500" }).err).toBe(""); // remembered: nothing sent, nothing said
  });

  test("no database is no failure: nothing is read, sent or written and the journal says nothing; one that cannot be read is said so and is no failure either", () => {
    const s = setup();
    s.raise("rpc_budget", "rpc budget 50%: A");
    const missing = s.run({ PAD_DB_FILE: join(s.dir, "nope.sqlite") });
    expect([missing.code, missing.out.trim(), missing.err]).toEqual([0, "snarks health: ok", ""]);
    expect(existsSync(s.state)).toBe(false);
    const garbage = join(s.dir, "garbage.sqlite");
    writeFileSync(garbage, "this is not a database. ".repeat(100));
    const unreadable = s.run({ PAD_DB_FILE: garbage });
    expect(unreadable.code).toBe(0);
    expect(unreadable.err).toContain("engine alerts not read");
    expect(existsSync(s.state)).toBe(false);
    expect(s.sends()).toHaveLength(0);
    const down = health("no").check({ PAD_DB_FILE: join(s.dir, "nope.sqlite"), ...TG }); // a real problem is still the only reason to fail
    expect(down.code).toBe(1);
    expect(down.err).toContain("Test site: server clock is NOT synchronised");
  });

  test("at most 4 alerts a message and the rest at the next check, none twice; a long text is cut at 300 characters and is one line", () => {
    const s = setup();
    const long = `first line\nsecond line\tafter a tab ${"x".repeat(400)}`;
    s.raise("holder_samples_short", long);
    for (let i = 2; i <= 6; i++) s.raise("holder_samples_short", `short window ${i}`);
    s.run();
    const flat = long.replace(/[\n\t]/g, " ");
    expect(s.sends()[0]!.split("\n")).toEqual([
      `Test site alert holder_samples_short: ${flat.slice(0, 297)}...`,
      "Test site alert holder_samples_short: short window 2",
      "Test site alert holder_samples_short: short window 3",
      "Test site alert holder_samples_short: short window 4",
    ]);
    s.run();
    expect(s.sends()[1]!.split("\n")).toEqual(["Test site alert holder_samples_short: short window 5", "Test site alert holder_samples_short: short window 6"]);
    s.run();
    expect(s.sends()).toHaveLength(2);
  });

  test("a state file that cannot be written is said so; the alert still goes out, and goes out again at the next check", () => {
    const s = setup();
    s.raise("rpc_budget", "rpc budget 50%: A");
    const env = { PAD_HEALTH_ALERTS_SENT: join(s.dir, "no-such-dir", "sent") };
    const r = s.run(env);
    expect(r.code).toBe(0);
    expect(r.err).toContain("alert state not written");
    expect(s.sends()).toHaveLength(1);
    s.run(env);
    expect(s.sends()).toHaveLength(2);
  });
});

describe("ops/telegram-setup.sh", () => {
  const update = (id: number, name: string, type = "private", body = "/start") => ({
    update_id: id,
    message: { message_id: 1, from: { id, is_bot: false, first_name: name }, chat: { id, first_name: name, type }, date: 1, text: body },
  });
  const ALERTS = `ALERT_WEBHOOK_URL=\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`;

  function setup(o: { alerts?: string | null; updates?: unknown; updatesBody?: string; env?: Record<string, string> } = {}) {
    const w = world();
    const file = join(w.dir, "alerts.env");
    if (o.alerts !== null) {
      writeFileSync(file, o.alerts ?? ALERTS);
      chmodSync(file, 0o644);
    }
    writeFileSync(join(w.dir, "updates.json"), o.updatesBody ?? JSON.stringify(o.updates ?? { ok: true, result: [] }));
    return { ...w, file, saved: () => readFileSync(file, "utf8"), go: () => w.run("ops/telegram-setup.sh", { ALERTS_ENV_FILE: file, ...o.env }) };
  }
  const methods = (calls: Call[]): string[] => calls.map((c) => /\/bot[^/]*\/(\w+)/.exec(c.cfg)?.[1] ?? "?");

  test("one private chat has written to the bot: its id is appended to the alerts file (0600), only its first name is printed, one test message goes to it and its status is printed", () => {
    const w = setup({ updates: { ok: true, result: [update(Number(CHAT), "Ada"), update(Number(CHAT), "Ada", "private", "hello")] } });
    const r = w.go();
    expect([r.code, r.out, r.err]).toEqual([0, "chat found: Ada\ntest message answered HTTP 200\n", ""]);
    expect(w.saved()).toBe(`${ALERTS}TELEGRAM_CHAT_ID=${CHAT}\n`);
    expect(statSync(w.file).mode & 0o777).toBe(0o600);
    const calls = w.calls();
    expect(methods(calls)).toEqual(["getUpdates", "sendMessage"]);
    const send = calls[1]!;
    expect(after(send.argv, "--max-time")).toEqual(["10"]);
    expect(after(send.argv, "--data-urlencode").sort()).toEqual([`chat_id=${CHAT}`, "text=SNARKS pad alerts are connected."].sort());
    for (const c of calls) {
      expect(c.argv.join(" ")).not.toContain(TOKEN);
      expect(c.cfg).toBe(`url = "https://api.telegram.org/bot${TOKEN}/${/\/(\w+)"/.exec(c.cfg)![1]}"\n`);
    }
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(r.out + r.err).not.toContain(CHAT);
  });

  test("groups and channels are not chats with the owner: the one private chat is still the only one", () => {
    const channel = { update_id: 9, channel_post: { message_id: 1, chat: { id: 777777777, type: "channel" }, date: 1 } };
    const w = setup({ updates: { ok: true, result: [update(-100123456789, "Team", "supergroup"), channel, update(Number(CHAT), "Ada")] } });
    const r = w.go();
    expect(r.code).toBe(0);
    expect(r.out).toContain("chat found: Ada");
    expect(w.saved()).toContain(`TELEGRAM_CHAT_ID=${CHAT}\n`);
  });

  test("nobody has written to the bot yet: it says what to do, saves nothing, sends nothing", () => {
    const w = setup();
    const r = w.go();
    expect(r.code).toBe(1);
    expect(r.err).toContain("send your bot a message first (open it in Telegram, press Start)");
    expect(w.saved()).toBe(ALERTS);
    expect(methods(w.calls())).toEqual(["getUpdates"]);
  });

  test("two private chats (anyone who finds the bot's name can write to it): none is picked, nothing is saved or sent, no id is printed", () => {
    const w = setup({ updates: { ok: true, result: [update(Number(CHAT), "Ada"), update(555555555, "Stranger")] } });
    const r = w.go();
    expect(r.code).toBe(1);
    expect(r.err).toContain("more than one private chat has written to this bot");
    expect(w.saved()).toBe(ALERTS);
    expect(methods(w.calls())).toEqual(["getUpdates"]);
    expect(r.out + r.err).not.toContain(CHAT);
    expect(r.out + r.err).not.toContain("555555555");
    expect(r.out + r.err).not.toContain("Stranger");
  });

  test("a last line without its newline stays whole: the new line starts on its own line", () => {
    const w = setup({ alerts: `ALERT_WEBHOOK_URL=${HOOK}\nTELEGRAM_BOT_TOKEN=${TOKEN}`, updates: { ok: true, result: [update(Number(CHAT), "Ada")] } });
    expect(w.go().code).toBe(0);
    expect(w.saved()).toBe(`ALERT_WEBHOOK_URL=${HOOK}\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=${CHAT}\n`);
  });

  test("a chat id already in the file is used as it is: Telegram is not asked, no second line is written, the test message goes to it", () => {
    const w = setup({ alerts: `${ALERTS}TELEGRAM_CHAT_ID=987654321\n` });
    const r = w.go();
    expect(r.code).toBe(0);
    expect(r.out).toContain("test message answered HTTP 200");
    expect(w.saved()).toBe(`${ALERTS}TELEGRAM_CHAT_ID=987654321\n`);
    expect(methods(w.calls())).toEqual(["sendMessage"]);
    expect(after(w.calls()[0]!.argv, "--data-urlencode")).toContain("chat_id=987654321");
    expect(r.out + r.err).not.toContain("987654321");
  });

  test("a saved chat id of the wrong shape is refused before anything is sent", () => {
    const w = setup({ alerts: `${ALERTS}TELEGRAM_CHAT_ID=not-a-number\n` });
    const r = w.go();
    expect(r.code).toBe(1);
    expect(r.err).toContain("TELEGRAM_CHAT_ID");
    expect(w.calls()).toHaveLength(0);
  });

  test.each([
    ["no alerts file", null],
    ["no token line", "ALERT_WEBHOOK_URL=\n"],
    ["an empty token", "TELEGRAM_BOT_TOKEN=\n"],
    ["a token of the wrong shape", "TELEGRAM_BOT_TOKEN=999999999:wrongshape\n"],
    ["a token with a quote in it", `TELEGRAM_BOT_TOKEN=123456789:AAH"test_TOKEN0123456789abcdefghij\n`],
  ])("%s: it says which line to fix, asks Telegram nothing and prints no token", (_label, alerts) => {
    const w = setup({ alerts });
    const r = w.go();
    expect(r.code).toBe(1);
    expect(r.err).toContain("TELEGRAM_BOT_TOKEN");
    expect(w.calls()).toHaveLength(0);
    expect(r.out + r.err).not.toContain("wrongshape");
    expect(r.out + r.err).not.toContain("test_TOKEN0123456789abcdefghij");
  });

  test("Telegram refuses the token, or cannot be reached: the status alone is printed, the file is unchanged, no token anywhere", () => {
    for (const [env, status] of [
      [{ FAKE_UPDATES_CODE: "401" }, "401"],
      [{ FAKE_UPDATES_CODE: "409" }, "409"],
      [{ FAKE_FAIL: "telegram" }, "000"],
    ] as const) {
      const w = setup({ env });
      const r = w.go();
      expect(r.code).toBe(1);
      expect(r.err).toContain(`getUpdates answered HTTP ${status}`);
      expect(w.saved()).toBe(ALERTS);
      expect(r.out + r.err).not.toContain(TOKEN);
      expect(methods(w.calls())).toEqual(["getUpdates"]);
    }
  });

  test("an answer that is not JSON is said so and changes nothing", () => {
    const w = setup({ updatesBody: "<html>bad gateway</html>" });
    const r = w.go();
    expect(r.code).toBe(1);
    expect(r.err).toContain("not JSON");
    expect(w.saved()).toBe(ALERTS);
  });

  test("the test message is refused (the owner blocked the bot, say): the status is printed, the exit is 1, the chat stays saved", () => {
    const w = setup({ updates: { ok: true, result: [update(Number(CHAT), "Ada")] }, env: { FAKE_SEND_CODE: "403" } });
    const r = w.go();
    expect(r.code).toBe(1);
    expect(r.out).toContain("chat found: Ada");
    expect(r.out).toContain("test message answered HTTP 403");
    expect(w.saved()).toContain(`TELEGRAM_CHAT_ID=${CHAT}\n`);
  });

  test("a first name is printed without control characters (a stranger's name must not drive the owner's terminal) and keeps its letters", () => {
    const hostile = setup({ updates: { ok: true, result: [update(Number(CHAT), "Ada\u001b[31m\u0007\u009b")] } });
    const h = hostile.go();
    expect(h.code).toBe(0);
    expect(h.out.split("\n")[0]).toBe("chat found: Ada[31m");
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(h.out)).toBe(false);
    const accented = setup({ updates: { ok: true, result: [update(Number(CHAT), "Zoë")] } });
    expect(accented.go().out.split("\n")[0]).toBe("chat found: Zoë");
  });
});
