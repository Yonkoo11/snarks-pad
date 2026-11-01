/// <reference types="svelte" />
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API?: string
  readonly VITE_API_BASE?: string
  readonly VITE_RPC?: string
  readonly VITE_CHART_SOURCE?: string // 'recorded' turns the third-party pool provider off
}
