// The offline-safe shell. Pages and the built, hash-named assets are kept so the app opens without a connection and
// says the pad cannot be reached, instead of a browser error page. Nothing under /api/ is ever cached: every number
// on screen is read live from the pad, or shown as not loaded.
const SHELL = 'snarks-shell-v1'
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/mascot-256.jpg', '/favicon.png', '/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // fonts are bundled; nothing from another origin is kept
  if (url.pathname.startsWith('/api/')) return // live data only, never from a cache

  // the page itself: the network first, so a new deploy shows at once; the kept copy only when the network is away
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put('/index.html', copy)); return r }).catch(() => caches.match('/index.html')))
    return
  }
  // hash-named build assets never change under the same name: the kept copy first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); return r })))
    return
  }
  // images, the manifest, icons: the kept copy, refreshed in the background
  event.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(req, copy)) } return r }).catch(() => hit)
    return hit || net
  }))
})
