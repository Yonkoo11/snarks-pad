// The envelope scene's rules, apart from the picture, so a test can read them: what the real state of the shielded opt-in (a wallet
// connected, a valid Zcash address pasted, the seal being held, the request pending, the pad's confirmation, a refusal) says about
// how high Snarks stands in the envelope and whether the flap is open. Nothing here is decoration: each pose is a fact about the flow.
export interface EnvState {
  connected: boolean // a Solana wallet is connected
  ready: boolean // and a valid unified Zcash address is pasted: the seal can be held
  holdK: number // how far the user's own hold on the seal has gone, 0..1
  busy: boolean // the request is with the wallet or the pad
  done: boolean // the pad confirmed the opt-in
  failed: boolean // the pad or the wallet refused
}
export type Mood = 'asleep' | 'wait' | 'ready' | 'hold' | 'work' | 'out' | 'duck'
export interface EnvPose { mood: Mood; rise: number; flap: number; sealed: boolean }

/** rise: 0 hidden inside .. 1 standing out of the envelope; flap: 0 closed .. 1 open. */
export function envelopePose(s: EnvState): EnvPose {
  if (s.done) return { mood: 'out', rise: 1, flap: 0, sealed: true } // out, the flap shut behind it and the wax on
  if (s.failed) return { mood: 'duck', rise: 0, flap: 0.15, sealed: false } // a refusal: it ducks in and pulls the flap nearly shut
  if (s.busy) return { mood: 'work', rise: 0.5, flap: 1, sealed: false } // pending: it holds halfway; only the pad's word lets it out
  if (s.holdK > 0) return { mood: 'hold', rise: Math.min(0.75, 0.4 + 0.35 * s.holdK), flap: 1, sealed: false } // your hold lifts it, never to the top
  if (s.ready) return { mood: 'ready', rise: 0.5, flap: 1, sealed: false }
  if (s.connected) return { mood: 'wait', rise: 0.3, flap: 1, sealed: false }
  return { mood: 'asleep', rise: 0.12, flap: 0.55, sealed: false } // nothing to do yet: only the horns show
}
