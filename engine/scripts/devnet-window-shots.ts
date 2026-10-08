#!/usr/bin/env bun
// D-3 renders of the launch window on the DEPLOYED site, taken while the window is really open: a coin is launched through the pad's API with a fresh test wallet, and the browser
// is already on that coin's page (its address is known from launch-tx, before anything is sent) so it can read the coin the instant the pool exists. The page's own poll is told to
// read now (a `visibilitychange`, which is what the tab coming back to the front does), the countdown is waited for, and the page is shot within the five seconds. Then the same
// page once the window has closed (the trade box with Buy on, and the What is fixed tab with its Launch window row). One launch per frame.
//   scripts/devnet.sh bun scripts/devnet-window-shots.ts <out dir> [--api https://snarks.fun/api] [--app https://snarks.fun/]
// Frames: 1440x900 dark and 390x844 light. Prints the countdown text each shot carries and the engine's own `windowSecondsLeft`; a frame that missed the window is retried.
import { Keypair, PublicKey } from "@solana/web3.js";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { config } from "../src/config";
import { must, signAndSend, topUp } from "./lib/devnet-live";

const require = createRequire(import.meta.url);
// the puppeteer the QA scripts of web/qa use (the MCP server's copy), and the Chrome they drive
const puppeteer = require("/opt/homebrew/lib/node_modules/@modelcontextprotocol/server-puppeteer/node_modules/puppeteer") as typeof import("puppeteer");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// the test wallet of web/qa (its key lives in this process; the page sees it as window.phantom): a visitor with a wallet connected is who sees "Wait N s" on the Buy button
const qa = require("../../web/qa/launch-helpers.cjs") as {
  newWallet: () => { pk: string };
  openPage: (browser: unknown, wallet: { pk: string }, o: { width: number; height: number; theme: string }) => Promise<{ page: Page }>;
  connect: (page: Page, pk: string) => Promise<boolean>;
};

const arg = (name: string): string | undefined => (process.argv.indexOf(name) >= 0 ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const API = (arg("--api") ?? "https://snarks.fun/api").replace(/\/$/, "");
const APP = (arg("--app") ?? "https://snarks.fun/").replace(/\/?$/, "/");
const OUT = resolve(process.argv[2] ?? "");
if (!process.argv[2] || config.mode !== "devnet") throw new Error("usage: scripts/devnet.sh bun scripts/devnet-window-shots.ts <out dir> [--api ...] [--app ...]");
const FRAMES: { width: number; height: number; theme: "dark" | "light" }[] = [{ width: 1440, height: 900, theme: "dark" }, { width: 390, height: 844, theme: "light" }];
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// In-page snippets are strings: this file is checked without the DOM types, and the code runs in the browser.
const TEXT = "document.body.innerText";
const HAS_COUNTDOWN = `${TEXT}.includes("Launch window:")`;
const READ_NOW = `document.dispatchEvent(new Event("visibilitychange"))`; // the tab coming to the front: the page's poll reads at once
const WAIT_BUTTON = `[...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).find((t) => /^Wait \\d+ s$/.test(t)) || null`;
const BUY_ON = `[...document.querySelectorAll("button, a")].some((b) => /^(Buy \\$|Connect wallet to buy)/.test((b.textContent || "").trim()))`;
const BUTTONS = `[...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean)`;
const OPEN_FIXED = `(() => { const t = [...document.querySelectorAll("button[role=tab]")].find((b) => /What is fixed|Fixed/.test(b.textContent || "")); if (t) t.click(); return !!t; })()`;

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>;

/** The page with a funded test wallet connected on the home page first, then moved to the coin's address (not launched yet: the page says so and keeps asking). */
async function openCoinPage(browser: Awaited<ReturnType<typeof puppeteer.launch>>, f: (typeof FRAMES)[number], mint: string): Promise<Page> {
  const wallet = qa.newWallet();
  await topUp(new PublicKey(wallet.pk), 0.02, 100_000_000n);
  const { page } = await qa.openPage(browser, wallet, { width: f.width, height: f.height, theme: f.theme });
  await page.goto(APP, { waitUntil: "networkidle2" });
  if (!(await qa.connect(page, wallet.pk))) throw new Error("the test wallet did not connect");
  await page.evaluate(`location.hash = "#/coin/${mint}"`);
  return page;
}

const bodyText = (page: Page): Promise<string> => page.evaluate(TEXT) as Promise<string>;

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Frame = (typeof FRAMES)[number];

/** Launches a coin through the pad with a fresh test wallet, the browser already on its page; the page is told to read the coin the moment the pool exists. */
async function launchWithPageOpen(browser: Browser, f: Frame, n: number): Promise<{ page: Page; mint: string; fixedSeen: string[] }> {
  const creator = Keypair.generate();
  await topUp(creator.publicKey, 0.06, 100_000_000n);
  const made = await must(API, "POST", "/coins/launch-tx", { creator: creator.publicKey.toBase58(), name: `Window ${n}`, symbol: `WN${Date.now() % 100000}`, description: "devnet launch-window render (D-3)", imageUrl: "", feeTier: 100, initialBuyZec: "50000000" });
  const mint = made.mint as string;
  const page = await openCoinPage(browser, f, mint); // the coin is not launched yet: the page says so and keeps asking
  const fixedSeen: string[] = []; // what the page's own calls for the What is fixed facts got back
  page.on("response", (r) => { if (r.url().includes("/fixed")) fixedSeen.push(String(r.status())); });
  page.on("requestfailed", (r) => { if (r.url().includes("/fixed")) fixedSeen.push(`failed: ${r.failure()?.errorText ?? "?"}`); });
  const sig = await signAndSend(made.tx as string, creator);
  await must(API, "POST", "/coins/confirm", { sig, mint });
  await page.evaluate(READ_NOW); // the page reads the coin now, not at its next 6 s tick
  return { page, mint, fixedSeen };
}

/** The countdown on the page, shot while it is there. `text` and `button` are null when the window was missed. */
async function shootOpen(page: Page, f: Frame): Promise<{ file: string; shown: boolean; text: string | null; button: string | null }> {
  const shown = await page.waitForFunction(HAS_COUNTDOWN, { polling: 40, timeout: 3500 }).then(() => true, () => false);
  const file = join(OUT, `coin-window-open-${f.width}-${f.theme}.png`);
  if (shown) await page.screenshot({ path: file });
  const text = shown ? (await bodyText(page)).split("\n").find((l) => l.startsWith("Launch window:")) ?? null : null;
  const button = shown ? ((await page.evaluate(WAIT_BUTTON)) as string | null) : null;
  return { file, shown, text, button };
}

/** The same page once the countdown is gone (Buy on), and its What is fixed tab. */
async function shootClosed(page: Page, f: Frame, fixedSeen: string[]): Promise<{ buyOn: boolean; fixedText: string | null }> {
  await page.waitForFunction(`!(${HAS_COUNTDOWN})`, { polling: 100, timeout: 12_000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: join(OUT, `coin-window-closed-${f.width}-${f.theme}.png`) });
  const buyOn = (await page.evaluate(BUY_ON)) as boolean;
  const fixedTab = (await page.evaluate(OPEN_FIXED)) as boolean;
  await new Promise((r) => setTimeout(r, 1200));
  const fixedText = fixedTab ? (await bodyText(page)).split("\n").find((l) => l.startsWith("Launch window.") || l.includes("seconds after the pool was created")) ?? null : null;
  await page.screenshot({ path: join(OUT, `coin-window-fixed-${f.width}-${f.theme}.png`) });
  log(`  closed: the countdown is gone, Buy on: ${buyOn}; fixed row: ${fixedText}; the page's calls for the facts got: ${JSON.stringify(fixedSeen)}`);
  return { buyOn, fixedText };
}

/** Launches a coin on the pad and shoots its page inside the window. Returns what the shot shows, or null when the window was missed. */
async function frame(browser: Browser, f: Frame, n: number): Promise<Record<string, unknown> | null> {
  const { page, mint, fixedSeen } = await launchWithPageOpen(browser, f, n);
  const open = await shootOpen(page, f);
  const left = Number((await must(API, "GET", `/coins/${mint}`)).windowSecondsLeft);
  if (!open.shown || !open.text || !open.button) {
    log(`frame ${f.width} ${f.theme}: the window was missed (countdown shown ${open.shown}, countdown line ${JSON.stringify(open.text)}, wait button ${JSON.stringify(open.button)}); the engine said ${left} s left afterwards`);
    if (open.shown) log(`  the page's lines with "window": ${JSON.stringify((await bodyText(page)).split("\n").filter((l) => /window/i.test(l)))}; its buttons: ${JSON.stringify(await page.evaluate(BUTTONS))}`);
    await page.close();
    return null;
  }
  log(`frame ${f.width} ${f.theme}: shot ${open.file}; the page says "${open.text}" and the button "${open.button}"`);
  const closed = await shootClosed(page, f, fixedSeen);
  await page.close();
  return { mint, frame: `${f.width}-${f.theme}`, countdown: open.text, button: open.button, closedBuyOn: closed.buyOn, fixedRow: closed.fixedText };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, executablePath: CHROME });
  const done: Record<string, unknown>[] = [];
  try {
    for (const f of FRAMES) {
      for (let n = 1; n <= 4; n++) {
        const r = await frame(browser, f, n);
        if (r) { done.push(r); break; }
      }
    }
  } finally {
    await browser.close();
  }
  log(JSON.stringify(done, null, 2));
  if (done.length !== FRAMES.length) process.exit(1);
}

await main();
