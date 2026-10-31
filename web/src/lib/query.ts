// The page address's query, read and rewritten without losing the other parameters (a coin page can carry ?hpage= and ?sheet= together).
export function hashQuery(key: string): string | null {
  return new URLSearchParams(location.hash.split('?')[1] || '').get(key)
}

/** Set or remove one parameter of the current address without a new history entry and without a hashchange. */
export function setHashQuery(key: string, value: string | null): void {
  const [path, query = ''] = location.hash.split('?')
  const q = new URLSearchParams(query)
  if (value === null || value === '') q.delete(key)
  else q.set(key, value)
  const s = q.toString()
  history.replaceState(history.state, '', s ? `${path}?${s}` : path || '#/')
}
