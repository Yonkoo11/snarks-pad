// The Creator wallet field's judgement (src/lib/creatorWallet.ts, contract v2.8): what a person typed becomes the one address the launch hands the pool to, or a plain reason why not.
// After the handover only that wallet can claim the creator's fee, so a value that cannot sign (a program's or a token account's address) or is not an address at all must never reach the
// launch. The engine checks the same value again and also refuses the pad's own wallets (engine/test/api-hostile.test.ts).
import { describe, expect, test } from 'bun:test'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { NOT_AN_ADDRESS, OFF_CURVE, SAME_WALLET, checkCreatorWallet } from '../src/lib/creatorWallet'

const wallet = () => Keypair.generate().publicKey.toBase58()
const connected = wallet()
const pda = PublicKey.findProgramAddressSync([Buffer.from('snarks-test-pda')], SystemProgram.programId)[0].toBase58()

describe('nothing typed', () => {
  test('blank, spaces and a newline mean the connected wallet stays the creator', () => {
    for (const v of ['', ' ', '   ', '\n', '\t ']) expect(checkCreatorWallet(v, connected)).toEqual({ kind: 'none' })
    expect(checkCreatorWallet('', null)).toEqual({ kind: 'none' })
  })
})

describe('a wallet that can take the pool', () => {
  test('another real wallet passes and comes back as the address to hand the pool to', () => {
    const w = wallet()
    expect(checkCreatorWallet(w, connected)).toEqual({ kind: 'ok', address: w })
  })
  test('with no wallet connected yet, any real wallet passes', () => {
    const w = wallet()
    expect(checkCreatorWallet(w, null)).toEqual({ kind: 'ok', address: w })
  })
  test('spaces around a pasted address are dropped, so what is shown back and sent is the address alone', () => {
    const w = wallet()
    expect(checkCreatorWallet(`  ${w}\n`, connected)).toEqual({ kind: 'ok', address: w })
  })
})

describe('the connected wallet typed again', () => {
  test('there is nothing to hand over', () => {
    expect(checkCreatorWallet(connected, connected)).toEqual({ kind: 'same' })
    expect(checkCreatorWallet(` ${connected} `, connected)).toEqual({ kind: 'same' })
    expect(SAME_WALLET).toBe('Same as your connected wallet: nothing to hand over.')
  })
})

describe('what is not an address', () => {
  const good = wallet()
  test.each([
    ['letters that are not an address', 'abc'],
    ['the wrong alphabet (0, O, I and l are not in it)', '0'.repeat(44)],
    ['half an address', good.slice(0, 22)],
    ['five characters short', good.slice(5)], // 39 characters or fewer cannot hold 32 bytes, whichever address they came from
    ['too long', good + good.slice(0, 3)],
    ['a hex string', '0x' + 'ab'.repeat(20)],
    ['a Zcash address', 'u1' + 'q'.repeat(100)],
    ['an address with a space inside', `${good.slice(0, 10)} ${good.slice(10)}`],
    ['a link', 'https://explorer.solana.com/address/' + good],
    ['44 ones (44 zero bytes)', '1'.repeat(44)],
  ])('%s is refused in plain words', (_label, value) => {
    expect(checkCreatorWallet(value, connected)).toEqual({ kind: 'bad', error: NOT_AN_ADDRESS })
  })
})

describe('what the check cannot see', () => {
  // A base58 address has no checksum, so an address with one character cut off is sometimes ANOTHER valid address. The check cannot tell, which is why the form shows the whole
  // address back and asks for a tick (flow-check.cjs walks that); this test keeps that reason written down, and fails if a change ever makes it untrue.
  test('one character cut off the front of an address can still be a different, valid wallet', () => {
    let found: string | null = null
    for (let i = 0; i < 400 && found === null; i++) {
      const w = wallet()
      if (checkCreatorWallet(w.slice(1), connected).kind === 'ok') found = w
    }
    expect(found).not.toBeNull()
    const cut = checkCreatorWallet(found!.slice(1), connected)
    expect(cut.kind === 'ok' && cut.address !== found).toBe(true)
  })
})

describe('an address that cannot sign', () => {
  test('a program-derived address is refused: nobody can sign for it, so the creator fee would sit there for good', () => {
    expect(PublicKey.isOnCurve(new PublicKey(pda).toBytes())).toBe(false)
    expect(checkCreatorWallet(pda, connected)).toEqual({ kind: 'bad', error: OFF_CURVE })
  })
  test('a token account is refused: it belongs to a wallet, not the wallet itself', () => {
    const tokenAccount = PublicKey.findProgramAddressSync([new PublicKey(connected).toBytes(), new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes(), Keypair.generate().publicKey.toBytes()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0].toBase58()
    expect(checkCreatorWallet(tokenAccount, connected)).toEqual({ kind: 'bad', error: OFF_CURVE })
  })
  test('the words say what to do', () => {
    expect(OFF_CURVE).toBe('That address belongs to a program or a token account, which cannot sign. Use a wallet address.')
    expect(NOT_AN_ADDRESS).toBe('That is not a wallet address. A Solana address is 32 to 44 letters and digits.')
  })
})

describe('the words are clean', () => {
  test('no em dash, middle dot or banned word', () => {
    expect([NOT_AN_ADDRESS, OFF_CURVE, SAME_WALLET].join('\n')).not.toMatch(/—|·|anonymous|yield|dividend|returns|unofficial/i)
  })
})
