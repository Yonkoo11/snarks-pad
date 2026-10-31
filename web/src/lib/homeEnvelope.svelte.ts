// The home page's envelope and the companion share one fact: whether Snarks is inside it. The companion sets it
// (empty -> in -> leaving -> empty); the envelope draws its tenant from it, so there is never a second mascot on the page.
export const homeEnv = $state<{ phase: 'empty' | 'in' | 'leaving' }>({ phase: 'empty' })
