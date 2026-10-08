// A Svelte action: run `load` once, the first time the element scrolls into view (200px early, so the answer is usually there when it arrives). Where the browser has no
// IntersectionObserver the load starts at once. It is how a long list reads something per row (a coin's creator fees) without asking for every row on arrival.
export function whenVisible(node: HTMLElement, load: () => void): { destroy(): void } {
  if (typeof IntersectionObserver === 'undefined') {
    load()
    return { destroy() {} }
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      load()
    },
    { rootMargin: '200px' },
  )
  io.observe(node)
  return { destroy: () => io.disconnect() }
}
