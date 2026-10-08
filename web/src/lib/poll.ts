// Polling that respects the tab: runs `run` now and every `everyMs` while the tab is visible. A hidden tab stops the
// timer (the backoff is to zero); when the tab comes back it runs once at once and restarts. Returns the stop function,
// so `$effect(() => poll(load, 10_000))` cleans up on its own. Errors are the caller's: every `run` catches inside.
export function poll(run: () => unknown, everyMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null
  const start = () => { if (timer === null) timer = setInterval(run, everyMs) }
  const stop = () => { if (timer !== null) { clearInterval(timer); timer = null } }
  const onVisibility = () => { if (document.visibilityState === 'visible') { run(); start() } else stop() }
  run()
  if (document.visibilityState === 'visible') start()
  document.addEventListener('visibilitychange', onVisibility)
  return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
}
