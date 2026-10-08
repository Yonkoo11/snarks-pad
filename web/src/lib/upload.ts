// The picture picked on the Launch page: what may be sent, and what to say when it may not. The page looks at the first bytes of the file, never
// at its name or the type the browser claims, and the engine looks again (engine/src/publicFiles/image.ts is the authority: an SVG, an HTML page
// or a PDF with a .png name is refused there too). Nothing in here touches the network, so it runs in a test as it is.

/** The most the engine takes in one upload (contract v2.7). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** What the file chooser offers. */
export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

export type ImageKind = 'png' | 'jpg' | 'webp' | 'gif'

const ascii = (b: Uint8Array, from: number, len: number): string => String.fromCharCode(...b.subarray(from, from + len))

/** The kind of image the first bytes say it is (PNG, JPEG, WEBP or GIF), or null. The same four the engine accepts. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  const head = ascii(b, 0, 6)
  return head === 'GIF87a' || head === 'GIF89a' ? 'gif' : null
}

export type PickProblem = 'not_image' | 'too_big'

/** Why this file cannot be uploaded, or null when it can: judged from its size and its first bytes. */
export async function problemWith(file: Blob): Promise<PickProblem | null> {
  if (file.size > MAX_UPLOAD_BYTES) return 'too_big'
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  return sniffImage(head) ? null : 'not_image'
}

export const PICK_TEXT: Record<PickProblem, string> = {
  not_image: 'That file is not a PNG, JPG, GIF or WEBP image.',
  too_big: 'That image is over 5 MB. Pick a smaller one.',
}

/** True for a failure of the upload itself that trying the same file again can fix (the network, the server, the rate limit), not a file the pad refused. */
export function canRetry(e: unknown): boolean {
  return !(typeof e === 'object' && e !== null && 'code' in e && ((e as { code: unknown }).code === 'bad_image' || (e as { code: unknown }).code === 'body_too_large'))
}

/** The engine's answer to an upload, in the words a creator reads (never a code). */
export function uploadErrorText(e: unknown): string {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : ''
  if (code === 'bad_image') return PICK_TEXT.not_image
  if (code === 'body_too_large') return PICK_TEXT.too_big
  if (code === 'rate_limited' || code === 'busy') return 'Too many uploads just now. Wait a minute and try again.'
  return 'The upload did not work. Check your connection and try again.'
}

/** "412 KB", "1.2 MB": the size of the stored picture. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
}

/** The first image file among dropped or pasted files, or null. A file with no image type is still returned when the list holds only one, so its first bytes get the last word. */
export function pickFile(files: ArrayLike<File> | null | undefined): File | null {
  const list = Array.from(files ?? [])
  return list.find((f) => f.type.startsWith('image/')) ?? (list.length === 1 ? list[0]! : null)
}
