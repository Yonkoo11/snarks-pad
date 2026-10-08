// GET /api/epochs.csv and the top-level deliveryCostZats / teamNetZats of GET /api/epochs docs/API.md v2.6. The CSV is checked
// against the JSON route row by row (they are built from the same helpers, so they must agree), for public columns only, for
// cells a spreadsheet could run as formulas, and for numbers that are not known yet.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { clearStatsCache, handleRequest } from "../src/api";
import * as db from "../src/db";
import { EPOCH_CSV_COLUMNS, csvCell, epochsCsv } from "../src/epochsCsv";

const run = crypto.randomUUID().slice(0, 8);
const ids: string[] = [];
const key = () => Keypair.generate().publicKey.toBase58();
let clock = Date.parse("2026-08-01T00:00:00.000Z");

function epoch(o: { id?: string; status?: db.EpochStatus; resolve?: boolean; reserve?: bigint; shielded?: [string, bigint][]; solana?: [string, bigint][]; snapshot?: boolean; fee?: string } = {}): string {
  const id = o.id ?? `epoch-csv-${run}-${ids.length}`;
  ids.push(id);
  const at = new Date((clock += 60_000)).toISOString();
  db.upsertEpoch({
    id, at, coinMints: JSON.stringify([key(), key()]), harvestedZats: "1000000", feeZats: o.fee ?? "10000", status: o.status ?? "ok",
    swapProvider: null, swapRef: null, swapState: "settled", swapAmountOutZats: null, zcashTxids: "[]",
  });
  db.setEpochTeamSplit(id, 250_000n, o.reserve ?? (o.resolve ? 50_000n : 0n)); // a reserve means a swap to wait for; none resolves at once
  if (o.resolve) db.resolveEpochDelivery(id, { deliveryCost: 40_000n, teamNative: 10_000n, teamSolana: 200_000n, holderShortfall: 0n });
  for (const [w, z] of o.solana ?? []) { db.planPayout({ epochId: id, wallet: w, kind: "solana", amountZats: z.toString() }); db.markPayoutSent(id, w, "solana", `sig-${id}`); }
  for (const [w, z] of o.shielded ?? []) { db.planPayout({ epochId: id, wallet: w, kind: "shielded", amountZats: z.toString(), zcashAddress: "uregtest1recognisableaddress0123456789" }); db.markPayoutSent(id, w, "shielded", "c".repeat(64)); }
  if (o.snapshot !== false) {
    db.insertEpochSnapshot(id, "{}\n", "ab".repeat(32), []);
    db.markSnapshotMemoPending(id, `memo-${id}`, "raw", 1);
    db.markSnapshotMemoLanded(id);
  }
  return id;
}

afterAll(() => {
  const d = db.getDb();
  for (const id of ids) for (const t of ["epochs", "payouts", "epoch_snapshots"]) d.query(`DELETE FROM ${t} WHERE ${t === "epochs" ? "id" : "epochId"} = $id`).run({ $id: id });
});

beforeEach(() => clearStatsCache());

/** A small RFC 4180 reader, so the file is checked the way a spreadsheet would split it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  return rows;
}

const getCsv = async () => {
  const res = await handleRequest(new Request("http://pad.test/api/epochs.csv"));
  return { res, text: await res.text() };
};
const getJson = async () => ((await (await handleRequest(new Request("http://pad.test/api/epochs"))).json()) as { epochs: any[] }).epochs;

describe("GET /api/epochs.csv", () => {
  test("answers a CSV file with the public headers, and only for GET", async () => {
    const { res, text } = await getCsv();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="snarks-epochs.csv"');
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-pad-mode")).toBeTruthy();
    expect(text.split("\n")[0]).toBe("epochId,at,status,coinMints,claimedZats,holdersZats,teamZats,deliveryCostZats,teamNetZats,holderShortfallZats,zcashNetworkFeeZats,solanaPayoutCount,solanaPayoutZats,shieldedCount,shieldedZats,snapshotSha256,snapshotMemoSig");
    expect(text.split("\n")[0]).toBe(EPOCH_CSV_COLUMNS.join(","));
    expect(text.endsWith("\n")).toBe(true);
    expect((await handleRequest(new Request("http://pad.test/api/epochs.csv", { method: "POST", body: "x" }))).status).toBe(404);
    expect((await handleRequest(new Request("http://pad.test/api/epochs.csv/extra"))).status).toBe(404);
  });

  test("one row per published round, newest first, every cell the same number GET /epochs reports", async () => {
    const a = epoch({ solana: [[key(), 111_111n], [key(), 222_222n]], shielded: [[key(), 333_333n]], resolve: true });
    const b = epoch({ solana: [[key(), 444_444n]] });
    clearStatsCache();
    const { text } = await getCsv();
    const rows = parseCsv(text);
    const header = rows[0]!;
    const byId = new Map(rows.slice(1).map((r) => [r[0]!, Object.fromEntries(header.map((h, i) => [h, r[i]!]))]));
    const json = await getJson();
    expect(rows.length - 1).toBe(json.length);
    expect(rows.slice(1).map((r) => r[0])).toEqual(json.map((e) => e.id)); // same order: newest first
    for (const e of json) {
      const r = byId.get(e.id)!;
      expect(r).toMatchObject({
        at: e.at, status: e.status, coinMints: e.coinMints.join(";"), claimedZats: e.harvestedZats, holdersZats: e.split.holdersZats, teamZats: e.split.teamZats,
        deliveryCostZats: e.split.deliveryCostZats ?? "", teamNetZats: e.split.teamNetZats ?? "", holderShortfallZats: e.split.holderShortfallZats, zcashNetworkFeeZats: e.feeZats,
        solanaPayoutCount: String(e.solanaPayouts.count), solanaPayoutZats: e.solanaPayouts.totalZats, shieldedCount: String(e.shielded.count), shieldedZats: e.shielded.totalZats,
        snapshotSha256: e.snapshot?.sha256 ?? "", snapshotMemoSig: e.snapshot?.memoSig ?? "",
      });
    }
    expect(byId.get(a)).toMatchObject({ solanaPayoutCount: "2", solanaPayoutZats: "333333", shieldedCount: "1", shieldedZats: "333333", deliveryCostZats: "40000", teamNetZats: "210000" });
    expect(byId.get(b)).toMatchObject({ solanaPayoutCount: "1", solanaPayoutZats: "444444", shieldedCount: "0", shieldedZats: "0" });
    expect(byId.get(a)!.snapshotMemoSig).toBe(`memo-${a}`);
  });

  test("a number that is not known yet is an empty cell: the delivery numbers before the swap is resolved, the snapshot columns before snapshots", async () => {
    const unresolved = epoch({ reserve: 50_000n, snapshot: false });
    clearStatsCache();
    const rows = parseCsv((await getCsv()).text);
    const header = rows[0]!;
    const r = rows.find((x) => x[0] === unresolved)!;
    const cell = (h: string) => r[header.indexOf(h)];
    expect([cell("deliveryCostZats"), cell("teamNetZats"), cell("snapshotSha256"), cell("snapshotMemoSig")]).toEqual(["", "", "", ""]);
    expect(cell("teamZats")).toBe("250000"); // what is known is there
  });

  test("a draft round is not published: it is not a row", async () => {
    const draft = epoch({ status: "harvesting" });
    clearStatsCache();
    expect((await getCsv()).text).not.toContain(draft);
  });

  test("public numbers only: no wallet, no Zcash address, no per-recipient amount, no batch transaction id", async () => {
    const [w1, w2, w3, w4] = [key(), key(), key(), key()];
    const id = epoch({ solana: [[w1, 987_654n], [w4, 555_551n]], shielded: [[w2, 123_457n], [w3, 222_223n]] });
    clearStatsCache();
    const { text } = await getCsv();
    for (const secret of [w1, w2, w3, w4, "uregtest1", "c".repeat(64)]) expect(text).not.toContain(secret);
    const row = text.split("\n").find((l) => l.startsWith(id))!;
    for (const amount of ["987654", "555551", "123457", "222223"]) expect(row).not.toContain(amount); // only the totals are there
    expect(row).toContain("1543205"); // 987,654 + 555,551 on Solana
    expect(row).toContain("345680"); // 123,457 + 222,223 shielded
  });

  test("an id that holds a comma, a quote or a line break is quoted and splits back to the same text; one that a spreadsheet would run as a formula gets a leading quote mark", async () => {
    const tricky = epoch({ id: `epoch-"x",y\nz-${run}` });
    const formula = epoch({ id: `=HYPERLINK("http://evil.example","x")-${run}` });
    const plus = epoch({ id: `+cmd|' /C calc'!A0-${run}` });
    const at = epoch({ id: `@SUM(1+1)-${run}` });
    clearStatsCache();
    const text = (await getCsv()).text;
    const rows = parseCsv(text);
    const col0 = rows.map((r) => r[0]);
    expect(col0).toContain(`epoch-"x",y\nz-${run}`);
    expect(tricky).toBeTruthy();
    for (const id of [formula, plus, at]) expect(col0).toContain(`'${id}`);
    expect(col0.some((c) => c !== undefined && /^[=+\-@\t\r]/.test(c))).toBe(false); // no cell starts like a formula
    for (const r of rows) expect(r.length).toBe(EPOCH_CSV_COLUMNS.length);
  });

  test("is built from the same few-second cache as /stats: a round recorded after the first read shows once it is forgotten, and not before", async () => {
    await getCsv();
    const id = epoch();
    expect((await getCsv()).text).not.toContain(id);
    clearStatsCache();
    expect((await getCsv()).text).toContain(id);
  });
});

describe("csvCell", () => {
  test("plain text and numbers are bare; null is empty; negative numbers stay numbers", () => {
    expect([csvCell("epoch-1"), csvCell(0), csvCell(12345), csvCell(null), csvCell("-5"), csvCell("2026-10-04T00:00:00.000Z")]).toEqual(["epoch-1", "0", "12345", "", "-5", "2026-10-04T00:00:00.000Z"]);
  });
  test("quotes what needs it and doubles the quotes", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\rb")).toBe('"a\rb"');
  });
  test("a leading = + - @ tab or carriage return is neutralised with a quote mark", () => {
    for (const c of ["=1+1", "+1", "-1+1", "@x", "\tx", "\rx"]) expect(csvCell(c).replace(/^"/, "").startsWith("'")).toBe(true);
  });
  test("the CSV of nothing is the header alone", () => {
    expect(epochsCsv([])).toBe(`${EPOCH_CSV_COLUMNS.join(",")}\n`);
  });
});

describe("GET /api/epochs: the delivery numbers at the top level", () => {
  test("deliveryCostZats and teamNetZats are on every epoch as well as in split, the same values, null together until the swap is resolved", async () => {
    const resolved = epoch({ resolve: true });
    const open = epoch({ reserve: 70_000n });
    const plain = epoch();
    const json = await getJson();
    for (const e of json) {
      expect(e.deliveryCostZats).toEqual(e.split.deliveryCostZats);
      expect(e.teamNetZats).toEqual(e.split.teamNetZats);
    }
    const by = (id: string) => json.find((e) => e.id === id);
    expect([by(resolved).deliveryCostZats, by(resolved).teamNetZats]).toEqual(["40000", "210000"]);
    expect([by(open).deliveryCostZats, by(open).teamNetZats]).toEqual([null, null]);
    expect([by(plain).deliveryCostZats, by(plain).teamNetZats]).toEqual(["0", "250000"]); // no shielded batch: nothing cost, the whole share is the team's
  });
});
