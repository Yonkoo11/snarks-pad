import { describe, expect, test } from 'bun:test'
import { parseLayerKey, dossierKey, dossierMint, dossierTab, walletKey, walletParts } from '../src/lib/layerKeys'
import { tornClip } from '../src/lib/torn'

const MINT = 'DhZPXBgZ2djguHoTcMByoHxFFQcaR1e1KyKx6gL8uybA'

describe('layer keys', () => {
  test('a dossier key round-trips its mint and tab', () => {
    const k = dossierKey(MINT, 'holders')
    expect(k).toBe(`dossier:${MINT}:holders`)
    expect(dossierMint(k)).toBe(MINT)
    expect(dossierTab(k)).toBe('holders')
    expect(parseLayerKey(k)?.kind).toBe('dossier')
  })
  test('a dossier without a tab opens on trades', () => {
    expect(parseLayerKey(`dossier:${MINT}`)?.key).toBe(`dossier:${MINT}:trades`)
  })
  test('compare and tape are layers of their own', () => {
    expect(parseLayerKey('compare')?.kind).toBe('compare')
    expect(parseLayerKey('tape')?.kind).toBe('tape')
  })
  test('a wallet layer names a wallet and the coin it is looked at in', () => {
    const k = walletKey(MINT, MINT)
    expect(parseLayerKey(k)?.kind).toBe('wallet')
    expect(walletParts(k)).toEqual({ wallet: MINT, mint: MINT })
    expect(parseLayerKey('wallet:short:short')).toBeNull()
  })
  test('anything else is no layer: a mistyped link opens nothing', () => {
    expect(parseLayerKey(null)).toBeNull()
    expect(parseLayerKey('')).toBeNull()
    expect(parseLayerKey('dossier:not-a-mint:trades')).toBeNull()
    expect(parseLayerKey(`dossier:${MINT}:secrets`)).toBeNull()
    expect(parseLayerKey('<script>')).toBeNull()
  })
})

describe('torn edge', () => {
  test('the same seed tears the same edge', () => {
    expect(tornClip(3, 'left')).toBe(tornClip(3, 'left'))
    expect(tornClip(3, 'left')).not.toBe(tornClip(4, 'left'))
  })
  test('the tear stays within a few pixels of the edge', () => {
    const pts = tornClip(9, 'left', 46, 0.9).slice('polygon('.length, -1).split(', ')
    for (const p of pts.slice(2)) expect(Number.parseFloat(p)).toBeLessThanOrEqual(0.9)
    expect(pts.length).toBe(2 + 47)
  })
})
