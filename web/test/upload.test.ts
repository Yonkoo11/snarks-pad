// The picture picker (src/lib/upload.ts): what the Launch page lets through to the engine, and the words it says when it does not. The page looks
// at the first bytes of a file, never at its name or the type the browser claims; the engine looks again (engine/test/uploads.test.ts).
import { describe, expect, test } from 'bun:test'
import { MAX_UPLOAD_BYTES, PICK_TEXT, canRetry, pickFile, problemWith, sizeText, sniffImage, uploadErrorText } from '../src/lib/upload'

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46])
const WEBP = Uint8Array.from([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')])
const GIF89 = ascii('GIF89a\x01\x00\x01\x00')

describe('sniffImage: the first bytes say what a file is', () => {
  test('PNG, JPEG, WEBP and both GIF versions are pictures', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(JPG)).toBe('jpg')
    expect(sniffImage(WEBP)).toBe('webp')
    expect(sniffImage(GIF89)).toBe('gif')
    expect(sniffImage(ascii('GIF87a\x01\x00'))).toBe('gif')
  })

  test('an SVG, an HTML page, a PDF, a WAV and a script are not, whatever they are called', () => {
    for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"></svg>', '<!doctype html><title>x</title>', '%PDF-1.7\n', 'alert(1)', '<?xml version="1.0"?><svg/>']) {
      expect(sniffImage(ascii(text))).toBeNull()
    }
    expect(sniffImage(Uint8Array.from([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVEfmt ')]))).toBeNull()
  })

  test('nothing, and a signature cut short, are not pictures', () => {
    expect(sniffImage(new Uint8Array(0))).toBeNull()
    expect(sniffImage(PNG.slice(0, 7))).toBeNull()
    expect(sniffImage(JPG.slice(0, 2))).toBeNull()
    expect(sniffImage(WEBP.slice(0, 11))).toBeNull()
    expect(sniffImage(ascii('GIF8'))).toBeNull()
  })
})

describe('problemWith: size first, then the first bytes', () => {
  test('a small PNG and a JPEG pass', async () => {
    expect(await problemWith(new Blob([PNG]))).toBeNull()
    expect(await problemWith(new Blob([JPG]))).toBeNull()
  })

  test('a file that is not a picture is refused with the picture words', async () => {
    expect(await problemWith(new Blob([ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>')], { type: 'image/png' }))).toBe('not_image')
    expect(await problemWith(new Blob([]))).toBe('not_image')
  })

  test('5 MB is the most; one byte more is too big, even for a real PNG', async () => {
    const atLimit = new Uint8Array(MAX_UPLOAD_BYTES)
    atLimit.set(PNG)
    expect(await problemWith(new Blob([atLimit]))).toBeNull()
    const over = new Uint8Array(MAX_UPLOAD_BYTES + 1)
    over.set(PNG)
    expect(await problemWith(new Blob([over]))).toBe('too_big')
  })
})

describe('the words a creator reads', () => {
  test('an engine refusal and a network failure are told in plain words, never as a code', () => {
    expect(uploadErrorText({ code: 'bad_image' })).toBe(PICK_TEXT.not_image)
    expect(uploadErrorText({ code: 'body_too_large' })).toBe(PICK_TEXT.too_big)
    expect(uploadErrorText({ code: 'rate_limited' })).toMatch(/Too many uploads/)
    expect(uploadErrorText({ code: 'busy' })).toMatch(/Too many uploads/)
    for (const e of [{ code: 'internal_error' }, { code: 'unreachable' }, new Error('Failed to fetch'), null, undefined, 'x']) {
      expect(uploadErrorText(e)).toBe('The upload did not work. Check your connection and try again.')
    }
    for (const code of ['bad_image', 'body_too_large', 'rate_limited', 'internal_error']) expect(uploadErrorText({ code })).not.toContain(code)
  })

  test('trying the same file again is offered for a failed upload, not for a file the pad refused', () => {
    expect(canRetry({ code: 'internal_error' })).toBe(true)
    expect(canRetry({ code: 'unreachable' })).toBe(true)
    expect(canRetry({ code: 'rate_limited' })).toBe(true)
    expect(canRetry(new Error('Failed to fetch'))).toBe(true)
    expect(canRetry({ code: 'bad_image' })).toBe(false)
    expect(canRetry({ code: 'body_too_large' })).toBe(false)
  })

  test('the size of the stored copy', () => {
    expect(sizeText(0)).toBe('0 B')
    expect(sizeText(1023)).toBe('1023 B')
    expect(sizeText(1024)).toBe('1 KB')
    expect(sizeText(412 * 1024)).toBe('412 KB')
    expect(sizeText(MAX_UPLOAD_BYTES)).toBe('5 MB')
    expect(sizeText(Math.round(1.5 * 1024 * 1024))).toBe('1.5 MB')
  })
})

describe('pickFile: the picture among dropped or pasted files', () => {
  const file = (name: string, type: string) => new File([PNG], name, { type })

  test('the first image wins', () => {
    const picked = pickFile([file('notes.txt', 'text/plain'), file('a.png', 'image/png'), file('b.jpg', 'image/jpeg')])
    expect(picked?.name).toBe('a.png')
  })

  test('a lone file with no type is still looked at, since its first bytes get the last word', () => {
    expect(pickFile([file('picture', '')])?.name).toBe('picture')
  })

  test('several files and none an image, or no files, give nothing', () => {
    expect(pickFile([file('a.txt', 'text/plain'), file('b.pdf', 'application/pdf')])).toBeNull()
    expect(pickFile([])).toBeNull()
    expect(pickFile(null)).toBeNull()
    expect(pickFile(undefined)).toBeNull()
  })
})
