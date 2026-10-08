// The server's clock (S4 stress ST-LW-02, ops/MAINNET-RUNBOOK.md gate G14). The launch window's fee is a function of the chain's clock and of the server's, and the engine
// reads its own clock one second back, so a server clock a second or two fast eats that margin. ops/timesync.sh keeps a time client running and says whether the
// clock is synchronised; ops/healthcheck.sh fails (and posts to the alert webhook) when it is not. Both run here against stand-ins for timedatectl, systemctl, dpkg,
// apt-get and the rest, in a scratch directory first in PATH: no test reaches a server, installs a package or changes a clock.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

interface World {
  /** What `timedatectl show -p NTPSynchronized --value` says: yes, no, or `broken` for a timedatectl that fails. */
  sync?: "yes" | "no" | "broken";
  /** The state flips to yes after this many polls of it (the first synchronisation takes a while). */
  yesAfterPolls?: number;
  chronyActive?: boolean;
  timesyncdInstalled?: boolean;
  uid?: number;
}

/** A scratch bin directory of stand-ins, and the log they write to. */
function world(w: World = {}) {
  const dir = mkdtempSync(join(tmpdir(), "timesync-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "polls"), "0");
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "timedatectl",
    `
state="${w.sync ?? "yes"}"
case "$1" in
  set-ntp) echo "timedatectl set-ntp $2" >> "${log}"; exit 0 ;;
  show)
    [ "$state" = broken ] && exit 1
    n=$(( $(cat "${dir}/polls") + 1 )); echo "$n" > "${dir}/polls"
    if [ -n "${w.yesAfterPolls ?? ""}" ] && [ "$n" -gt "${w.yesAfterPolls ?? 0}" ]; then echo yes; else echo "$state"; fi ;;
  *) [ "$state" = broken ] && exit 1; echo "System clock synchronized: $state"; echo "              NTP service: active" ;;
esac`,
  );
  fake("systemctl", `echo "systemctl $*" >> "${log}"\ncase "$*" in "is-active --quiet chrony") exit ${w.chronyActive ? 0 : 3} ;; "is-active --quiet chronyd") exit 3 ;; *) exit 0 ;; esac`);
  fake("dpkg", `exit ${w.timesyncdInstalled === false ? 1 : 0}`);
  fake("apt-get", `echo "apt-get $*" >> "${log}"`);
  fake("id", `echo ${w.uid ?? 0}`);
  fake("sleep", "exit 0");
  return {
    dir,
    log: () => readFileSync(log, "utf8"),
    run(script: string, env: Record<string, string> = {}) {
      const r = Bun.spawnSync(["bash", "-c", script], { cwd: REPO, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "", ...env } });
      return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
    },
  };
}

describe("ops/timesync.sh --check", () => {
  test("a synchronised clock: prints the state, exit 0, changes nothing", () => {
    const w = world({ sync: "yes" });
    const r = w.run("ops/timesync.sh --check");
    expect(r.code).toBe(0);
    expect(r.out).toContain("System clock synchronized: yes");
    expect(w.log()).toBe("");
  });

  test("an unsynchronised clock, and a timedatectl that gives no answer: exit 1", () => {
    expect(world({ sync: "no" }).run("ops/timesync.sh --check")).toMatchObject({ code: 1 });
    const broken = world({ sync: "broken" }).run("ops/timesync.sh --check");
    expect(broken.code).toBe(1);
    expect(broken.out).toContain("timedatectl gave no answer");
  });

  test("an option it does not know is refused before anything runs", () => {
    const w = world();
    expect(w.run("ops/timesync.sh --everything").code).toBe(2);
    expect(w.log()).toBe("");
  });
});

describe("ops/timesync.sh as root", () => {
  test("with no time client: installs systemd-timesyncd when it is missing, enables it, turns NTP on, waits for the first synchronisation, exit 0 once it is", () => {
    const w = world({ sync: "no", yesAfterPolls: 3, timesyncdInstalled: false });
    const r = w.run("ops/timesync.sh", { TIMESYNC_WAIT_S: "60" });
    expect(r.code).toBe(0);
    expect(w.log()).toContain("apt-get install -y -qq systemd-timesyncd");
    expect(w.log()).toContain("systemctl enable --now systemd-timesyncd");
    expect(w.log()).toContain("timedatectl set-ntp true");
    expect(r.out).toContain("System clock synchronized");
  });

  test("systemd-timesyncd already installed: nothing is installed, and running it again changes nothing that was right", () => {
    const w = world({ sync: "yes", timesyncdInstalled: true });
    const r = w.run("ops/timesync.sh");
    expect(r.code).toBe(0);
    expect(w.log()).not.toContain("apt-get");
  });

  test("chrony running: it is left alone, no second time client is installed or enabled", () => {
    const w = world({ sync: "yes", chronyActive: true });
    const r = w.run("ops/timesync.sh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("chrony keeps the clock");
    expect(w.log()).not.toContain("apt-get");
    expect(w.log()).not.toContain("enable --now");
    expect(w.log()).not.toContain("set-ntp");
  });

  test("a clock that is still not synchronised after the wait: exit 1 and it says the health check will keep saying so", () => {
    const w = world({ sync: "no" });
    const r = w.run("ops/timesync.sh", { TIMESYNC_WAIT_S: "4" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("ops/healthcheck.sh will say so");
  });

  test("not root: exit 2 before anything is changed", () => {
    const w = world({ sync: "no", uid: 1000 });
    const r = w.run("ops/timesync.sh");
    expect(r.code).toBe(2);
    expect(w.log()).toBe("");
  });
});

describe("the provisioning kit carries it", () => {
  test("remote-setup.sh runs it in the host steps and only warns when the first synchronisation is slow; provision.sh lists the step", () => {
    const setup = readFileSync(join(REPO, "ops", "remote-setup.sh"), "utf8");
    expect(setup).toContain('bash "$I_REPO/ops/timesync.sh" || echo "WARNING');
    expect(setup.indexOf("time sync")).toBeGreaterThan(setup.indexOf('step "journald size limit"'));
    expect(setup.indexOf("time sync")).toBeLessThan(setup.indexOf('step "bun $BUN_VERSION'));
    expect(readFileSync(join(REPO, "ops", "provision.sh"), "utf8")).toContain("journald, time sync, bun");
    expect(Bun.spawnSync(["bash", "-n", join(REPO, "ops", "timesync.sh")]).exitCode).toBe(0);
  });

  test("the runbook has the gate", () => {
    const runbook = readFileSync(join(REPO, "ops", "MAINNET-RUNBOOK.md"), "utf8");
    expect(runbook).toMatch(/\| G14 \| The server clock is synchronised and the mainnet clock margin was measured in the dry run/);
    expect(runbook).toContain("window-clock-tx.ts");
  });
});

describe("ops/healthcheck.sh and the clock", () => {
  /** The health check with everything else healthy, so the clock is the only thing that can fail it. */
  function health(w: World) {
    const x = world(w);
    const bin = join(x.dir, "bin");
    const fake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    fake("curl", `echo '{"paused":false,"epochsNeedingAttention":0}'`);
    fake("stat", `date +%s`); // the keeper's health log was just written
    fake("df", `printf 'Use%%\\n 12%%\\n'`);
    const keeperLog = join(x.dir, "keeper-health.log");
    writeFileSync(keeperLog, "{}\n");
    return { ...x, check: () => x.run("ops/healthcheck.sh", { PAD_KEEPER_HEALTH_LOG: keeperLog, HEALTH_API: "http://127.0.0.1:1/api" }) };
  }

  test("a synchronised clock: the check is ok", () => {
    const r = health({ sync: "yes" }).check();
    expect([r.code, r.out.trim()]).toEqual([0, "snarks health: ok"]);
  });

  test("an unsynchronised clock fails the check and names it", () => {
    const r = health({ sync: "no" }).check();
    expect(r.code).toBe(1);
    expect(r.err).toContain("Test site: server clock is NOT synchronised");
    expect(r.err).toContain("sudo ops/timesync.sh");
  });

  test("a timedatectl that gives no answer fails it too: not knowing is not ok", () => {
    const r = health({ sync: "broken" }).check();
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot tell whether the server clock is synchronised");
  });
});
