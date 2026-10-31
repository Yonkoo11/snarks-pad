// The drawings Snarks can stand in, by pose name. Today there is one drawing, so every pose points at it and the motion carries the
// meaning. When the artist draws more (sleeping, cheering, alert, pointing, carrying the envelope, sitting, looking up), adding one is
// a file in public/ and a line here; no code that moves the figure changes.
export type PoseName = 'stand' | 'sleep' | 'cheer' | 'alert' | 'point' | 'envelope' | 'sit' | 'lookup'
const STAND = '/mascot-cut.webp'
export const POSES: Record<PoseName, string> = {
  stand: STAND, sleep: STAND, cheer: STAND, alert: STAND, point: STAND, envelope: STAND, sit: STAND, lookup: STAND,
}
export const poseSrc = (p: PoseName): string => POSES[p] ?? STAND
