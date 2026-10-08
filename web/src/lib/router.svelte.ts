// Hash router (the routes are in routes.ts): the current route as reactive state, kept in step with the page address.
import { captureReferrer } from './referral'
import { parseRoute, type Route } from './routes'

class Router {
  route = $state<Route>(parseRoute(location.hash))
  constructor() {
    captureReferrer()
    addEventListener('hashchange', () => {
      captureReferrer()
      this.route = parseRoute(location.hash)
      scrollTo({ top: 0 })
    })
  }
  /** The page rewrote its own address without a hashchange (a profile tab, history.replaceState): read the route again so the state is the address. */
  sync(): void {
    this.route = parseRoute(location.hash)
  }
}
export const router = new Router()
