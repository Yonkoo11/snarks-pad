// One server, two instances (ops/DEPLOY.md "Two instances on one box"): the devnet demo `snarks` and the staged mainnet
// instance `snarksm`. These tests read the ops kit, render its templates and run its scripts against fakes. They touch no
// server and no chain. What they pin: the two instances share no path except the pinned binaries, the mainnet settings
// are ones the engine accepts (and the ones it refuses are absent), the Caddy switch has one place to look, and the
// secrets script never lets a value reach a terminal or a command line.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENGINE = resolve(import.meta.dir, "..");
const REPO = resolve(ENGINE, "..");
const OPS = join(REPO, "ops");
const TEMPLATES = join(OPS, "templates");

const UNIT_TEMPLATES = ["api.service", "keeper.service", "backup.service", "backup.timer", "health.service", "health.timer", "logrotate"];
const MAINNET_TEMPLATES = [...UNIT_TEMPLATES, "engine.env.mainnet.example", "secrets.env.mainnet.example"];

function sh(script: string, env: Record<string, string> = {}, stdin?: string) {
  const r = Bun.spawnSync(["bash", "-c", script], { cwd: REPO, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin) });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

function render(instance: string, template: string): string {
  const r = sh(`. ops/instance.sh && instance_load ${instance} && instance_render ops/templates/${template}`);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return r.out;
}

/** KEY=VALUE lines of a rendered env template (comments and blanks dropped). */
function envOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

describe("instance table", () => {
  test("derives distinct users, paths, ports and unit names", () => {
    const get = (i: string) => sh(`. ops/instance.sh && instance_load ${i} && echo "$I_USER $I_ETC $I_KEYS $I_DATA $I_BACKUPS $I_REPO $I_WEB $I_PORT $I_MODE $I_BIN"`).out.trim().split(" ");
    expect(get("snarks")).toEqual(["snarks", "/etc/snarks", "/etc/snarks/keys", "/var/lib/snarks", "/var/backups/snarks", "/opt/snarks/repo", "/opt/snarks/web", "8787", "devnet", "/opt/snarks/bin"]);
    expect(get("snarksm")).toEqual(["snarksm", "/etc/snarksm", "/etc/snarksm/keys", "/var/lib/snarksm", "/var/backups/snarksm", "/opt/snarksm/repo", "/opt/snarksm/web", "8789", "mainnet", "/opt/snarks/bin"]);
  });

  test("refuses an unknown name and a mode that does not belong to the instance", () => {
    expect(sh(". ops/instance.sh && instance_load ../etc").code).toBe(2);
    expect(sh(". ops/instance.sh && instance_load snarks mainnet").code).toBe(2);
    expect(sh(". ops/instance.sh && instance_load snarksm devnet").code).toBe(2);
    expect(sh(". ops/instance.sh && instance_load snarksm mainnet").code).toBe(0);
  });

  test("ops/switch-live.sh carries the same port, mode and web folder as the table", () => {
    const script = readFileSync(join(OPS, "switch-live.sh"), "utf8");
    for (const inst of ["snarks", "snarksm"]) {
      const m = new RegExp(`^\\s*${inst}\\) PORT=(\\d+); MODE=(\\w+); WEB=(\\S+) ;;`, "m").exec(script);
      expect(m).not.toBeNull();
      const t = sh(`. ops/instance.sh && instance_load ${inst} && echo "$I_PORT $I_MODE $I_WEB"`).out.trim();
      expect(`${m![1]} ${m![2]} ${m![3]}`).toBe(t);
    }
  });
});

describe("the devnet instance is rendered as it has always run", () => {
  test("its units name its own user, paths and keys", () => {
    const api = render("snarks", "api.service");
    expect(api).toContain("User=snarks\n");
    expect(api).toContain("EnvironmentFile=/etc/snarks/engine.env\n");
    expect(api).toContain("InaccessiblePaths=/etc/snarks/keys\n");
    expect(api).toContain("ReadWritePaths=/var/lib/snarks\n");
    expect(api).toContain("ExecStart=/opt/snarks/bin/bun scripts/api.ts\n");
    expect(render("snarks", "keeper.service")).toContain("ReadWritePaths=/var/lib/snarks /etc/snarks/keys\n");
    expect(render("snarks", "logrotate")).toContain("create 0660 snarks snarks\n");
  });
});

describe("the mainnet instance shares nothing with the devnet one but the pinned binaries", () => {
  test.each(MAINNET_TEMPLATES)("%s has no snarks path, user or unit name left", (template) => {
    const text = render("snarksm", template).replaceAll("/opt/snarks/bin/", "<shared-bin>/");
    expect(text).not.toMatch(/__[A-Z]+__/);
    expect(text).not.toMatch(/\bsnarks\b/);
  });

  test("the API unit cannot see its own keys; only the keeper may write them", () => {
    const api = render("snarksm", "api.service");
    expect(api).toContain("InaccessiblePaths=/etc/snarksm/keys\n");
    expect(api).toContain("ReadWritePaths=/var/lib/snarksm\n");
    expect(api).not.toContain("/etc/snarksm/keys\nReadWritePaths");
    expect(render("snarksm", "keeper.service")).toContain("ReadWritePaths=/var/lib/snarksm /etc/snarksm/keys\n");
    expect(render("snarksm", "backup.service")).toContain("ExecStart=/opt/snarksm/repo/ops/backup.sh\n");
    expect(render("snarksm", "health.service")).toContain("ExecStart=/opt/snarksm/repo/ops/healthcheck.sh\n");
  });
});

describe("the mainnet settings", () => {
  const rendered = render("snarksm", "engine.env.mainnet.example");
  const settings = envOf(rendered);

  test("are staged: mainnet, its own port, paused twice, nothing that decides money filled in", () => {
    expect(settings.PAD_MODE).toBe("mainnet");
    expect(settings.PAD_INSTANCE).toBe("snarksm");
    expect(settings.PAD_API_PORT).toBe("8789");
    expect(settings.PAYOUTS_PAUSED).toBe("1");
    expect(settings.PAD_PAUSE_FILE).toBe("/var/lib/snarksm/data/PAUSED");
    expect(settings.SQUADS_MULTISIG).toBe("");
    expect(settings.FEE_CLAIMER_PUBKEY).toBe("");
    expect(settings.DBC_CONFIG_ID).toBe("");
    expect(settings.PAD_SWAP_MAX_ZATS).toBe("10000000");
    expect(settings.KEEPER_KEYPAIR_PATH).toBe("/etc/snarksm/keys/keeper-mainnet.json");
    expect(settings.TREASURY_WALLET_DIR).toBe("/var/lib/snarksm/zcash/treasury-main");
    expect(settings.TREASURY_IDENTITY_FILE).toBe("/etc/snarksm/keys/treasury.identity.age");
  });

  test("never set the three values the engine refuses on mainnet, and carry no secret", () => {
    for (const name of ["DBC_FEE_BPS", "DBC_INITIAL_MCAP_ZEC", "DBC_MIGRATION_MCAP_ZEC"]) expect(Object.keys(settings)).not.toContain(name);
    expect(rendered).not.toMatch(/api-key=|AGE-SECRET-KEY|PRIVATE KEY|https:\/\/[^ ]*helius/i);
    expect(Object.keys(envOf(render("snarksm", "secrets.env.mainnet.example"))).sort()).toEqual(["ALERT_WEBHOOK_URL", "HELIUS_API_KEY", "SOLANA_MAINNET_RPC", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
    expect(Object.values(envOf(render("snarksm", "secrets.env.mainnet.example"))).every((v) => v === "")).toBe(true);
  });

  const loadConfig = (extra: Record<string, string> = {}) => {
    const code = `import { config } from ${JSON.stringify(join(ENGINE, "src", "config"))}; console.log(JSON.stringify({ mode: config.mode, rpc: config.solana.rpc, team: config.epoch.team.wallet, swapMax: String(config.near1click.maxSwapZats), port: config.api.port }));`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { cwd: ENGINE, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...settings, ...extra } });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
  };

  test("load in the engine's own config: mainnet, the team wallet parsed, the swap cap read", () => {
    const r = loadConfig();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const c = JSON.parse(r.out) as { mode: string; team: string; swapMax: string; port: number };
    expect(c.mode).toBe("mainnet");
    expect(c.team).toBe("9KzyvgydD7mJACY1QKALd6gdapnJ2WmMzCQMFrETsssj");
    expect(c.swapMax).toBe("10000000");
    expect(c.port).toBe(8789);
  });

  test("the engine refuses the same settings once a permanent-config override is added (so their absence is deliberate)", () => {
    const r = loadConfig({ DBC_FEE_BPS: "50" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("DBC_FEE_BPS");
  });
});

describe("Caddy: one sites file, two pre-rendered variants", () => {
  const sites = mkdtempSync(join(tmpdir(), "sites-"));
  const file = join(sites, "snarks-sites.env");
  writeFileSync(file, 'LIVE_HOSTS="snarks.fun"\nTEST_HOSTS="test.snarks.fun 38-49-215-61.sslip.io"\nLIVE_INSTANCE=snarks\n');
  const variant = (inst: string) => {
    const r = sh(`ops/caddy-render.sh --print ${inst}`, { SITES_FILE: file });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    return r.out;
  };
  const blocks = (text: string) => [...text.matchAll(/^([^#\s][^{\n]*) \{$/gm)].map((m) => m[1]!);

  test("live=snarks: every name, the live one included, serves the devnet instance from one block", () => {
    const v = variant("snarks");
    expect(blocks(v)).toEqual(["snarks.fun, test.snarks.fun, 38-49-215-61.sslip.io", "www.snarks.fun"]);
    expect(v.match(/reverse_proxy 127\.0\.0\.1:(\d+)/g)).toEqual(["reverse_proxy 127.0.0.1:8787"]);
    expect(v).toContain("root * /opt/snarks/web");
    expect(v).not.toContain("snarksm");
  });

  test("live=snarksm: the live name serves mainnet, the test names stay on devnet, only the live name gets a www redirect", () => {
    const v = variant("snarksm");
    expect(blocks(v)).toEqual(["snarks.fun", "test.snarks.fun, 38-49-215-61.sslip.io", "www.snarks.fun"]);
    expect(v.match(/reverse_proxy 127\.0\.0\.1:(\d+)/g)).toEqual(["reverse_proxy 127.0.0.1:8789", "reverse_proxy 127.0.0.1:8787"]);
    expect(v.match(/root \* (\S+)/g)).toEqual(["root * /opt/snarksm/web", "root * /opt/snarks/web"]);
    expect(v).toContain("/var/log/caddy/snarksm-access.log");
    expect(v).toContain("/var/log/caddy/snarks-access.log");
    expect(v).toContain("redir https://snarks.fun{uri} permanent");
  });

  test("keeps the security headers on every block and refuses a name that is not a plain hostname", () => {
    const v = variant("snarksm");
    expect(v.match(/X-Frame-Options "DENY"/g)).toHaveLength(2);
    expect(v.match(/Strict-Transport-Security/g)).toHaveLength(2);
    const bad = join(sites, "bad.env");
    writeFileSync(bad, 'LIVE_HOSTS="snarks.fun {\\n respond 200"\nTEST_HOSTS=""\nLIVE_INSTANCE=snarks\n');
    expect(sh("ops/caddy-render.sh --print snarks", { SITES_FILE: bad }).code).not.toBe(0);
  });

  /** A stand-in ssh first in PATH: records its arguments and stdin and runs nothing, so no test can reach a real server. */
  function withFakeSsh() {
    const dir = mkdtempSync(join(tmpdir(), "fakessh-"));
    Bun.spawnSync(["mkdir", join(dir, "bin")]);
    writeFileSync(join(dir, "bin", "ssh"), `#!/bin/bash\necho "$@" > "${dir}/args"; [ -t 0 ] || cat > "${dir}/stdin"; true\n`);
    chmodSync(join(dir, "bin", "ssh"), 0o755);
    return { env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, SNARKS_HOST: "deploy@192.0.2.1" }, dir };
  }

  test("the switch script refuses without a target and, on a bad word, never reaches ssh", () => {
    const fake = withFakeSsh();
    expect(sh("ops/switch-live.sh", fake.env).code).toBe(2);
    expect(sh("ops/switch-live.sh 'snarksm; echo pwned'", fake.env).code).toBe(2);
    expect(sh("ops/switch-live.sh nonsense", fake.env).code).toBe(2);
    expect(sh("ops/switch-live.sh snarksm --force", fake.env).code).toBe(2);
    expect(existsSync(join(fake.dir, "args"))).toBe(false);
  });

  test("from the Mac it sends itself to the server's sudo bash over ssh, with its arguments and nothing else", () => {
    const fake = withFakeSsh();
    expect(sh("ops/switch-live.sh snarksm --check", fake.env).code).toBe(0);
    const args = readFileSync(join(fake.dir, "args"), "utf8");
    expect(args).toContain("deploy@192.0.2.1");
    expect(args).toContain("sudo bash -s -- snarksm --check");
    expect(readFileSync(join(fake.dir, "stdin"), "utf8")).toBe(readFileSync(join(OPS, "switch-live.sh"), "utf8"));
  });
});

describe("ops/switch-live.sh on the server (a scratch directory stands in for /, fake curl, caddy and systemctl)", () => {
  type Scenario = { live?: "snarks" | "snarksm"; webIndex?: boolean; env?: Record<string, string> };

  function server({ live = "snarks", webIndex = true, env = {} }: Scenario = {}) {
    const root = mkdtempSync(join(tmpdir(), "srv-"));
    const caddy = join(root, "etc", "caddy");
    Bun.spawnSync(["mkdir", "-p", caddy, join(root, "opt", "snarksm", "web"), join(root, "opt", "snarks", "web"), join(root, "bin")]);
    writeFileSync(join(root, "opt", "snarks", "web", "index.html"), "<!doctype html>"); // the devnet site is always there
    if (webIndex) writeFileSync(join(root, "opt", "snarksm", "web", "index.html"), "<!doctype html>");
    writeFileSync(join(caddy, "snarks-sites.env"), `LIVE_HOSTS="snarks.fun"\nTEST_HOSTS="test.snarks.fun"\nLIVE_INSTANCE=${live}\n`);
    expect(sh("ops/caddy-render.sh --no-validate", { CADDY_DIR: caddy }).code).toBe(0);
    // stand-ins: the API answers with a mode; the public name answers with the mode of whichever Caddyfile is active
    writeFileSync(join(root, "bin", "curl"), `#!/bin/bash\nfor a in "$@"; do url="$a"; done\ncase "$url" in\n  http://127.0.0.1:8789/*) m="\${FAKE_MAINNET_API:-mainnet}" ;;\n  http://127.0.0.1:8787/*) m=devnet ;;\n  https://*) if [ -n "\${FAKE_HTTPS_MODE:-}" ]; then m="$FAKE_HTTPS_MODE"; elif grep -q '^snarks.fun {' "${caddy}/Caddyfile"; then m=mainnet; else m=devnet; fi ;;\nesac\n[ "$m" = down ] && exit 7\nprintf 'HTTP/2 200\\r\\nx-pad-mode: %s\\r\\n\\r\\n' "$m"\n`);
    writeFileSync(join(root, "bin", "caddy"), `#!/bin/bash\n[ "\${FAKE_CADDY_VALIDATE:-ok}" = ok ]\n`);
    writeFileSync(join(root, "bin", "systemctl"), `#!/bin/bash\necho "$*" >> "${root}/systemctl.log"\nif [ "$1 $2" = "reload caddy" ] && [ -n "\${FAKE_RELOAD_FAILS_FIRST:-}" ] && [ "$(grep -c '^reload caddy' "${root}/systemctl.log")" = 1 ]; then exit 1; fi\nexit 0\n`);
    for (const f of ["curl", "caddy", "systemctl"]) chmodSync(join(root, "bin", f), 0o755);
    const run = (...args: string[]) => sh(`ops/switch-live.sh ${args.join(" ")}`, { ROOT_PREFIX: root, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ...env });
    const read = (rel: string) => readFileSync(join(caddy, rel), "utf8");
    const reloads = () => (existsSync(join(root, "systemctl.log")) ? readFileSync(join(root, "systemctl.log"), "utf8").split("\n").filter((l) => l === "reload caddy").length : 0);
    return { run, read, reloads, caddy };
  }

  test("--check changes nothing, however many checks pass", () => {
    const srv = server();
    const before = srv.read("Caddyfile");
    const r = srv.run("snarksm", "--check");
    expect(r.code).toBe(0);
    expect(r.out).toContain("CHECK ONLY");
    expect(srv.read("Caddyfile")).toBe(before);
    expect(srv.reloads()).toBe(0);
  });

  test("a switch to mainnet installs the pre-rendered variant, reloads once, checks the public name and records the choice", () => {
    const srv = server();
    const r = srv.run("snarksm");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("DONE");
    expect(srv.read("Caddyfile")).toBe(srv.read("Caddyfile.live-snarksm"));
    expect(srv.read("snarks-sites.env")).toContain("LIVE_INSTANCE=snarksm");
    expect(srv.read("snarks-sites.env")).toContain('TEST_HOSTS="test.snarks.fun"');
    expect(srv.reloads()).toBe(1);
    expect(readdirSync(srv.caddy).some((f) => f.startsWith("Caddyfile.bak-switch-"))).toBe(true);
  });

  test("and the way back works from the switched state", () => {
    const srv = server({ live: "snarksm" });
    expect(srv.read("Caddyfile")).toBe(srv.read("Caddyfile.live-snarksm"));
    const r = srv.run("snarks");
    expect(r.code).toBe(0);
    expect(srv.read("Caddyfile")).toBe(srv.read("Caddyfile.live-snarks"));
    expect(srv.read("snarks-sites.env")).toContain("LIVE_INSTANCE=snarks");
  });

  test("when the public name does not answer in the new mode it puts the old Caddyfile back and says so", () => {
    const srv = server({ env: { FAKE_HTTPS_MODE: "devnet" } });
    const before = srv.read("Caddyfile");
    const r = srv.run("snarksm");
    expect(r.code).toBe(1);
    expect(r.err).toContain("ROLLING BACK");
    expect(srv.read("Caddyfile")).toBe(before);
    expect(srv.read("snarks-sites.env")).toContain("LIVE_INSTANCE=snarks");
    expect(srv.reloads()).toBe(2);
  });

  test("when Caddy will not reload the new file it puts the old one back", () => {
    const srv = server({ env: { FAKE_RELOAD_FAILS_FIRST: "1" } });
    const before = srv.read("Caddyfile");
    const r = srv.run("snarksm");
    expect(r.code).toBe(1);
    expect(r.err).toContain("caddy would not reload");
    expect(srv.read("Caddyfile")).toBe(before);
    expect(srv.read("snarks-sites.env")).toContain("LIVE_INSTANCE=snarks");
  });

  test.each([
    ["the mainnet API is stopped", { env: { FAKE_MAINNET_API: "down" } }, "does not answer 200 with mode mainnet"],
    ["the mainnet API answers in devnet mode", { env: { FAKE_MAINNET_API: "devnet" } }, "does not answer 200 with mode mainnet"],
    ["no mainnet site is built", { webIndex: false }, "no built site"],
    ["the variant does not validate", { env: { FAKE_CADDY_VALIDATE: "bad" } }, "does not validate"],
  ])("refuses, touching nothing, when %s", (_label, scenario, message) => {
    const srv = server(scenario as Scenario);
    const before = srv.read("Caddyfile");
    const r = srv.run("snarksm");
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(srv.read("Caddyfile")).toBe(before);
    expect(srv.reloads()).toBe(0);
  });

  test("a target that is already live is a no-op", () => {
    const srv = server({ live: "snarksm" });
    const r = srv.run("snarksm");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already live");
    expect(srv.reloads()).toBe(0);
  });
});

const haveBackupTools = ["age", "age-keygen", "sqlite3"].every((t) => Bun.spawnSync(["which", t]).exitCode === 0);

describe.skipIf(!haveBackupTools)("ops/backup.sh is per instance", () => {
  function backup(instance: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "bak-"));
    const mk = (cmd: string) => expect(sh(cmd).code).toBe(0);
    mk(`mkdir -p ${dir}/data/data ${dir}/data/zcash/w ${dir}/keys ${dir}/out`);
    mk(`sqlite3 ${dir}/data/data/x.sqlite 'create table t(a); insert into t values (1);'`);
    mk(`sqlite3 ${dir}/data/zcash/w/data.sqlite 'create table t(a);'; echo seed > ${dir}/data/zcash/w/keys.toml; echo key > ${dir}/keys/k.json`);
    mk(`age-keygen -o ${dir}/id.txt 2>/dev/null`);
    const pub = sh(`age-keygen -y ${dir}/id.txt`).out.trim();
    const env: Record<string, string> = { SNARKS_DATA: `${dir}/data`, SNARKS_KEYS: `${dir}/keys`, SNARKS_BACKUPS: `${dir}/out`, BACKUP_AGE_RECIPIENT: pub };
    if (instance) env.PAD_INSTANCE = instance;
    const r = sh("ops/backup.sh", env);
    const archives = readdirSync(`${dir}/out`);
    const listing = archives.length ? sh(`age -d -i ${dir}/id.txt ${dir}/out/${archives[0]} | tar -tzf -`).out : "";
    return { ...r, archives, listing };
  }

  test("the mainnet instance's archive carries its own name and holds the databases, the wallet and the keys", () => {
    const r = backup("snarksm");
    expect(r.code).toBe(0);
    expect(r.archives).toHaveLength(1);
    expect(r.archives[0]).toMatch(/^snarksm-\d{8}T\d{6}Z\.tar\.gz\.age$/);
    for (const entry of ["./db/x.sqlite", "./zcash/w/data.sqlite", "./zcash/w/keys.toml", "./keys/k.json"]) expect(r.listing).toContain(entry);
  });

  test("with no instance named it is the devnet instance's archive, as it always was, and the two prefixes never overlap", () => {
    const r = backup(null);
    expect(r.code).toBe(0);
    expect(r.archives[0]).toMatch(/^snarks-\d{8}T\d{6}Z\.tar\.gz\.age$/);
    expect("snarksm-20261005T003117Z.tar.gz.age").not.toMatch(/^snarks-.*\.tar\.gz\.age$/);
  });

  test("refuses without a recipient: a plaintext archive of keys is worse than none", () => {
    const r = sh("ops/backup.sh", { PAD_INSTANCE: "snarksm", SNARKS_BACKUPS: mkdtempSync(join(tmpdir(), "bak-")) });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("/etc/snarksm/engine.env");
  });
});

describe("ops/svc-run.sh picks the instance of the tree it lives in, and says so", () => {
  function run(opsDir: string, ...args: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "svcrun-"));
    Bun.spawnSync(["mkdir", join(dir, "bin")]);
    writeFileSync(join(dir, "bin", "systemd-run"), `#!/bin/bash\necho "$@" > "${dir}/args"\n`);
    chmodSync(join(dir, "bin", "systemd-run"), 0o755);
    const r = sh(`${opsDir}/svc-run.sh ${args.join(" ")}`, { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` });
    return { ...r, args: existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8") : "" };
  }
  const mainnetTree = () => {
    const root = mkdtempSync(join(tmpdir(), "tree-"));
    const ops = join(root, "opt", "snarksm", "repo", "ops");
    Bun.spawnSync(["mkdir", "-p", ops]);
    Bun.spawnSync(["cp", "-R", `${OPS}/.`, ops]);
    return ops;
  };

  test("the tree of the mainnet instance runs as the mainnet instance", () => {
    const r = run(mainnetTree(), "bun", "scripts/epoch.ts");
    expect(r.code).toBe(0);
    expect(r.err).toContain("instance snarksm (mainnet), as user snarksm");
    expect(r.args).toContain("User=snarksm");
    expect(r.args).toContain("EnvironmentFile=/etc/snarksm/engine.env");
    expect(r.args).toContain("EnvironmentFile=-/etc/snarksm/secrets.env");
    expect(r.args).toContain("WorkingDirectory=/opt/snarksm/repo/engine");
    expect(r.args).toContain("ReadWritePaths=/etc/snarksm/keys");
    expect(r.args).toContain("/opt/snarks/bin/bun scripts/epoch.ts");
    expect(r.args).not.toMatch(/\/(etc|var\/lib)\/snarks\//);
  });

  test("any other tree is the devnet instance, and --instance overrides either way", () => {
    const devnet = run(OPS, "bun", "scripts/epoch.ts");
    expect(devnet.err).toContain("instance snarks (devnet), as user snarks");
    expect(devnet.args).toContain("WorkingDirectory=/opt/snarks/repo/engine");
    const forced = run(OPS, "--instance", "snarksm", "bun", "scripts/epoch.ts");
    expect(forced.err).toContain("instance snarksm (mainnet)");
    expect(forced.args).toContain("User=snarksm");
    const back = run(mainnetTree(), "--instance", "snarks", "bun", "scripts/epoch.ts");
    expect(back.args).toContain("User=snarks ");
    expect(run(OPS, "--instance", "nope", "bun", "x.ts").code).toBe(2);
  });
});

describe("ops/push-secrets.sh", () => {
  const KEY = "k3yVALUE0123456789abcdef";
  const HOOK = "https://hooks.example.test/api/webhooks/123/secrettoken";

  // RPC_URL_FILE is always set, to a file that exists only when the test gives one: the script must never fall back to the real file under $HOME.
  function run(instance: string, rpc: string | null, alerts: string | null, quicknode: string | null = null) {
    const dir = mkdtempSync(join(tmpdir(), "push-"));
    const fakeBin = join(dir, "bin");
    Bun.spawnSync(["mkdir", fakeBin]);
    // a stand-in ssh: records its arguments and what arrives on stdin, runs nothing
    writeFileSync(join(fakeBin, "ssh"), `#!/bin/bash\nn=$(ls "${dir}" | grep -c '^call-'); echo "$@" > "${dir}/call-$n.args"; [ -t 0 ] || cat > "${dir}/call-$n.stdin"; true\n`);
    chmodSync(join(fakeBin, "ssh"), 0o755);
    if (rpc !== null) writeFileSync(join(dir, "rpc.env"), rpc);
    if (alerts !== null) writeFileSync(join(dir, "alerts.env"), alerts);
    if (quicknode !== null) writeFileSync(join(dir, "rpc-quicknode.env"), quicknode);
    const r = sh(`ops/push-secrets.sh ${instance}`, { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, PAD_ENV_FILE: join(dir, "rpc.env"), ALERTS_ENV_FILE: join(dir, "alerts.env"), RPC_URL_FILE: join(dir, "rpc-quicknode.env"), SNARKS_HOST: "deploy@192.0.2.1" });
    const files = readdirSync(dir).filter((f) => f.startsWith("call-"));
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    return { ...r, calls: files.map((f) => ({ name: f, text: read(f) })), all: files.map(read).join("\n") };
  }

  test("sends the mainnet file over stdin only, and prints no value", () => {
    const r = run("snarksm", `HELIUS_API_KEY=${KEY}\n`, `ALERT_WEBHOOK_URL=${HOOK}\n`);
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain(KEY);
    expect(r.out + r.err).not.toContain("secrettoken");
    const stdin = r.calls.find((c) => c.name.endsWith(".stdin"))!.text;
    expect(stdin).toContain(`SOLANA_MAINNET_RPC=https://mainnet.helius-rpc.com/?api-key=${KEY}\n`);
    expect(stdin).toContain(`HELIUS_API_KEY=${KEY}\n`);
    expect(stdin).toContain(`ALERT_WEBHOOK_URL=${HOOK}\n`);
    for (const c of r.calls.filter((c) => c.name.endsWith(".args"))) {
      expect(c.text).not.toContain(KEY);
      expect(c.text).not.toContain("secrettoken");
    }
    expect(r.calls.find((c) => c.name.endsWith(".args"))!.text).toContain("/etc/snarksm/secrets.env");
  });

  test("an empty alerts file leaves the webhook empty; the devnet file has no mainnet RPC line", () => {
    const empty = run("snarksm", `export HELIUS_API_KEY="${KEY}"\n`, "");
    expect(empty.code).toBe(0);
    expect(empty.calls.find((c) => c.name.endsWith(".stdin"))!.text).toContain("ALERT_WEBHOOK_URL=\n");
    const devnet = run("snarks", `HELIUS_API_KEY=${KEY}\n`, null);
    expect(devnet.calls.find((c) => c.name.endsWith(".stdin"))!.text).not.toContain("SOLANA_MAINNET_RPC");
  });

  test.each([
    ["a key with a space or newline-injection", "HELIUS_API_KEY=abc def; rm -rf /\n", ""],
    ["no key line", "OTHER=1\n", ""],
    ["a webhook that is not https", `HELIUS_API_KEY=${KEY}\n`, "ALERT_WEBHOOK_URL=http://hooks.example.test/x\n"],
    ["a webhook with a quote in it", `HELIUS_API_KEY=${KEY}\n`, `ALERT_WEBHOOK_URL=https://hooks.example.test/x"y\n`],
  ])("refuses %s and contacts no server", (_label, rpc, alerts) => {
    const r = run("snarksm", rpc, alerts);
    expect(r.code).not.toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(r.out + r.err).not.toContain(KEY);
  });

  test("refuses an unknown instance", () => {
    expect(run("../x", `HELIUS_API_KEY=${KEY}\n`, "").code).toBe(2);
  });

  describe("the devnet instance's full RPC URL (the owner's QuickNode file)", () => {
    const TOKEN = "q9nodeTOKEN0123456789abcdef0123456789ab";
    const QUICKNODE = `https://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}/`;
    const stdinOf = (r: ReturnType<typeof run>) => r.calls.find((c) => c.name.endsWith(".stdin"))!.text;

    test("is written as SOLANA_DEVNET_RPC over stdin only, next to the unchanged key and webhook lines, and no value is printed", () => {
      const r = run("snarks", `HELIUS_API_KEY=${KEY}\n`, `ALERT_WEBHOOK_URL=${HOOK}\n`, `QUICKNODE_DEVNET_URL=${QUICKNODE}\n`);
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain(TOKEN);
      expect(stdinOf(r)).toContain(`SOLANA_DEVNET_RPC=${QUICKNODE}\n`);
      expect(stdinOf(r)).toContain(`HELIUS_API_KEY=${KEY}\n`);
      expect(stdinOf(r)).toContain(`ALERT_WEBHOOK_URL=${HOOK}\n`);
      expect(stdinOf(r)).not.toContain("SOLANA_MAINNET_RPC");
      for (const c of r.calls.filter((c) => c.name.endsWith(".args"))) expect(c.text).not.toContain(TOKEN);
      expect(r.calls.find((c) => c.name.endsWith(".args"))!.text).toContain("/etc/snarks/secrets.env");
    });

    test("a quoted value and an `export` line are read like the other files' lines", () => {
      const r = run("snarks", `HELIUS_API_KEY=${KEY}\n`, "", `export QUICKNODE_DEVNET_URL="${QUICKNODE}"\n`);
      expect(r.code).toBe(0);
      expect(stdinOf(r)).toContain(`SOLANA_DEVNET_RPC=${QUICKNODE}\n`);
    });

    test("no file, no line, or an empty value writes no SOLANA_DEVNET_RPC line at all (an empty one would override engine.env)", () => {
      for (const quicknode of [null, "OTHER=1\n", "QUICKNODE_DEVNET_URL=\n"]) {
        const r = run("snarks", `HELIUS_API_KEY=${KEY}\n`, "", quicknode);
        expect(r.code).toBe(0);
        expect(stdinOf(r)).not.toContain("SOLANA_DEVNET_RPC");
        expect(stdinOf(r)).toContain(`HELIUS_API_KEY=${KEY}\n`);
      }
    });

    test("the mainnet instance never reads it", () => {
      const r = run("snarksm", `HELIUS_API_KEY=${KEY}\n`, "", `QUICKNODE_DEVNET_URL=${QUICKNODE}\n`);
      expect(r.code).toBe(0);
      expect(stdinOf(r)).not.toContain("SOLANA_DEVNET_RPC");
      expect(r.all).not.toContain(TOKEN);
    });

    test("with it the Helius key may be missing (its line is written empty); with neither, the push is refused", () => {
      const only = run("snarks", "", "", `QUICKNODE_DEVNET_URL=${QUICKNODE}\n`);
      expect(only.code).toBe(0);
      expect(stdinOf(only)).toContain(`SOLANA_DEVNET_RPC=${QUICKNODE}\n`);
      expect(stdinOf(only)).toContain("HELIUS_API_KEY=\n");
      const none = run("snarks", "OTHER=1\n", "", "OTHER=2\n");
      expect(none.code).not.toBe(0);
      expect(none.calls).toHaveLength(0);
      expect(none.err).toContain("no QUICKNODE_DEVNET_URL line");
    });

    test.each([
      ["an http address", `http://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}/`],
      ["a space in it", `https://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN} x/`],
      ["a quote in it", `https://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}"/`],
      ["a dollar sign in it", `https://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}$HOME/`],
      ["a backslash in it", `https://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}\\x/`],
      ["a hash in it", `https://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}#x`],
      ["a login in front of the host", `https://user:pw@wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}/`],
      ["more than 512 characters", `https://wild-name-1234.solana-devnet.quiknode.pro/${TOKEN}${"a".repeat(520)}`],
    ])("refuses a URL with %s, contacts no server and prints no token", (_label, url) => {
      const r = run("snarks", `HELIUS_API_KEY=${KEY}\n`, "", `QUICKNODE_DEVNET_URL=${url}\n`);
      expect(r.code).not.toBe(0);
      expect(r.calls).toHaveLength(0);
      expect(r.out + r.err).not.toContain(TOKEN);
      expect(r.err).toContain("not a plain https URL");
    });
  });

  describe("the Telegram pair (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) in the owner's alerts file", () => {
    const TG_TOKEN = "123456789:AAH-test_TOKEN0123456789abcdefghijk";
    const TG_CHAT = "424242424";
    const stdinOf = (r: ReturnType<typeof run>) => r.calls.find((c) => c.name.endsWith(".stdin"))!.text;

    test.each(["snarksm", "snarks"])("is written for %s over stdin only, next to the webhook line, and no value is printed or put on a command line", (instance) => {
      const r = run(instance, `HELIUS_API_KEY=${KEY}\n`, `ALERT_WEBHOOK_URL=${HOOK}\nTELEGRAM_BOT_TOKEN=${TG_TOKEN}\nTELEGRAM_CHAT_ID=${TG_CHAT}\n`);
      expect(r.code).toBe(0);
      expect(stdinOf(r)).toContain(`ALERT_WEBHOOK_URL=${HOOK}\nTELEGRAM_BOT_TOKEN=${TG_TOKEN}\nTELEGRAM_CHAT_ID=${TG_CHAT}\n`);
      expect(r.out + r.err).not.toContain(TG_TOKEN);
      expect(r.out + r.err).not.toContain(TG_CHAT);
      for (const c of r.calls.filter((c) => c.name.endsWith(".args"))) {
        expect(c.text).not.toContain(TG_TOKEN);
        expect(c.text).not.toContain(TG_CHAT);
      }
    });

    test("quotes and an `export` line are read like the other files' lines; a group's number starts with -", () => {
      const r = run("snarksm", `HELIUS_API_KEY=${KEY}\n`, `export TELEGRAM_BOT_TOKEN="${TG_TOKEN}"\nTELEGRAM_CHAT_ID='-1001234567890'\n`);
      expect(r.code).toBe(0);
      expect(stdinOf(r)).toContain(`TELEGRAM_BOT_TOKEN=${TG_TOKEN}\nTELEGRAM_CHAT_ID=-1001234567890\n`);
    });

    test("none in the file: both lines are written empty and nothing is said about Telegram", () => {
      for (const alerts of [null, "", `ALERT_WEBHOOK_URL=${HOOK}\n`, "TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\n"]) {
        const r = run("snarksm", `HELIUS_API_KEY=${KEY}\n`, alerts);
        expect(r.code).toBe(0);
        expect(stdinOf(r)).toContain("TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=\n");
        expect(r.err).toBe("");
      }
    });

    test("only one of the two: it is pushed as it is, with a note that names both variables and no value", () => {
      for (const alerts of [`TELEGRAM_BOT_TOKEN=${TG_TOKEN}\n`, `TELEGRAM_CHAT_ID=${TG_CHAT}\n`]) {
        const r = run("snarksm", `HELIUS_API_KEY=${KEY}\n`, alerts);
        expect(r.code).toBe(0);
        expect(r.err).toContain("only one of TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID is set");
        expect(r.out + r.err).not.toContain(TG_TOKEN);
        expect(r.out + r.err).not.toContain(TG_CHAT);
        expect(r.calls.length).toBeGreaterThan(0);
      }
    });

    test.each([
      ["a token with a space in it", `TELEGRAM_BOT_TOKEN=123456789:AAH test_TOKEN0123456789abcdefghij`],
      ["a token with a quote in it", `TELEGRAM_BOT_TOKEN=123456789:AAH"test_TOKEN0123456789abcdefghij`],
      ["a token with a dollar sign in it", `TELEGRAM_BOT_TOKEN=123456789:AAH$test_TOKEN0123456789abcdefghij`],
      ["a token with a semicolon in it", `TELEGRAM_BOT_TOKEN=123456789:AAH;rm-rf-test_TOKEN0123456789abcdefghij`],
      ["a token with no colon", `TELEGRAM_BOT_TOKEN=123456789AAH-test_TOKEN0123456789abcdefghijk`],
      ["a token whose second part has 29 characters", `TELEGRAM_BOT_TOKEN=123456789:${"a".repeat(29)}`],
      ["a token whose second part has 51 characters", `TELEGRAM_BOT_TOKEN=123456789:${"a".repeat(51)}`],
      ["a token whose first part has letters in it", `TELEGRAM_BOT_TOKEN=12345a789:AAH-test_TOKEN0123456789abcdefghijk`],
      ["a token whose first part has 5 digits", `TELEGRAM_BOT_TOKEN=12345:AAH-test_TOKEN0123456789abcdefghijk`],
    ])("refuses %s, contacts no server and prints no part of it", (_label, line) => {
      const r = run("snarksm", `HELIUS_API_KEY=${KEY}\n`, `${line}\nTELEGRAM_CHAT_ID=${TG_CHAT}\n`);
      const value = line.slice(line.indexOf("=") + 1);
      expect(r.code).not.toBe(0);
      expect(r.calls).toHaveLength(0);
      expect(r.err).toContain("TELEGRAM_BOT_TOKEN");
      expect(r.out + r.err).not.toContain(value);
      expect(r.out + r.err).not.toContain(value.slice(value.indexOf(":") + 1));
    });

    test.each([
      ["letters in it", "86x4242"],
      ["4 digits", "8642"],
      ["21 digits", "1".repeat(21)],
      ["two minus signs", "--100123456"],
      ["a plus sign", "+424242424"],
      ["a space inside", "4242 42424"],
      ["an exponent", "1e10000"],
    ])("refuses a chat id with %s, contacts no server and prints no part of it", (_label, chat) => {
      const r = run("snarksm", `HELIUS_API_KEY=${KEY}\n`, `TELEGRAM_BOT_TOKEN=${TG_TOKEN}\nTELEGRAM_CHAT_ID=${chat}\n`);
      expect(r.code).not.toBe(0);
      expect(r.calls).toHaveLength(0);
      expect(r.err).toContain("TELEGRAM_CHAT_ID");
      expect(r.err.slice(r.err.indexOf("alerts.env"))).not.toContain(chat); // after the scratch path, whose random letters and digits could hold a short number
      expect(r.out).not.toContain(chat);
      expect(r.out + r.err).not.toContain(TG_TOKEN);
    });
  });
});

describe("ops/keys-setup.sh keeper key snippet", () => {
  const script = readFileSync(join(OPS, "keys-setup.sh"), "utf8");
  const snippet = /KEEPER_JS='\n([\s\S]*?)\n'\n/.exec(script)?.[1] ?? "";
  const make = (path: string) => {
    const r = Bun.spawnSync([process.execPath, "-e", snippet], { cwd: ENGINE, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", KEYPATH: path } });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr) };
  };

  test("is found in the script", () => {
    expect(snippet).toContain("Keypair.generate()");
  });

  test("makes a 0600 key once, prints only the public key, and never overwrites it", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const path = join(dir, "keeper-mainnet.json");
    const first = make(path);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const bytes = JSON.parse(readFileSync(path, "utf8")) as number[];
    expect(bytes).toHaveLength(64);
    expect(first.out + first.err).not.toContain(String(bytes.slice(0, 32)));
    const before = readFileSync(path, "utf8");
    const second = make(path);
    expect(second.out).toBe(first.out);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a file that is not a keypair stops it, untouched, without echoing the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-"));
    const path = join(dir, "keeper-mainnet.json");
    writeFileSync(path, "not json but secret-looking-content-123");
    const r = make(path);
    expect(r.code).toBe(1);
    expect(r.out + r.err).not.toContain("secret-looking-content-123");
    expect(readFileSync(path, "utf8")).toBe("not json but secret-looking-content-123");
    expect(existsSync(path)).toBe(true);
  });
});
