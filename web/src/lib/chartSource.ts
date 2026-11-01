// The one switch for the third-party pool provider (GeckoTerminal). On mainnet it is on unless the build sets VITE_CHART_SOURCE=recorded,
// which keeps every visitor's browser off the provider and shows the pad's own recorded trades, labelled as such. Moving to candles from the
// engine later is a change here and in candleSource.ts and pool.ts.
import type { PadMode } from './types'

export const poolProviderOn = (mode: PadMode | null): boolean => mode === 'mainnet' && import.meta.env.VITE_CHART_SOURCE !== 'recorded'
