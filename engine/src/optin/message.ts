// Exact message formats the wallet signs docs/API.md "Shielded delivery opt-in").
// Byte-exact: any drift here breaks every wallet that already signed the old text.
export function optinMessage(wallet: string, zcashAddress: string, nonce: string): string {
  return `SNARKS pad: deliver my rewards shielded\nwallet: ${wallet}\nzcash: ${zcashAddress}\nnonce: ${nonce}`;
}

export function optoutMessage(wallet: string, nonce: string): string {
  return `SNARKS pad: stop shielded delivery\nwallet: ${wallet}\nnonce: ${nonce}`;
}

// v2.9: POST /optin/status shows a wallet's shielded delivery (on or off, the masked address, what is pending, the shielded rounds it was paid in) only
// to a request that carries a fresh signature over this text. The text is the signature's purpose: it differs from the opt-in text (first line, and that one
// has a `zcash:` line) and from the opt-out text (first line), so a signature made to read can never be checked as an opt-in or an opt-out, nor the reverse.
// Same signed-nonce scheme as opt-in/opt-out; the nonce works once.
export function shieldedViewMessage(wallet: string, nonce: string): string {
  return `SNARKS pad: show my shielded delivery settings and rewards\nwallet: ${wallet}\nnonce: ${nonce}`;
}

// GET /epochs/:id/receipt opens the caller's own shielded commitments from that epoch's published snapshot.
export function epochReceiptMessage(wallet: string, epochId: string, nonce: string): string {
  return `SNARKS pad: open my epoch receipt\nwallet: ${wallet}\nepoch: ${epochId}\nnonce: ${nonce}`;
}
