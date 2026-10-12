// Copy that states the fee must match what the permanent config really does (audit/CONFIG-REVIEW.md S1-M1):
// the fee on the curve is flat 1%; after graduation the DAMM v2 pool charges 1% rising to about 1.2%.
// The pages are found by listing web/src/routes and web/src/components, never by a fixed list, so a page or a card added later is checked too.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config";
import { REVIEWED_CONFIG, REVIEWED_TIERS, REVIEWED_WINDOW, TIER_MENU_BPS, windowScheduleOf } from "../src/dbc/reviewed";
import { feeChip, feeLabel, per100, POST_GRADUATION_FEE_MAX_BPS, roundTripByTier, roundTripCostBps as webRoundTripCostBps, roundTripPer100, TIER_FEES_BPS } from "../../web/src/lib/format";
import { sharesFromPolicy } from "../../web/src/lib/fees";
import { confirmLineOfTier, feeLineOfTier } from "../../web/src/lib/launch";
import { HOW_EXAMPLE, exampleSteps, stepsOf } from "../../web/src/lib/window";
import { MAX_UPLOAD_BYTES } from "../src/publicFiles/image";
import { feeSplitBps } from "../src/epoch/split";
import { roundTripCostBps, tierShares } from "../src/dbc/tiers";

const repo = (...p: string[]) => readFileSync(join(config.paths.repoRoot, ...p), "utf8");
const route = (file: string) => repo("web", "src", "routes", file);
const component = (file: string) => repo("web", "src", "components", file);
// ai/ holds the owner's working notes and is not in the public repository, so contract checks run only where it exists.
const hasContract = existsSync(join(config.paths.repoRoot, "ai", "api-contract.md"));

interface WebSource { name: string; src: string; template: string }
/** Every page and component of the web app. `template` is the markup alone: no <script> and no <style>. */
const webSources = (): WebSource[] =>
  ["routes", "components"].flatMap((dir) =>
    readdirSync(join(config.paths.repoRoot, "web", "src", dir))
      .filter((f) => f.endsWith(".svelte"))
      .sort()
      .map((f) => {
        const src = repo("web", "src", dir, f);
        return { name: `${dir}/${f}`, src, template: src.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "") };
      }),
  );
const filesMatching = (re: RegExp) => webSources().filter(({ src }) => re.test(src)).map(({ name }) => name);

// A fee percentage is printed through feeChip / feeLabel, which read the coin's stage, or on a line that says which fee it is.
const PRINTS_FEE = /[fF]eeBps\s*\/\s*100\s*\}\s*%|\{FEE_PCT\}\s*%|\d(?:\.\d+)?%\s+fee\b/;
const QUALIFIED = /feeChip\(|feeLabel\(|on (?:the )?(?:bonding )?curve|curve fee|after (?:the coin )?graduat|rising to about/i;

describe("fee copy", () => {
  test("the web constant is the reviewed one", () => {
    expect(POST_GRADUATION_FEE_MAX_BPS).toBe(REVIEWED_CONFIG.postGraduationFeeMaxBps);
  });

  test("on the curve the fee is a flat 1%; after graduation it is a range that says so", () => {
    expect(feeLabel({ feeBps: 100, stage: "curve" })).toBe("1%");
    expect(feeLabel({ feeBps: 100, stage: "graduated" })).toBe("1%, rising to about 1.2% when trading is volatile");
    expect(feeLabel({ feeBps: 100, stage: "graduated" }, true)).toBe("1-1.2%");
  });

  test("the fee chip of every reviewed tier says which fee it is: flat on the curve, a rising range once graduated", () => {
    // CONFIG-REVIEW-TIERS.md section 1: each graduated pool's fee rises by up to a fifth (1% -> ~1.2%, 2% -> ~2.4%, 4% -> ~4.8%, 6% -> ~7.2%);
    // the 10% tier graduates into the 6% pool. The table is checked against the reviewed tier menu, so a new tier cannot be left out.
    const pool: Record<number, string> = { 100: "1-1.2%", 200: "2-2.4%", 400: "4-4.8%", 600: "6-7.2%", 1000: "6-7.2%" };
    expect(Object.keys(pool).map(Number)).toEqual([...TIER_MENU_BPS]);
    for (const { bps, postGraduationFeeBps } of Object.values(REVIEWED_TIERS)) {
      expect(feeChip({ feeBps: bps, stage: "curve", postGraduationFeeBps })).toBe(`${bps / 100}% fee on curve`);
      expect(feeChip({ feeBps: bps, stage: "graduated", postGraduationFeeBps })).toBe(`${pool[bps]} fee`);
    }
    // without the tier's own pool fee the chip falls back to the curve fee as the base (the 1% pool)
    expect(feeChip({ feeBps: 100, stage: "graduated" })).toBe("1-1.2% fee");
  });

  test("no page or component claims a flat 1% for every trade of a coin's whole life", () => {
    expect(filesMatching(/Every trade on a coin pays a 1% fee/)).toEqual([]);
    expect(filesMatching(/\{coin\.feeBps \/ 100\}%/)).toEqual([]);
    expect(filesMatching(/\{featured\.feeBps \/ 100\}%/)).toEqual([]);
    expect(filesMatching(/\{c\.feeBps \/ 100\}%/)).toEqual([]);
  });

  test("the scan sees the pages and cards it guards", () => {
    const names = webSources().map(({ name }) => name);
    for (const file of ["routes/Home.svelte", "routes/How.svelte", "routes/Launch.svelte", "routes/Coin.svelte", "routes/Treasury.svelte", "components/CoinCard.svelte", "components/FeeSplit.svelte"]) {
      expect(names).toContain(file);
    }
  });

  test("every page that prints a fee percentage prints it with its qualifier", () => {
    const bare: string[] = [];
    let printed = 0;
    for (const { name, template } of webSources()) {
      for (const line of template.split("\n")) {
        if (!PRINTS_FEE.test(line)) continue;
        printed += 1;
        if (!QUALIFIED.test(line)) bare.push(`${name}: ${line.trim()}`);
      }
    }
    expect(printed).toBeGreaterThan(0); // the pattern still finds the fees it guards
    expect(bare).toEqual([]);
  });

  test("the guard catches what it exists for: the bare badge the Explore card and the coin page used to print", () => {
    for (const line of ['<span class="chip">{coin.feeBps / 100}% fee</span>', '<span role="cell" class="num mono v">{coin.feeBps / 100}%</span>', "<p>Every trade pays a 1% fee.</p>"]) {
      expect(PRINTS_FEE.test(line) && !QUALIFIED.test(line)).toBe(true);
    }
    for (const line of ['<span class="chip">{feeChip(coin)}</span>', "<p>{FEE_PCT}% on every buy and sell on the bonding curve.</p>", "<p>It drops to {coin.postGraduationFeeBps / 100}% after graduation.</p>"]) {
      expect(PRINTS_FEE.test(line) && !QUALIFIED.test(line)).toBe(false);
    }
  });

  test("where holders read the fee, it is told as not flat for life: How it works, Treasury, the coin page (its chips and its What is fixed tab) and every card; the Launch form says only 'fixed at launch'", () => {
    for (const file of ["How.svelte", "Treasury.svelte"]) expect(route(file)).toContain("about 1.2%");
    // What is fixed says what the graduated pool charges and that Meteora can change it, from the engine's own numbers
    expect(component("FixedPanel.svelte")).toContain("The Meteora pool charges ${pctText(f.graduatedFee.minBps)}, rising to about ${pctText(f.graduatedFee.maxBps)} when trading is volatile. Meteora can pause that pool or change its fee");
    expect(route("Coin.svelte")).toContain("feeLabel(coin, true)");
    expect(route("Coin.svelte")).toContain("feeChip(coin)");
    expect(component("CoinCard.svelte")).toContain("feeChip(coin)");
    expect(component("CoinCard.svelte")).toContain("feeLabel(coin, true)");
  });

  test("How it works tells holders what their share follows (O-1: the least they held at random checks), and the nav reaches it", () => {
    for (const file of ["How.svelte", "Treasury.svelte"]) expect(route(file)).toMatch(/least you held at random checks/);
    expect(component("Nav.svelte")).toContain("href: '#/how'");
  });

  test.if(hasContract)("the contract describes the same share rule (O-1)", () => {
    expect(repo("ai", "api-contract.md")).toMatch(/MINIMUM balance/);
  });

  test.if(hasContract)("the contract says the same", () => {
    const contract = repo("ai", "api-contract.md");
    expect(contract).toContain("ON THE BONDING CURVE");
    expect(contract).toContain("about 1.2%");
  });
});

describe("fee split copy (owner policy 2026-10-12: Meteora 20%, holders 10%, team 70% of each trade's fee)", () => {
  test("no page or component still says holders get 80%", () => {
    expect(filesMatching(/80% of it goes to holders|Holders 80%|their 80%|holders 80%|HOLDER_PCT = 80/)).toEqual([]);
    expect(repo("web", "src", "lib", "mock", "index.ts")).not.toMatch(/80% of it goes to holders|Holders 80%|their 80%|holders 80%|HOLDER_PCT = 80/);
  });

  test("Launch, How it works, the coin page and the cards say what holders get, and the fee strip shows Meteora 20, holders 60, team 20", () => {
    const launch = route("Launch.svelte");
    expect(launch).toContain("HOLDER_PCT = 10");
    // for an engine with no tier menu the page falls back to HOLDER_PCT; since 2026-10-06 the line under the tier picker says only the fee ("remove the per $100 lines too"),
    // so the holders' part is said by the preview card's "To holders" row below, never by a per-$100 split under the picker
    expect(launch).toContain("holderShareBps: HOLDER_PCT * 100");
    expect(repo("web", "src", "lib", "launch.ts")).not.toContain("Per $100 traded");
    // the picked tier's holders' part is printed by the preview card's "To holders" row, from the tier's own holderShareBps (web/src/lib/launch.ts)
    expect(component("LaunchPreview.svelte")).toContain("{facts.holdersShare}</span> of every fee, in ZEC");
    expect(repo("web", "src", "lib", "launch.ts")).toContain("holdersShare: shareText(t.holderShareBps)");
    expect(route("How.svelte")).toContain("holders still get 0.10% of every trade");
    expect(route("Coin.svelte")).toMatch(/holders get \{coin\.holderShareBps \/ 100\}%|holders' \{coin\.holderShareBps \/ 100\}% of the trading fee/); // the coin page states the holders' share from holderShareBps
    expect(component("CoinCard.svelte")).toMatch(/\{holderPct\}% to holders|pays holders \{holderPct\}% in ZEC/); // the card chip states what holders get, from feeBps x holderShareBps
    // the strip on How it works is drawn from the published policy, one row per owner of the fee
    expect(route("How.svelte")).toContain("sharesFromPolicy(policy)");
    const strip = component("FeeSplit.svelte");
    for (const who of ["Holders", "Team", "Meteora"]) expect(strip).toContain(`who: '${who}'`);
  });

  test("the strip draws Meteora 20, holders 10, team 70 for the policy the engine publishes (engine/src/ledger.ts)", () => {
    const s = sharesFromPolicy({ meteoraShareOfFeeBps: 10_000 - config.solana.dbc.holderShareBps, holdersShareOfClaimedBps: 1_250, teamShareOfClaimedBps: 8_750 });
    expect([s.meteoraBps, s.holdersBps, s.teamBps, s.creatorBps]).toEqual([2000, 1000, 7000, 0]);
    expect(per100(s.feeBps, s.holdersBps)).toBe("$0.10");
  });

  test("the engine's published numbers are the ones the pages say", () => {
    const { holders, team, meteora } = feeSplitBps(config.solana.dbc.holderShareBps, 8750);
    expect([meteora, holders, team]).toEqual([2000, 1000, 7000]);
  });
});

describe("the Zcash <-> Solana links on the shielded page", () => {
  const page = () => repo("web", "src", "routes", "Shielded.svelte");

  test("the guide link is the ZecHub page merged in PR 2245, and the page says plainly which direction each link covers", () => {
    expect(page()).toContain('href="https://zechub.wiki/using-zcash/solana-zec-to-shielded"');
    expect(page()).toContain("Bring ZEC from your Zcash wallet");
    expect(page()).toMatch(/We have not tested that direction/);
    expect(page()).toMatch(/rel="noopener noreferrer"/);
  });

  test("the mint the copy tells people to look for is the real Solana ZEC mint", () => {
    expect(config.solana.dbc.quoteMint.toBase58()).toMatch(/QXaS$/);
    expect(page()).toContain("QXaS");
  });
});

describe("the Launch form's picture and links (contract v2.7)", () => {
  test("a creator picks a picture from the device; the page never asks for a link to one", () => {
    const form = route("Launch.svelte") + component("ImageDrop.svelte");
    expect(form).not.toMatch(/link to an image|image link|type="url"[^>]*image/i);
    expect(form).not.toMatch(/readAsDataURL/);
    expect(component("ImageDrop.svelte")).toContain("Drop an image here, or click to browse");
    expect(component("ImageDrop.svelte")).toContain("PNG, JPG, GIF or WEBP, square looks best, up to 5 MB");
    expect(component("ImageDrop.svelte")).toContain('type="file"');
  });

  test("the 5 MB the page says is the 5 MB the engine takes", () => {
    const web = repo("web", "src", "lib", "upload.ts").match(/export const MAX_UPLOAD_BYTES = (\d+) \* 1024 \* 1024/);
    expect(web).not.toBeNull();
    expect(Number(web![1]) * 1024 * 1024).toBe(MAX_UPLOAD_BYTES);
    expect(MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
    expect(component("ImageDrop.svelte")).toContain("up to 5 MB");
  });

  test("the links are on in every mode: no switch hides them", () => {
    expect(filesMatching(/SOCIALS_ON/)).toEqual([]);
    const form = route("Launch.svelte");
    for (const label of ["Links (optional)", "<span>Website</span>", "<span>X</span>", "<span>Telegram</span>"]) expect(form).toContain(label);
  });

  test("the preview card names its facts, says what is written on chain, and says Locked only through the tier's own numbers", () => {
    const card = component("LaunchPreview.svelte");
    for (const label of ["Paired with", "Trade fee", "To holders", "Graduation", "Liquidity"]) expect(card).toContain(`<dt class="label">${label}</dt>`);
    expect(card).toContain("Name, ticker, image, links and fee are written on chain at launch and cannot be changed after.");
    // "Locked" is a word the card may print only when lib/launch.ts has checked that no liquidity is left unlocked
    expect(card).not.toMatch(/Locked/);
    expect(repo("web", "src", "lib", "launch.ts")).toMatch(/if \(l\.unlockedPct <= 0 && locked >= 100\) return 'Locked for good'/);
  });

  test("every row of the preview card is one fact, in the owner's words (2026-10-05): no sub-line under any row, and what they said is on the pages that carry it", () => {
    const card = component("LaunchPreview.svelte");
    for (const row of [
      "<dd>Solana ZEC</dd>",
      '<span class="mono">{facts.fee}</span>, fixed at launch',
      '<span class="mono">{facts.holdersShare}</span> of every fee, in ZEC',
      '<span class="mono">{facts.creatorShare}</span> of every fee, claimed from your wallet',
      '<span class="mono">{win.parts.cliff}</span> at launch, <span class="mono">{win.parts.end}</span> from second&nbsp;<span class="mono">{win.parts.fromSecond}</span>',
      'When the curve holds <span class="mono">{graduation}</span>',
      "{#if liquidity}{liquidity}",
    ]) expect(card).toContain(row);
    expect(card).not.toMatch(/class="sub"/);
    // the sub-lines that went: the quote mint, the fee after graduation, the holders' dollars, the window's note, "Then it moves to a Meteora pool", the liquidity note
    for (const gone of ["Mint", "After graduation:", "of every <span", "A bot that buys", "Then it moves to a Meteora pool.", "Nobody can withdraw", "each round"]) expect(card).not.toContain(gone);
    expect(card).not.toContain("quoteMint"); // the card is not told the mint any more
  });

  test("the new copy has no middle dot, no unofficial, no anonymous", () => {
    for (const file of ["ImageDrop.svelte", "LaunchPreview.svelte"]) expect(component(file)).not.toMatch(/·|unofficial|fan-made|anonymous/i);
    expect(route("Launch.svelte")).not.toMatch(/·|unofficial|fan-made|anonymous/i);
  });

  test("the coin page shows the creator's links as chips that open in a new tab, with the host of the website and the warning", () => {
    const page = route("Coin.svelte");
    expect(page).toContain('target="_blank" rel="noopener noreferrer"');
    expect(page).toContain("hostOf(l.href)");
    expect(page).toContain("LINKS_WARNING");
    expect(page).toContain(String.raw`/^https:\/\//.test(l.href)`); // nothing but https is ever rendered as a link
  });
});

// ---- the launch window and the Creator wallet (contract v2.8). The numbers the pages print come from the engine's answers or from lib/window.ts, which is checked here against the engine's
// own reviewed window; the words are the build brief's ("Launch window and Creator wallet (2026-10-05)").
describe("the launch window (contract v2.8)", () => {
  // the source without its comment lines: a comment may name `endsAt` to say the page never uses it
  const uncommented = (text: string): string => text.split("\n").filter((l) => !/^\s*(\/\/|\/?\*|<!--)/.test(l)).join("\n");
  const code = (file: string): string => uncommented(repo("web", "src", "lib", file));

  test("the web's own arithmetic of a window equals the engine's reviewed one, for every tier: the same 6 fees by period", () => {
    for (const bps of TIER_MENU_BPS) {
      const engine = windowScheduleOf(bps);
      expect(stepsOf({ cliffBps: engine.cliffBps, endBps: engine.endBps, periods: engine.periods, periodSeconds: engine.periodSeconds })).toEqual(engine.feeByPeriodBps);
    }
  });

  test("How it works prints the 1% tier's window from one constant, and that constant is the engine's reviewed window for that tier", () => {
    const engine = windowScheduleOf(100);
    expect(HOW_EXAMPLE).toEqual({ cliffBps: engine.cliffBps, endBps: engine.endBps, periods: engine.periods, periodSeconds: engine.periodSeconds });
    expect(exampleSteps(HOW_EXAMPLE)).toBe("99%, 79.4%, 59.8%, 40.2%, 20.6%, then 1% from second 5");
    expect(stepsOf(HOW_EXAMPLE)).toEqual(engine.feeByPeriodBps);
    // the prose says "five seconds" and "five equal steps": the reviewed window is 5 steps of 1 second
    expect([REVIEWED_WINDOW.periods, REVIEWED_WINDOW.periodSeconds, REVIEWED_WINDOW.periods * REVIEWED_WINDOW.periodSeconds]).toEqual([5, 1, 5]);
  });

  test("How it works has one section on the window: what it costs, who pays it, what the pages do, the launcher's own first buy, and that it cannot change", () => {
    const how = route("How.svelte");
    expect(how).toContain('<h2 class="h2" id="window-h">The launch window</h2>');
    for (const words of [
      "Every coin's first five seconds cost more.",
      "A trade in the first second pays",
      "and the fee falls in five equal steps to the coin's own fee, which it keeps for good: on the 1% tier",
      "A bot that buys in the launch block pays that fee, and holders get their usual share of it.",
      "The pad's pages hold Buy for those seconds and show a countdown, so a person who waits pays the coin's fee.",
      "The launcher's own first buy, inside the launch transaction, pays the coin's fee.",
      "It is written into the Meteora config and can never change.",
    ]) expect(how).toContain(words);
    expect(how).toContain("exampleSteps(HOW_EXAMPLE)");
    expect(how.indexOf('id="window-h"')).toBeGreaterThan(how.indexOf('id="meteora-h"'));
    expect(how.indexOf('id="window-h"')).toBeLessThan(how.indexOf('id="when-h"'));
    expect(how).toContain("once the launch window below has closed"); // the curve-fee sentence above it stays true
  });

  test("the preview card has the Launch window row between the creator's share and Graduation, read from the tier, with a dash and a skeleton like its neighbours; what a bot pays and what the launcher pays are on How it works and What is fixed, no longer under the row", () => {
    const card = component("LaunchPreview.svelte");
    expect(card).toContain('<dt class="label">Launch window</dt>');
    expect(card.indexOf('<dt class="label">Launch window</dt>')).toBeGreaterThan(card.indexOf('<dt class="label">To you</dt>'));
    expect(card.indexOf('<dt class="label">Launch window</dt>')).toBeLessThan(card.indexOf('<dt class="label">Graduation</dt>'));
    expect(card).toContain("windowRowOfTier(tier)");
    expect(card).toContain("at launch, ");
    expect(card).toContain("from second");
    expect(card).not.toContain("in the first");
    const lib = repo("web", "src", "lib", "launch.ts");
    expect(lib).not.toContain("A bot that buys in the launch block");
    expect(lib).not.toContain("Your own first buy pays");
    expect(route("How.svelte")).toContain("A bot that buys in the launch block pays that fee, and holders get their usual share of it.");
    expect(route("How.svelte")).toContain("The launcher's own first buy, inside the launch transaction, pays the coin's fee.");
    // owner, 2026-10-07 (research/COPY-AUDIT.md): the exception is said inside the Launch window fact itself
    expect(repo("web", "src", "lib", "window.ts")).toContain("The creator's own first buy, inside the launch transaction, pays the coin's fee and not the launch window's.");
    expect(component("FixedPanel.svelte")).toContain("fixedWindowText(f.launchWindow)");
  });

  test("the coin page counts down from the engine's seconds on the page's own monotonic clock, never from endsAt against the visitor's clock; it reads the coin every second while a window is open", () => {
    const page = route("Coin.svelte");
    expect(page).toContain("WINDOW_POLL_MS = 1_000");
    expect(page).toContain("secondsLeft({ secondsLeft: coin.windowSecondsLeft, receivedAtMs: receivedAt }, mono)");
    expect(page).toContain("monoNow()");
    expect(page).toContain("{windowLeft}");
    for (const file of [page, component("BuyBox.svelte"), component("FixedPanel.svelte")]) expect(uncommented(file)).not.toMatch(/endsAt|startsAt/);
    const lib = code("window.ts");
    expect(lib).not.toMatch(/Date\.parse|new Date\(/);
  });

  test("the trade box says the seconds left and the fee now, holds Buy and Sell with the label Wait N s, and says nothing once the window has closed", () => {
    const box = component("BuyBox.svelte");
    expect(box).toContain('role="timer"');
    expect(box).toContain("Launch window: <span");
    expect(box).toContain("{#if windowOpen}");
    expect(box).toContain("windowOpen ? waitLabel(windowLeft)");
    expect(box).toContain("&& !windowOpen)");
    expect(box).not.toMatch(/aria-live[^>]*window|window[^>]*aria-live/); // a ticking region would read out every second
    expect(repo("web", "src", "lib", "window.ts")).toContain("`Wait ${n} s`");
    expect(repo("web", "src", "lib", "window.ts")).toContain("`Launch window: ${p.left} left, fee now ${p.fee}`");
  });

  test("What is fixed carries a Launch window fact with its account, and its sentences stay true: the curve fee is the fee after the window, and the creator's own first buy is the one stated exception", () => {
    const panel = component("FixedPanel.svelte");
    expect(panel).toContain("id: 'launch_window', label: 'Launch window', value: fixedWindowText(f.launchWindow), address: f.launchWindow.source");
    expect(panel).toContain("once the launch window has closed");
    expect(panel).toContain("There are no snipe exemptions, no whitelist and no paid placements on this pad"); // the sentence for a coin on a flat-fee config, which has no exception
    const text = repo("web", "src", "lib", "window.ts");
    // short since 2026-10-07 (owner: "do we need to talk about this too?"): the window, its top fee, that it cannot change, and the creator's exception; the steps are on How it works
    expect(text).toContain("The first ${durationOf(w)} seconds cost more (${bpsText(w.cliffBps)} at first), so bots cannot buy up the launch. It cannot change.");
    expect(text).toContain("The creator's own first buy, inside the launch transaction, pays the coin's fee and not the launch window's.");
  });

  test("the coin page, What is fixed and How it works say the fee is the fee after the window, and only for a coin that has one; the Launch form no longer carries the clause", () => {
    expect(route("Launch.svelte")).not.toContain("once the launch window has closed");
    expect(route("Launch.svelte")).not.toContain("tier.launchWindow");
    expect(route("Coin.svelte")).toContain("<FixedPanel"); // the coin page says it in its Token info tab (the sentence under the stats went, 2026-10-07)
    expect(component("FixedPanel.svelte")).toContain("on the bonding curve${f.launchWindow ? ' once the launch window has closed' : ''}");
    expect(route("How.svelte")).toContain("once the launch window below has closed");
    expect(route("Legal.svelte")).toContain("Buying and selling straight back pays the fee twice"); // the round trip is in the Risk notice only since 2026-10-07
  });

  test("a clause added inside {#if} keeps its space: Svelte drops whitespace at the start of a block, so the words need {' '} (the render once read \"on the curveonce its launch window\")", () => {
    for (const file of [route("Launch.svelte"), route("Coin.svelte"), component("BuyBox.svelte"), component("FixedPanel.svelte"), component("LaunchPreview.svelte")])
      expect(file).not.toMatch(/\{#if [^}]*(launchWindow|creatorWallet|windowOpen|handover)[^}]*\} +(once|Creator|Launch|Wait|Only|I )/);
  });

  test("none of the new copy promises protection or outcomes, and none uses a banned word", () => {
    const files = [route("How.svelte"), route("Launch.svelte"), route("Coin.svelte"), component("BuyBox.svelte"), component("FixedPanel.svelte"), component("LaunchPreview.svelte"), repo("web", "src", "lib", "window.ts"), repo("web", "src", "lib", "creatorWallet.ts"), repo("web", "src", "lib", "launch.ts")];
    for (const f of files) {
      expect(f).not.toMatch(/·|unofficial|fan-made|anonymous/i);
      expect(f).not.toMatch(/protect(s|ed|ion)? (you |holders |buyers )?(from|against) snip/i);
      expect(f).not.toMatch(/\b(yield|dividend)s?\b/i);
    }
    const lib = repo("web", "src", "lib", "window.ts") + repo("web", "src", "lib", "launch.ts");
    expect(lib).not.toMatch(/\breturns\b/i);
  });

  test.if(hasContract)("the contract describes the window, the live numbers and the new error", () => {
    const contract = repo("ai", "api-contract.md");
    for (const word of ["Launch window and Creator wallet", "windowSecondsLeft", "feeNowBps", "launchWindow", "bad_creator_wallet", "Changes in v2.8"]) expect(contract).toContain(word);
  });
});

describe("the Creator wallet on the Launch form (contract v2.8)", () => {
  test("a plain Creator wallet (optional) field sits under First buy and above the Launch button, never folded away, with its helper, the 1% note, the full address, the warning and the tick", () => {
    const form = route("Launch.svelte");
    expect(form).toContain('<div class="creator">');
    // owner, 2026-10-07: a field that cannot be used is not shown; on a tier with no creator share (all of mainnet today) it is left out
    expect(form).toContain('{#if !noShare}\n      <div class="creator">');
    expect(form.indexOf('id="first-buy-l"')).toBeLessThan(form.indexOf('<div class="creator">'));
    expect(form.indexOf('<div class="creator">')).toBeLessThan(form.indexOf('<div class="go">'));
    // the Links section is the one part of the form that folds. The owner's review (2026-10-05) took away the Advanced section that held this one field: nothing hides it now
    expect(form.match(/<details/g)).toHaveLength(1);
    expect(form.indexOf("</details>")).toBeLessThan(form.indexOf('<div class="creator">'));
    expect(form).not.toMatch(/advanced|advOpen/i);
    for (const words of [
      "<span>Creator wallet (optional)</span>",
      "Receives your share of the trading fee. Leave blank to use the connected wallet.",
      "Only this wallet can claim the creator fee, and the launch cannot be undone. Check every character.",
      "I checked this address.",
      "The pad cannot use that wallet as the Creator wallet. Check the address, or leave it blank.",
      "Creator fees go to",
      "only that wallet can claim them.",
    ]) expect(form).toContain(words);
  });

  test("the wallet is sent only when it passed, differs from the launcher's, the tier has a creator share, and the creator ticked; and Launch waits until then", () => {
    const form = route("Launch.svelte");
    expect(form).toContain("...(handover && walletTick ? { creatorWallet: handover } : {})");
    expect(form).toContain("const handover = $derived(creatorCheck.kind === 'ok' && !noShare ? creatorCheck.address : null)");
    expect(form).toContain("const noShare = $derived(tiers === null || (!!tier && tier.creatorShareBps === 0))");
    expect(form).toContain("const creatorOk = $derived(noShare || (creatorCheck.kind !== 'bad' && (handover === null || walletTick)))");
    expect(form).toContain("!creatorOk ||");
    expect(form).toContain("$effect(() => { void walletIn; walletTick = false })"); // the tick belongs to the address it was given for
    expect(form).toContain('<small class="error">{creatorCheck.error}</small>'); // an address that does not pass is seen, in words, right under the field: the reason Launch is held is always on the page
  });

  test("the coin page shows where the creator fee goes only when it is not the launcher and there is a creator fee, and gives the claim to the wallet the chain records", () => {
    const page = route("Coin.svelte");
    expect(page).toContain("coin.creatorWallet !== coin.creator && coin.creatorShareBps > 0 ? coin.creatorWallet : null");
    expect(page).toContain("Creator fees go to <span class=\"mono\" title={payTo}>{short(payTo, 6, 6)}</span>");
    expect(page).toContain("wallet.address === (coin.creatorWallet ?? coin.creator) && coin.creatorShareBps > 0");
  });
});

// Owner reviews of the Launch page, 2026-10-05. First pass: a tier's cost is said as a fact, not as a warning (no box that tells creators their buyers "lose" money, that "fewer people trade" or that
// the curve "fills more slowly", and those words are gone). Second pass: the explainer under the tier picker was "two paragraphs per tier ... it makes us look like we are talking too much", so it is ONE line
// per tier (compared with Pons: "Traders pay 1.00% in total, up to 10% of it yours."; letscash: two short split lines under the picker; pump.fun: no fee prose on the create page). What the old paragraphs
// held and the line no longer says is on the coin page's What is fixed tab and on How it works, and these tests say where.
describe("the fee line under the tier picker: one line per tier, the facts that left it are on the coin page and How it works", () => {
  const SCOLDING = /\b(?:lose|loses|losing|lost)\b|fewer people trade|fills more slowly|high fee is paid/i;
  // the owner's lines, word for word (third pass, 2026-10-06: "remove the per $100 lines too"; who gets what is on the preview card)
  const LINE: Record<number, string> = {
    100: "1% on every trade, paid in ZEC, fixed at launch.",
    200: "2% on every trade, paid in ZEC, fixed at launch.",
    400: "4% on every trade, paid in ZEC, fixed at launch.",
    600: "6% on every trade, paid in ZEC, fixed at launch.",
    1000: "10% on every trade, paid in ZEC, fixed at launch.",
  };

  test("the line for every tier of the menu, built from the engine's own shares, is the owner's line: the 1% one and the 2% one verbatim, then the numbers the page computed before for 4, 6 and 10%", () => {
    expect(Object.keys(LINE).map(Number)).toEqual([...TIER_MENU_BPS]);
    for (const bps of TIER_MENU_BPS) {
      const s = tierShares(bps, config.epoch.team.shareBps);
      const line = feeLineOfTier({ feeBps: bps, creatorShareBps: s.creatorBps, holderShareBps: s.holdersBps, teamShareBps: s.teamBps, meteoraShareBps: s.meteoraBps });
      expect(line.fee + line.rest).toBe(LINE[bps]!);
    }
  });

  test("the form prints that line, once, for a tier of the menu and for an engine with no menu (the 1% line), and nothing keys on the fee but the 10% tick", () => {
    const form = route("Launch.svelte");
    expect(form).toContain('{#if feeLine}<p class="fee-fixed"><span class="mono">{feeLine.fee}</span>{feeLine.rest}</p>{/if}');
    expect(form).toContain("const feeLine = $derived(tier ? feeLineOfTier(tier) : tiers === null ? feeLineOfTier(SNARKS_TIER) : null)");
    expect(form.match(/class="fee-fixed"/g)).toHaveLength(1);
    const snarks = feeLineOfTier({ feeBps: 100, creatorShareBps: 0, holderShareBps: 1000, teamShareBps: 7000, meteoraShareBps: 2000 });
    expect(snarks.fee + snarks.rest).toBe(LINE[100]!);
    expect(form).toContain("const SNARKS_TIER: FeeSplitOfTier = { feeBps: FEE_PCT * 100, creatorShareBps: 0, holderShareBps: HOLDER_PCT * 100, teamShareBps: TEAM_PCT * 100, meteoraShareBps: (100 - HOLDER_PCT - TEAM_PCT) * 100 }");
    expect(form).not.toContain("HIGH_FEE_BPS");
    expect(form).not.toMatch(/class="warn" role="note">A high fee/);
  });

  test("the form carries none of what the old paragraphs said: the round-trip sentence, the launch-window clause, the graduated pool's fee, Meteora's hand in it, the delivery cost, wallet-to-wallet sends", () => {
    const form = route("Launch.svelte");
    for (const words of [
      "Buyers and sellers pay",
      "once the launch window has closed",
      "The curve fee is paid in ZEC. It is set when you launch and can never change.",
      "After the coin graduates it trades in a Meteora pool",
      "Meteora runs that pool and can pause it or change its fee",
      "pays the cost of shielded delivery first",
      "Wallet-to-wallet sends pay no fee",
      "rising to about 1.2%",
      "Meteora keeps 20%",
    ]) expect([words, form.includes(words)]).toEqual([words, false]);
    // not even the 10% tier's tick says what a buy and an immediate sell costs any more (owner review 2026-10-05, after the third pass): it is built like the line, lib/launch.ts confirmLineOfTier
    expect(form).not.toContain("immediate sell");
    // the tile of the tier whose pool charges less keeps its sub-label (10% reads "drops to 6% after graduation")
    expect(form).toContain("drops to ${t.postGraduationFeeBps / 100}% after graduation");
  });

  test("each fact that left the form is on the coin page's What is fixed tab or on How it works: the round trip (the coin's own tier, and every tier), the graduated pool's fee and that Meteora runs it, the team's share paying delivery first, wallet-to-wallet sends, the launch window", () => {
    const fixed = component("FixedPanel.svelte");
    const how = route("How.svelte");
    const legal = route("Legal.svelte");
    // owner, 2026-10-07 (research/COPY-AUDIT.md): the round trip is in the Risk notice only; the graduated pool's fee and that Meteora runs it stay on
    // Token info and How it works; who pays for shielded delivery first is in the Terms
    expect(legal).toContain("Buying and selling straight back pays the fee twice");
    expect(fixed).toContain("The Meteora pool charges ${pctText(f.graduatedFee.minBps)}");
    expect(how).toContain("After graduation the pool is Meteora's: Meteora can pause it or change its fee.");
    expect(how).toContain("1% rises to about 1.2%");
    expect(legal).toContain("The cost of delivering shielded rewards is paid from the team's share first");
    // the launch window: a fact and its own section
    expect(fixed).toContain("id: 'launch_window', label: 'Launch window'");
    expect(how).toContain('<h2 class="h2" id="window-h">The launch window</h2>');
  });

  test("the numbers on those pages are the engine's: the web's list of tiers is the menu, the cost of a round trip is worked out the engine's way, and How it works prints all five", () => {
    expect([...TIER_FEES_BPS]).toEqual([...TIER_MENU_BPS]);
    for (const bps of TIER_MENU_BPS) expect(webRoundTripCostBps(bps)).toBe(roundTripCostBps(bps));
    expect(roundTripByTier().map((r) => r.cost)).toEqual(TIER_MENU_BPS.map((bps) => roundTripPer100(roundTripCostBps(bps))));
    expect(roundTripByTier()).toEqual([
      { tier: "1%", cost: "$1.99" }, { tier: "2%", cost: "$3.96" }, { tier: "4%", cost: "$7.84" }, { tier: "6%", cost: "$11.64" }, { tier: "10%", cost: "$19.00" },
    ]);
  });

  test("the Launch form and its preview never say what buyers lose, that fewer people trade, or that the curve fills more slowly", () => {
    for (const [name, text] of [
      ["routes/Launch.svelte", route("Launch.svelte")],
      ["components/LaunchPreview.svelte", component("LaunchPreview.svelte")],
      ["components/ImageDrop.svelte", component("ImageDrop.svelte")],
      ["lib/launch.ts", repo("web", "src", "lib", "launch.ts")],
    ] as const) expect([name, SCOLDING.exec(text)?.[0] ?? null]).toEqual([name, null]);
    expect(SCOLDING.test("Someone who buys and then sells straight back loses about $7.84 of every $100, so fewer people trade and the curve fills more slowly.")).toBe(true); // the guard catches the old words
  });

  test("the 10% tier still asks a second time, in the line's own shape and without the cost of a round trip, and no other tier asks", () => {
    const form = route("Launch.svelte");
    expect(form).toContain("const CONFIRM_FEE_BPS = 1000");
    expect(form).toContain("{#if tier && tier.feeBps >= CONFIRM_FEE_BPS}");
    expect(form).toContain("<span>{confirmLineOfTier(tier)}</span>");
    expect(form).not.toContain("roundTripPer100");
    expect(form).toContain("(feeTier < CONFIRM_FEE_BPS || understood)");
    // the line is built from the engine's own tiers: the fee, on every trade, fixed at launch; the pool's lower fee only on the tier that has one, in three words
    for (const bps of TIER_MENU_BPS) {
      const line = confirmLineOfTier({ feeBps: bps, postGraduationFeeBps: REVIEWED_TIERS[bps]!.postGraduationFeeBps });
      expect(line.startsWith(`I understand: ${bps / 100}% on every trade, fixed at launch`)).toBe(true);
      expect(line).not.toMatch(/immediate|sell|round trip|of every|\$/i);
      expect(line.endsWith(" after graduation.")).toBe(REVIEWED_TIERS[bps]!.postGraduationFeeBps < bps);
    }
    expect(confirmLineOfTier({ feeBps: 1000, postGraduationFeeBps: REVIEWED_TIERS[1000]!.postGraduationFeeBps })).toBe("I understand: 10% on every trade, fixed at launch, 6% after graduation.");
  });

  test("the numbers it prints are the engine's, tier by tier: what a buy and an immediate sell costs, and four parts that add up to the fee on every $100", () => {
    expect(TIER_MENU_BPS.map((bps) => roundTripPer100(roundTripCostBps(bps)))).toEqual(["$1.99", "$3.96", "$7.84", "$11.64", "$19.00"]);
    for (const bps of TIER_MENU_BPS) {
      const s = tierShares(bps, config.epoch.team.shareBps);
      const printed = [s.creatorBps, s.holdersBps, s.teamBps, s.meteoraBps].map((share) => per100(bps, share));
      // in thousandths of a dollar, as per100 prints them: a 4% fee is $4.000 of every $100
      expect(printed.reduce((sum, text) => sum + Math.round(Number(text.slice(1)) * 1000), 0)).toBe(bps * 10);
    }
    const four = tierShares(400, config.epoch.team.shareBps);
    expect([four.creatorBps, four.holdersBps, four.teamBps, four.meteoraBps].map((share) => per100(400, share))).toEqual(["$2.40", "$0.10", "$0.70", "$0.80"]);
  });
});
