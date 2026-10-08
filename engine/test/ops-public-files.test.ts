// The ops kit's side of the hosted files docs/API.md v2.7: where each instance keeps them, what Caddy does with /i and /m, the address
// they are served from, how that address follows the launch-day switch, and that the nightly backup carries the pictures. Everything runs against
// rendered templates and a scratch directory standing in for /: no server, no chain.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");
const OPS = join(REPO, "ops");

function sh(script: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", script], { cwd: REPO, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}
const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sitesFile = (dir: string, live: "snarks" | "snarksm", test = "test.snarks.fun 38-49-215-61.sslip.io") => {
  const file = join(dir, "snarks-sites.env");
  writeFileSync(file, `LIVE_HOSTS="snarks.fun"\nTEST_HOSTS="${test}"\nLIVE_INSTANCE=${live}\n`);
  return file;
};

describe("where each instance keeps its public files", () => {
  test("/var/lib/<instance>/public, which the API unit may already write (so no unit needs another path)", () => {
    for (const inst of ["snarks", "snarksm"]) {
      const r = sh(`. ops/instance.sh && instance_load ${inst} && echo "$I_PUBLIC $I_DATA"`);
      const [pub, data] = r.out.trim().split(" ");
      expect([pub, data]).toEqual([`/var/lib/${inst}/public`, `/var/lib/${inst}`]);
      const unit = sh(`. ops/instance.sh && instance_load ${inst} && instance_render ops/templates/api.service`).out;
      const writable = /^ReadWritePaths=(.*)$/m.exec(unit)![1]!.split(" ");
      expect(writable.some((p) => pub!.startsWith(`${p}/`))).toBe(true);
    }
  });

  test("the settings templates name the directory and leave the address empty for remote-setup to fill", () => {
    for (const [inst, template] of [["snarks", "engine.env.devnet.example"], ["snarksm", "engine.env.mainnet.example"]] as const) {
      const text = sh(`. ops/instance.sh && instance_load ${inst} && instance_render ops/templates/${template}`).out;
      expect(text).toMatch(new RegExp(`^PUBLIC_DIR=/var/lib/${inst}/public$`, "m"));
      expect(text).toMatch(/^PUBLIC_BASE_URL=$/m);
    }
  });
});

describe("Caddy serves /i and /m as static files", () => {
  const dir = scratch("sites-");
  const variant = (inst: string, live: "snarks" | "snarksm") => {
    const r = sh(`ops/caddy-render.sh --print ${inst}`, { SITES_FILE: sitesFile(dir, live) });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    return r.out;
  };
  const block = (text: string, path: string) => new RegExp(`handle ${path.replace("*", "\\*")} \\{[^}]*\\{[^}]*\\}[^}]*\\}`).exec(text)?.[0] ?? "";

  test("each site block has the two handles, with the instance's own directory as their root", () => {
    const v = variant("snarksm", "snarksm"); // the live name serves mainnet, the test names stay on devnet: one block each
    expect(v.match(/handle \/i\/\* \{/g)).toHaveLength(2);
    expect(v.match(/handle \/m\/\* \{/g)).toHaveLength(2);
    expect(v.match(/^\t\t\troot (\S+)$/gm)?.map((l) => l.trim())).toEqual([
      "root /var/lib/snarksm/public", "root /var/lib/snarksm/public", "root /var/lib/snarks/public", "root /var/lib/snarks/public",
    ]);
    const devnetOnly = variant("snarks", "snarks");
    expect(devnetOnly.match(/^\t\t\troot (\S+)$/gm)?.map((l) => l.trim())).toEqual(["root /var/lib/snarks/public", "root /var/lib/snarks/public"]);
    expect(devnetOnly).not.toContain("snarksm");
  });

  test("an image is cached for a year as immutable, metadata for a minute, both nosniff, readable from any page, listed by nobody", () => {
    const v = variant("snarks", "snarks");
    const images = block(v, "/i/*");
    const meta = block(v, "/m/*");
    expect(images).toContain('header Cache-Control "public, max-age=31536000, immutable"');
    expect(meta).toContain('header Cache-Control "public, max-age=60"');
    for (const b of [images, meta]) {
      expect(b).toContain('header X-Content-Type-Options "nosniff"');
      expect(b).toContain('header Access-Control-Allow-Origin "*"');
      expect(b).toContain("file_server {");
      expect(b).not.toContain("browse");
    }
  });

  test("the API and the site keep their own handles, and the two new ones come before the site's catch-all", () => {
    const v = variant("snarks", "snarks");
    const at = (needle: string) => v.indexOf(needle);
    expect(at("handle /api/* {")).toBeGreaterThan(-1);
    expect(at("handle /i/* {")).toBeLessThan(at("\thandle {\n"));
    expect(at("handle /m/* {")).toBeLessThan(at("\thandle {\n"));
    expect(v).toContain("root * /opt/snarks/web");
  });

  test("the rendered file validates with the real Caddy when this machine has one", () => {
    if (Bun.spawnSync(["which", "caddy"]).exitCode !== 0) return;
    const file = join(dir, "Caddyfile.check");
    writeFileSync(file, variant("snarksm", "snarksm").replaceAll("/var/log/caddy/", `${dir}/`));
    const r = sh(`caddy validate --config ${file} --adapter caddyfile`);
    expect(r.err + r.out).toContain("Valid configuration");
  });
});

describe("the address the files are served from", () => {
  const url = (inst: string, file: string | null) => sh(`. ops/instance.sh && instance_public_url ${inst} ${file ?? "/nonexistent/sites.env"}`);

  test("the live name for the instance the live name serves, the first test name for the devnet instance once it is not live", () => {
    const dir = scratch("url-");
    expect(url("snarks", sitesFile(dir, "snarks")).out.trim()).toBe("https://snarks.fun");
    expect(url("snarksm", sitesFile(dir, "snarks")).out.trim()).toBe("https://snarks.fun");
    expect(url("snarks", sitesFile(dir, "snarksm")).out.trim()).toBe("https://test.snarks.fun");
    expect(url("snarksm", sitesFile(dir, "snarksm")).out.trim()).toBe("https://snarks.fun");
  });

  test("says nothing and fails when there is no sites file, or no test name for a devnet instance that needs one", () => {
    const dir = scratch("url-");
    expect(url("snarks", null).code).not.toBe(0);
    expect(url("snarks", null).out).toBe("");
    const noTest = url("snarks", sitesFile(dir, "snarksm", ""));
    expect(noTest.code).not.toBe(0);
    expect(noTest.out).toBe("");
  });
});

describe("writing one setting into an instance's settings file", () => {
  const settings = (text: string) => {
    const file = join(scratch("env-"), "settings");
    writeFileSync(file, text);
    chmodSync(file, 0o640);
    return file;
  };

  test("fill adds a missing line, fills an empty one and never overwrites a value", () => {
    const missing = settings("A=1\n");
    sh(`. ops/instance.sh && instance_fill_env ${missing} PUBLIC_DIR /var/lib/snarks/public`);
    expect(readFileSync(missing, "utf8")).toBe("A=1\nPUBLIC_DIR=/var/lib/snarks/public\n");
    const empty = settings("A=1\nPUBLIC_BASE_URL=\nB=2\n");
    sh(`. ops/instance.sh && instance_fill_env ${empty} PUBLIC_BASE_URL https://snarks.fun`);
    expect(readFileSync(empty, "utf8")).toBe("A=1\nPUBLIC_BASE_URL=https://snarks.fun\nB=2\n");
    const set = settings("PUBLIC_BASE_URL=https://kept.example\n");
    sh(`. ops/instance.sh && instance_fill_env ${set} PUBLIC_BASE_URL https://snarks.fun`);
    expect(readFileSync(set, "utf8")).toBe("PUBLIC_BASE_URL=https://kept.example\n");
  });

  test("set replaces the line where it is, keeps every other line and the file's mode", () => {
    const file = settings("# comment\nPUBLIC_BASE_URL=https://old.example\nPAD_MODE=devnet\n");
    sh(`. ops/instance.sh && instance_set_env ${file} PUBLIC_BASE_URL https://snarks.fun`);
    expect(readFileSync(file, "utf8")).toBe("# comment\nPUBLIC_BASE_URL=https://snarks.fun\nPAD_MODE=devnet\n");
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });
});

describe("the launch-day switch moves the address with the names", () => {
  function server(opts: { live: "snarks" | "snarksm"; devnetUrl?: string | null; mainnetUrl?: string | null; devnetApiActive?: boolean }) {
    const root = scratch("srv-");
    const caddy = join(root, "etc", "caddy");
    for (const d of [caddy, join(root, "opt", "snarksm", "web"), join(root, "opt", "snarks", "web"), join(root, "bin"), join(root, "etc", "snarks"), join(root, "etc", "snarksm")]) mkdirSync(d, { recursive: true });
    for (const w of ["snarks", "snarksm"]) writeFileSync(join(root, "opt", w, "web", "index.html"), "<!doctype html>");
    sitesFile(caddy, opts.live);
    expect(sh("ops/caddy-render.sh --no-validate", { CADDY_DIR: caddy }).code).toBe(0);
    const engineEnv = (inst: string, url: string | null | undefined) => {
      if (url === null) return;
      writeFileSync(join(root, "etc", inst, "engine.env"), `PAD_MODE=x\nPUBLIC_BASE_URL=${url ?? ""}\nKEY=keep\n`);
      chmodSync(join(root, "etc", inst, "engine.env"), 0o640);
    };
    engineEnv("snarks", "devnetUrl" in opts ? opts.devnetUrl : opts.live === "snarks" ? "https://snarks.fun" : "https://test.snarks.fun");
    engineEnv("snarksm", "mainnetUrl" in opts ? opts.mainnetUrl : "https://snarks.fun");
    writeFileSync(join(root, "bin", "curl"), `#!/bin/bash\nfor a in "$@"; do url="$a"; done\ncase "$url" in\n  http://127.0.0.1:8789/*) m=mainnet ;;\n  http://127.0.0.1:8787/*) m=devnet ;;\n  https://*) if grep -q '^snarks.fun {' "${caddy}/Caddyfile"; then m=mainnet; else m=devnet; fi ;;\nesac\nprintf 'HTTP/2 200\\r\\nx-pad-mode: %s\\r\\n\\r\\n' "$m"\n`);
    writeFileSync(join(root, "bin", "caddy"), "#!/bin/bash\nexit 0\n");
    writeFileSync(join(root, "bin", "systemctl"), `#!/bin/bash\necho "$*" >> "${root}/systemctl.log"\nif [ "$1" = is-active ] && [ "$3" = snarks-api ] && [ "\${FAKE_DEVNET_API_STOPPED:-}" = 1 ]; then exit 3; fi\nexit 0\n`);
    for (const f of ["curl", "caddy", "systemctl"]) chmodSync(join(root, "bin", f), 0o755);
    const env = { ROOT_PREFIX: root, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, ...(opts.devnetApiActive === false ? { FAKE_DEVNET_API_STOPPED: "1" } : {}) };
    const urlOf = (inst: string) => (/^PUBLIC_BASE_URL=(.*)$/m.exec(readFileSync(join(root, "etc", inst, "engine.env"), "utf8")) ?? [])[1];
    const log = () => (existsSync(join(root, "systemctl.log")) ? readFileSync(join(root, "systemctl.log"), "utf8") : "");
    return { run: (...args: string[]) => sh(`ops/switch-live.sh ${args.join(" ")}`, env), urlOf, log, root };
  }

  test("to mainnet: the devnet instance moves to the first test name and its API (only) restarts; the mainnet address stays the live name", () => {
    const srv = server({ live: "snarks" });
    const r = srv.run("snarksm");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(srv.urlOf("snarks")).toBe("https://test.snarks.fun");
    expect(srv.urlOf("snarksm")).toBe("https://snarks.fun");
    expect(r.out).toContain("PUBLIC_BASE_URL of snarks: https://snarks.fun -> https://test.snarks.fun");
    expect(srv.log()).toContain("restart snarks-api");
    expect(srv.log()).not.toContain("restart snarksm-api");
    expect(srv.log()).not.toMatch(/restart \S*keeper/);
    expect(readFileSync(join(srv.root, "etc", "snarks", "engine.env"), "utf8")).toBe("PAD_MODE=x\nPUBLIC_BASE_URL=https://test.snarks.fun\nKEY=keep\n");
    expect(statSync(join(srv.root, "etc", "snarks", "engine.env")).mode & 0o777).toBe(0o640);
  });

  test("and back: the devnet instance returns to the live name", () => {
    const srv = server({ live: "snarksm" });
    expect(srv.run("snarks").code).toBe(0);
    expect(srv.urlOf("snarks")).toBe("https://snarks.fun");
    expect(srv.log()).toContain("restart snarks-api");
  });

  test("a mainnet address that was never set is filled with the live name; its API restarts only if it is running", () => {
    const srv = server({ live: "snarks", mainnetUrl: "" });
    srv.run("snarksm");
    expect(srv.urlOf("snarksm")).toBe("https://snarks.fun");
  });

  test("an instance whose API is stopped gets the line but no restart", () => {
    const srv = server({ live: "snarks", devnetApiActive: false });
    const r = srv.run("snarksm");
    expect(r.code).toBe(0);
    expect(srv.urlOf("snarks")).toBe("https://test.snarks.fun");
    expect(srv.log()).not.toContain("restart snarks-api");
  });

  test("an instance with no settings file is left alone, and --check changes nothing", () => {
    const none = server({ live: "snarks", devnetUrl: null });
    expect(none.run("snarksm").code).toBe(0);
    expect(existsSync(join(none.root, "etc", "snarks", "engine.env"))).toBe(false);
    const check = server({ live: "snarks" });
    const r = check.run("snarksm", "--check");
    expect(r.code).toBe(0);
    expect(r.out).toContain("snarks's coin images and metadata will be served from https://test.snarks.fun");
    expect(check.urlOf("snarks")).toBe("https://snarks.fun");
    expect(check.log()).not.toContain("restart");
  });

  test("an address that is already right is not rewritten and nothing restarts", () => {
    const srv = server({ live: "snarks", devnetUrl: "https://test.snarks.fun" });
    srv.run("snarksm");
    expect(srv.log()).not.toContain("restart");
  });
});

describe("the provisioning script", () => {
  const script = readFileSync(join(OPS, "remote-setup.sh"), "utf8");

  test("is valid bash", () => {
    expect(sh("bash -n ops/remote-setup.sh").code).toBe(0);
  });

  test("makes the public directories for the instance's user and group caddy (setgid, 0750), lets Caddy through the data directory by ACL only, fills the two settings", () => {
    expect(script).toContain('install -d -m 750 -o "$I_USER" -g caddy "$I_PUBLIC" "$I_PUBLIC/i" "$I_PUBLIC/m"');
    expect(script).toContain('find "$I_PUBLIC" -type d -exec chmod 2750 {} +');
    expect(script).toContain('find "$I_PUBLIC" -type f -exec chmod 0640 {} +');
    expect(script).toContain('setfacl -m u:caddy:--x "$I_DATA"');
    expect(script).not.toMatch(/usermod -aG[^\n]*caddy|chmod[^\n]*o\+x[^\n]*\$I_DATA/); // Caddy is never put in the instance's group
    expect(script).toContain('instance_fill_env "$I_ETC/engine.env" PUBLIC_DIR "$I_PUBLIC"');
    expect(script).toContain('instance_fill_env "$I_ETC/engine.env" PUBLIC_BASE_URL "$public_url"');
  });
});

const haveBackupTools = ["age", "age-keygen", "sqlite3"].every((t) => Bun.spawnSync(["which", t]).exitCode === 0);

describe.skipIf(!haveBackupTools)("the nightly backup carries the coin images and metadata", () => {
  test("public/i and public/m are in the archive", () => {
    const dir = scratch("bak-");
    const mk = (cmd: string) => expect(sh(cmd).code).toBe(0);
    mk(`mkdir -p ${dir}/data/data ${dir}/data/public/i ${dir}/data/public/m ${dir}/keys ${dir}/out`);
    mk(`sqlite3 ${dir}/data/data/x.sqlite 'create table t(a);'; echo png > ${dir}/data/public/i/0123456789abcdef01234567.png; echo json > ${dir}/data/public/m/mint.json; echo key > ${dir}/keys/k.json`);
    mk(`age-keygen -o ${dir}/id.txt 2>/dev/null`);
    const pub = sh(`age-keygen -y ${dir}/id.txt`).out.trim();
    const r = sh("ops/backup.sh", { SNARKS_DATA: `${dir}/data`, SNARKS_KEYS: `${dir}/keys`, SNARKS_BACKUPS: `${dir}/out`, BACKUP_AGE_RECIPIENT: pub });
    expect(r.code).toBe(0);
    const archive = sh(`ls ${dir}/out`).out.trim();
    const listing = sh(`age -d -i ${dir}/id.txt ${dir}/out/${archive} | tar -tzf -`).out;
    for (const entry of ["./public/i/0123456789abcdef01234567.png", "./public/m/mint.json", "./db/x.sqlite"]) expect(listing).toContain(entry);
  });

  test("an instance with no public directory yet still backs up", () => {
    const dir = scratch("bak-");
    sh(`mkdir -p ${dir}/data/data ${dir}/keys ${dir}/out; sqlite3 ${dir}/data/data/x.sqlite 'create table t(a);'; age-keygen -o ${dir}/id.txt 2>/dev/null`);
    const pub = sh(`age-keygen -y ${dir}/id.txt`).out.trim();
    expect(sh("ops/backup.sh", { SNARKS_DATA: `${dir}/data`, SNARKS_KEYS: `${dir}/keys`, SNARKS_BACKUPS: `${dir}/out`, BACKUP_AGE_RECIPIENT: pub }).code).toBe(0);
  });
});
