// Keeps RPC keys out of every log, error line, alert and health-log entry. Imports nothing from the engine (config.ts
// loads it first). Three rules: an `api-key=<value>` query parameter is masked wherever it appears, the literal
// value of every secret env var (the Helius key, the 1Click key) is masked even when it appears bare, and so are the
// key-carrying parts of a full RPC URL setting (its path, each long path segment, each query value, a login):
// QuickNode and Alchemy keep the key in the path, where no `api-key=` rule can see it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_ENV_NAMES = ["HELIUS_API_KEY", "NEAR1CLICK_API_KEY"] as const;
const RPC_URL_ENV_NAMES = ["SOLANA_DEVNET_RPC", "SOLANA_MAINNET_RPC"] as const;
const MASK = "<redacted>";

/** `api-key=...`, `apikey=...`, `api_key=...`, `x-api-key: ...` up to the next separator. */
const KEY_PARAM = /\b(api[-_]?key)(=|:\s*)[^\s&"'<>)\]}]+/gi;

/** The pieces of an RPC URL that can be the key on their own; the host is not one of them (startup lines print it). An unparseable value is wholly secret. */
function urlSecrets(raw: string): string[] {
  try {
    const u = new URL(raw);
    return [...u.pathname.split("/"), u.pathname.replace(/^\/+|\/+$/g, ""), ...u.searchParams.values(), u.username, u.password];
  } catch {
    return [raw];
  }
}

/** Secret values are looked up each call so a key loaded late (loadSecretEnvFile) is covered too. */
function secretValues(): string[] {
  const keys = SECRET_ENV_NAMES.map((n) => process.env[n]);
  const urls = RPC_URL_ENV_NAMES.flatMap((n) => urlSecrets(process.env[n] ?? ""));
  return [...keys, ...urls].filter((v): v is string => !!v && v.length >= 8);
}

export function redactSecrets(text: string): string {
  let out = text.replace(KEY_PARAM, (_m, name: string, sep: string) => `${name}${sep}${MASK}`);
  for (const v of secretValues()) out = out.split(v).join(MASK);
  return out;
}

/** An Error (or anything) as redacted text, stack included. */
export function redactedErrorText(err: unknown): string {
  if (err instanceof Error) return redactSecrets(err.stack ?? `${err.name}: ${err.message}`);
  if (typeof err === "string") return redactSecrets(err);
  try {
    return redactSecrets(JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? String(err));
  } catch {
    return redactSecrets(String(err));
  }
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === "string") return redactSecrets(arg);
  if (arg instanceof Error) return redactedErrorText(arg);
  if (arg !== null && typeof arg === "object") return redactedErrorText(arg);
  return arg;
}

let installed = false;

/**
 * Wraps console.log/info/warn/error/debug so nothing printed can carry a key, and routes uncaught errors through the
 * same masking (the runtime prints those itself, bypassing console). Idempotent.
 */
export function installRedaction(): void {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => original(...args.map(redactArg));
  }
  if (process.env.NODE_ENV === "test") return; // the test runner reports its own uncaught errors
  const die = (err: unknown) => {
    console.error("fatal:", err);
    process.exit(1);
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
}

/**
 * Loads KEY=VALUE lines of a private env file into process.env without ever printing them (variables already set win).
 * Returns the names it set. A missing file is not an error.
 */
export function loadSecretEnvFile(path = process.env.PAD_ENV_FILE ?? join(homedir(), ".config", "snarks-pad", "rpc.env")): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]!] === undefined && value !== "") {
      process.env[m[1]!] = value;
      set.push(m[1]!);
    }
  }
  return set;
}
