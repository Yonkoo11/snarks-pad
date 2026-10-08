import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// The offline-safe shell (public/sw.js): built pages and assets only, never anything under /api/. Production builds only,
// so the dev server's modules are never kept.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* the site works the same without it */ }) })
}

export default app
