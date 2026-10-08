// Pure checks of the proposal decoder (no chain): what the owner is shown, and
// what the keeper refuses to execute (PORT-ASSUMPTIONS Q6, Q7, Q11).
import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as sqds from "@sqds/multisig";
import { KEEPER_PERMISSIONS, fingerprint, decodeClaimReceivers, multisigShapeProblems, resolveInstructions } from "../src/dbc/squads";

describe("decodeClaimReceivers", () => {
  test("an instruction that is not one of the pad's claim instructions is reported as unknown, never as a receiver", () => {
    const ix = SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000_000 });
    const { receivers, unknown } = decodeClaimReceivers(resolveInstructions([ix]));
    expect(receivers).toEqual([]);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain(SystemProgram.programId.toBase58());
  });

  test("a Meteora program id with a claim-looking but different instruction is unknown too", () => {
    const resolved = [{ programId: SystemProgram.programId, accounts: [Keypair.generate().publicKey], data: Buffer.from("claim_trading_fee") }];
    expect(decodeClaimReceivers(resolved).unknown).toHaveLength(1);
  });
});

describe("fingerprint", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const base = { programId: SystemProgram.programId, accounts: [a, b], data: Buffer.from([1, 2, 3]) };

  test("is stable for the same instruction and changes with any account, program or data byte", () => {
    const f = fingerprint([base]);
    expect(fingerprint([{ ...base }])).toBe(f);
    expect(fingerprint([{ ...base, accounts: [a, Keypair.generate().publicKey] }])).not.toBe(f); // a swapped receiver
    expect(fingerprint([{ ...base, data: Buffer.from([1, 2, 4]) }])).not.toBe(f);
    expect(fingerprint([{ ...base, programId: Keypair.generate().publicKey }])).not.toBe(f);
    expect(fingerprint([base, base])).not.toBe(f); // an extra instruction smuggled in
  });
});

describe("multisigShapeProblems (audit/CONFIG-REVIEW.md, Squads section)", () => {
  const keeper = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const backup = Keypair.generate().publicKey;
  const all = sqds.types.Permissions.all();
  const reviewed = {
    members: [{ key: owner, permissions: all }, { key: backup, permissions: all }, { key: keeper, permissions: KEEPER_PERMISSIONS }],
    threshold: 2, configAuthority: PublicKey.default, rentCollector: keeper,
  } as unknown as Parameters<typeof multisigShapeProblems>[0];

  test("the reviewed setup passes: keeper Initiate+Vote+Execute, threshold 2, autonomous, keeper collects proposal rent", () => {
    expect(multisigShapeProblems(reviewed, keeper)).toEqual([]);
  });

  test.each([
    ["a controlled multisig (one key can change members with no vote)", { configAuthority: owner }, /config authority/],
    ["proposal rent refunded to someone other than the keeper", { rentCollector: owner }, /rent collector/],
    ["rent reclamation switched off", { rentCollector: null }, /rent collector/],
    ["threshold 1", { threshold: 1 }, /threshold/],
    ["a keeper without Vote", { members: [{ key: keeper, permissions: sqds.types.Permissions.fromPermissions([sqds.types.Permission.Initiate, sqds.types.Permission.Execute]) }] }, /Initiate\+Vote\+Execute/],
  ])("refuses %s", (_label, over, pattern) => {
    const problems = multisigShapeProblems({ ...reviewed, ...over } as typeof reviewed, keeper);
    expect(problems.some((m) => pattern.test(m))).toBe(true);
  });
});
