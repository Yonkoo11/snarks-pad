// A picture made from a wallet address, with no outside service and nothing stored: the same address always gives the same picture. A 5 x 5 grid of cells, mirrored
// left to right, taken from the 32 bytes of the key, and a hue (the same recipe the coin letter tiles use) from two more bytes. A person's wallet is not a face or a
// name, so the picture says only "this address" and is never mistaken for a profile photo.
import bs58 from 'bs58'

const SIZE = 5
const HALF = 3 // the left three columns; the right two are their mirror
/** A byte below this fills its cell: a little over half of them. */
const FILL_BELOW = 140
/** Fewer filled cells than this among the 15 that are drawn once (the left three columns) and the centre column is filled, so no address gives an empty picture. */
const MIN_FILLED = 6

export interface WalletMark {
  /** 0 to 359: the tile's tint. */
  hue: number
  /** SIZE x SIZE cells, row by row, true where the cell is filled. */
  cells: boolean[]
  size: number
}

/** The key's 32 bytes; for text that is not an address (never a real page), 32 bytes made from its characters so the function still answers. */
function bytesOf(address: string): Uint8Array {
  try {
    const bytes = bs58.decode(address)
    if (bytes.length === 32) return bytes
  } catch { /* not base58: fall through */ }
  const out = new Uint8Array(32)
  for (let i = 0; i < address.length; i++) out[i % 32] = (out[i % 32] * 31 + address.charCodeAt(i)) & 255
  return out
}

export function walletMark(address: string): WalletMark {
  const bytes = bytesOf(address)
  const half = Array.from({ length: SIZE * HALF }, (_, i) => bytes[i] < FILL_BELOW)
  if (half.filter(Boolean).length < MIN_FILLED) for (let row = 0; row < SIZE; row++) half[row * HALF + (HALF - 1)] = true
  const cells = Array.from({ length: SIZE * SIZE }, (_, i) => {
    const row = Math.floor(i / SIZE)
    const col = i % SIZE
    return half[row * HALF + (col < HALF ? col : SIZE - 1 - col)]
  })
  return { hue: ((bytes[30] << 8) | bytes[31]) % 360, cells, size: SIZE }
}
