// The front page's slip pile and the companion share one fact: whether Snarks is behind the paper. The companion sets it
// (empty -> in -> leaving -> empty, and where along the pile it went in); the pile draws its tenant from it, so there is
// never a second mascot on the page.
export const homeEnv = $state<{ phase: 'empty' | 'in' | 'leaving'; dx: number }>({ phase: 'empty', dx: 40 })
