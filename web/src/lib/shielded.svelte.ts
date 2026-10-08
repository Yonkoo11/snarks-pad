// A wallet's own shielded delivery, read the one way the engine allows (contract v2.9, signed reads): with a fresh signature of that wallet over the status text.
// Whether a wallet opted in, its masked address, what is pending and the shielded batches that paid it are shown to nobody else, not even to a visitor who knows the
// address, so there is nothing to read until the owner signs. The answer is kept in memory for this tab (a reload forgets it) so the owner is asked once for the
// Shielded page, the Rewards tab and the Shielded delivery tab together, not once for each.
import { api, ApiError, OPTIN_ERRORS, shieldedViewMessage } from './api'
import type { OptinStatus } from './types'
import { friendly, wallet } from './wallet.svelte'

class ShieldedView {
  /** The wallet the kept answer is about. */
  owner = $state<string | null>(null)
  status = $state<OptinStatus | null>(null)
  busy = $state(false)
  error = $state<string | null>(null)

  /** What the last signed read said about `address`: null when it was never read, was read for another wallet, or has been forgotten. */
  of(address: string | null): OptinStatus | null {
    return address !== null && address === this.owner ? this.status : null
  }

  /** One signature: a fresh nonce, the wallet signs the status text, the engine answers. Returns the answer, or null with `error` set (a closed wallet prompt is an error in words, not a crash). */
  async read(address: string): Promise<OptinStatus | null> {
    if (this.busy) return null
    this.busy = true
    this.error = null
    try {
      const { nonce } = await api.optinNonce(address)
      const signature = await wallet.signMessage(shieldedViewMessage(address, nonce))
      const status = await api.optinStatus({ wallet: address, nonce, signature })
      if (wallet.address !== address) return null // the wallet was changed while the prompt was open: the answer is not this page's any more
      this.owner = address
      this.status = status
      return status
    } catch (e) {
      this.error = e instanceof ApiError ? (OPTIN_ERRORS[e.code] ?? 'The pad could not show your settings. Try again in a moment.') : friendly(e)
      return null
    } finally {
      this.busy = false
    }
  }

  /** Throws the kept answer away: the wallet just changed its settings (opted in or stopped), so what was read no longer says what is true. */
  forget(): void {
    this.owner = null
    this.status = null
  }
}

export const shieldedView = new ShieldedView()

// Nothing read about a wallet outlives its connection: when the connected wallet changes or is disconnected, the kept answer is thrown away, so the next connection signs for itself.
$effect.root(() => {
  $effect(() => { if (wallet.address !== shieldedView.owner) shieldedView.forget() })
})
