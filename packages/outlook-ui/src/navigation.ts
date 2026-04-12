import { createContext, useContext } from "react"

export type TabId = "overview" | "sessions" | "work" | "connections" | "inner" | "notes" | "runtime"

export interface NavigateTarget {
  tab: TabId
  /** Deep focus path — e.g. "friendId/channel/key" for sessions, "ob-1" for obligations */
  focus?: string
}

export type NavigateFn = (target: NavigateTarget) => void

export const NavigationContext = createContext<NavigateFn>(() => {})

export function useNavigate(): NavigateFn {
  return useContext(NavigationContext)
}

/**
 * Hash-based URL routing.
 * Format: #/agent/{name}/{tab}/{focus...}
 *
 * Examples:
 *   #/agent/slugger                              → overview
 *   #/agent/slugger/sessions                     → sessions tab
 *   #/agent/slugger/sessions/friendId/channel/key → session expanded
 *   #/agent/slugger/work/ob-123                  → work, focused on obligation
 *   #/agent/slugger/connections/bridge-1          → connections, focused on bridge
 */

export interface RouteState {
  agent: string
  tab: TabId
  focus: string | undefined
}

const VALID_TABS = new Set<string>(["overview", "sessions", "work", "connections", "inner", "notes", "runtime"])

export function parseHash(hash: string): RouteState | null {
  const path = hash.replace(/^#\/?/, "")
  if (!path.startsWith("agent/")) return null

  const parts = path.split("/")
  // parts[0] = "agent", parts[1] = name, parts[2] = tab?, parts[3+] = focus?
  const agent = parts[1] ? decodeURIComponent(parts[1]) : ""
  if (!agent) return null

  const tabRaw = parts[2] ?? "overview"
  const tab = VALID_TABS.has(tabRaw) ? (tabRaw as TabId) : "overview"
  const focusParts = parts.slice(3)
  const focus = focusParts.length > 0 ? focusParts.map(decodeURIComponent).join("/") : undefined

  return { agent, tab, focus }
}

export function buildHash(state: RouteState): string {
  let hash = `#/agent/${encodeURIComponent(state.agent)}`
  if (state.tab !== "overview" || state.focus) {
    hash += `/${state.tab}`
  }
  if (state.focus) {
    hash += `/${state.focus.split("/").map(encodeURIComponent).join("/")}`
  }
  return hash
}
