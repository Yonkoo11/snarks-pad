// Hash router (the routes are in routes.ts): the current route as reactive state, kept in step with the page address.
import { captureReferrer } from './referral'
import { parseRoute, type Route } from './routes'

const pathOf = () => location.hash.split('?')[0]

class Router {
  route = $state<Route>(parseRoute(location.hash))
  private path = pathOf()
  constructor() {
    captureReferrer()
    addEventListener('hashchange', () => {
      captureReferrer()
      this.route = parseRoute(location.hash)
      // only a different page returns to the top: a layer opening or closing (?sheet=) keeps the reader where they were
      const path = pathOf()
      if (path !== this.path) { this.path = path; scrollTo({ top: 0 }) }
    })
  }
  /** The page rewrote its own address without a hashchange (a profile tab, history.replaceState): read the route again so the state is the address. */
  sync(): void {
    this.route = parseRoute(location.hash)
  }
}
export const router = new Router()
