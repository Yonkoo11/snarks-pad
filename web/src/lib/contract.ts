// The pieces of the engine contract that both the real client and the mock implement against: the error shape and
// the exact message texts a wallet signs. They live outside api.ts so the mock never imports the client module
// (api.ts loads the mock with a dynamic import, and a cycle there would hang the app before first paint).

export class ApiError extends Error {
  // `field` names what the engine refused (a request field, or `socials.x` for one link), when it says
  constructor(public status: number, public code: string, public field?: string) { super(code) }
}
/** An engine before this route existed answers 404 not_found: the UI hides that block instead of showing an error. */
export const routeAbsent = (e: unknown): boolean => e instanceof ApiError && e.status === 404 && e.code === 'not_found'

// Exact message text from the contract. The client builds it so the user can read what they sign.
export function optinMessage(wallet: string, zcash: string, nonce: string): string {
  return `SNARKS pad: deliver my rewards shielded\nwallet: ${wallet}\nzcash: ${zcash}\nnonce: ${nonce}`
}
// Contract: "same signed-message scheme, first line `SNARKS pad: stop shielded delivery`".
// The API never returns the full address, so the stop message carries no zcash line.
export function optoutMessage(wallet: string, nonce: string): string {
  return `SNARKS pad: stop shielded delivery\nwallet: ${wallet}\nnonce: ${nonce}`
}
// Contract v2.9: POST /optin/status shows a wallet's shielded delivery (on or off, the masked address, what is pending, the shielded rounds) only against a signature over this text.
// It is the signature's purpose: it is not the opt-in or opt-out text, so it can never opt anyone in or out, and the nonce works once.
export function shieldedViewMessage(wallet: string, nonce: string): string {
  return `SNARKS pad: show my shielded delivery settings and rewards\nwallet: ${wallet}\nnonce: ${nonce}`
}
// Contract (v2.2 receipt, v2.6 verify-memo): the signed proof that opens the caller's own rows of one round.
export function receiptMessage(wallet: string, epochId: string, nonce: string): string {
  return `SNARKS pad: open my epoch receipt\nwallet: ${wallet}\nepoch: ${epochId}\nnonce: ${nonce}`
}
