// Zcash regtest recipients for the stress runs: W wallets x A accounts, each account an independent recipient whose
// balance is read on its own (`wallet balance <uuid> --json`), so every shielded payout can be checked per holder.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";

export interface Recipient { walletDir: string; account: string; ua: string }

function dt(args: string[]): string {
  const p = Bun.spawnSync([config.paths.zcashDevtoolBin, ...args], { env: { RUST_LOG: "warn", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  const out = new TextDecoder().decode(p.stdout);
  if (p.exitCode !== 0) throw new Error(`devtool ${args[2] ?? args[0]} failed: ${new TextDecoder().decode(p.stderr).slice(0, 300)}`);
  return out;
}

const server = () => config.zcash.lightwalletdServer;

export function accounts(walletDir: string): string[] {
  return [...dt(["wallet", "-w", walletDir, "list-accounts"]).matchAll(/^Account ([0-9a-f-]{36})/gm)].map((m) => m[1]!);
}

export function accountAddress(walletDir: string, account: string): string {
  const m = /Default Address:\s*(\S+)/.exec(dt(["wallet", "-w", walletDir, "list-addresses", account]));
  if (!m) throw new Error(`no address for ${account}`);
  return m[1]!;
}

export function makeRecipientWallets(baseDir: string, n: number, perWallet: number): Recipient[] {
  const out: Recipient[] = [];
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  for (let w = 0; out.length < n; w++) {
    const dir = join(baseDir, `w${w}`);
    const id = join(baseDir, `w${w}.age`);
    if (!existsSync(join(dir, "data.sqlite"))) {
      for (let i = 0; ; i++) {
        try {
          dt(["wallet", "-w", dir, "init", "--name", `w${w}`, "-i", id, "-n", "regtest", "--activation-heights", config.paths.activationHeights, "-s", server()]);
          break;
        } catch (e) {
          if (i > 8) throw e;
          Bun.sleepSync(2000);
        }
      }
    }
    const want = Math.min(perWallet, n - out.length);
    for (let have = accounts(dir).length; have < want; have++) dt(["wallet", "-w", dir, "generate-account", "-i", id, "--name", `a${have}`, "-s", server()]);
    for (const acc of accounts(dir).slice(0, want)) out.push({ walletDir: dir, account: acc, ua: accountAddress(dir, acc) });
  }
  return out;
}

export function syncRecipientWallet(walletDir: string): void {
  dt(["wallet", "-w", walletDir, "sync", "-s", server()]);
}

export function accountTotalZats(walletDir: string, account: string): bigint {
  return BigInt((JSON.parse(dt(["wallet", "-w", walletDir, "balance", account, "--json"])) as { total: number }).total);
}
