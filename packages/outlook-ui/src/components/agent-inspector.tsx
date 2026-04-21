import { useCallback, useEffect, useRef, useState } from "react"
import { Badge } from "../catalyst/badge"
import { buildHash, NavigationContext, type NavigateTarget, type RouteState, type TabId } from "../navigation"
import { useKeyboardShortcuts } from "../hooks/use-keyboard"
import { OverviewTab } from "./tabs/overview"
import { MailboxTab } from "./tabs/mailbox"
import { SessionsTab } from "./tabs/sessions"
import { WorkTab } from "./tabs/work"
import { ConnectionsTab } from "./tabs/connections"
import { InnerTab } from "./tabs/inner"
import { NotesTab } from "./tabs/notes"
import { RuntimeTab } from "./tabs/runtime"
import type { OutlookAgentView, OutlookDeskPrefs } from "../contracts"

interface AgentInspectorProps {
  agentName: string
  view: OutlookAgentView | null
  deskPrefs?: OutlookDeskPrefs | null
  refreshGeneration: number
  initialRoute?: RouteState
}

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "mail", label: "Mailbox" },
  { id: "sessions", label: "Sessions" },
  { id: "work", label: "Work" },
  { id: "connections", label: "Connections" },
  { id: "inner", label: "Inner" },
  { id: "notes", label: "Diary & Journal" },
  { id: "runtime", label: "Runtime" },
]

function attentionColor(level: string): "red" | "yellow" | "lime" | "zinc" {
  if (level === "degraded" || level === "blocked") return "red"
  if (level === "stale") return "yellow"
  if (level === "active") return "lime"
  return "zinc"
}

export function AgentInspector({ agentName, view, deskPrefs, refreshGeneration, initialRoute }: AgentInspectorProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialRoute?.tab ?? "overview")
  const [focusTarget, setFocusTarget] = useState<string | undefined>(initialRoute?.focus)
  const initialConsumed = useRef(false)

  useEffect(() => {
    if (initialRoute?.agent === agentName && !initialConsumed.current) {
      initialConsumed.current = true
      setActiveTab(initialRoute.tab)
      setFocusTarget(initialRoute.focus)
    } else {
      setActiveTab("overview")
      setFocusTarget(undefined)
    }
  }, [agentName])

  const navigate = useCallback((target: NavigateTarget) => {
    setActiveTab(target.tab)
    setFocusTarget(target.focus)
    window.history.pushState(null, "", buildHash({ agent: agentName, tab: target.tab, focus: target.focus }))
  }, [agentName])

  const handleTabClick = useCallback((tab: TabId) => {
    setActiveTab(tab)
    setFocusTarget(undefined)
    window.history.pushState(null, "", buildHash({ agent: agentName, tab, focus: undefined }))
  }, [agentName])

  const consumeFocus = useCallback(() => setFocusTarget(undefined), [])

  // Keyboard shortcuts: 1-8 for tabs, Esc to collapse
  useKeyboardShortcuts(navigate)

  if (!view || !agentName) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <p className="font-display text-2xl italic text-ouro-bone">Choose an agent</p>
        <p className="mt-2 text-sm text-ouro-mist">
          Select an agent from the sidebar to inspect its state.
        </p>
      </div>
    )
  }

  const agent = view.agent
  const attention = agent.attention

  return (
    <NavigationContext.Provider value={navigate}>
      <div>
        {/* Agent header */}
        <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-ouro-moss/30">
          <div className="min-w-0">
            <h1 className="font-display text-2xl italic font-semibold text-ouro-bone sm:text-3xl">
              {agentName}
            </h1>
          </div>
          <Badge color={attentionColor(attention.level)}>{attention.label}</Badge>
        </div>

        {/* Tabs */}
        <nav className="mt-4 flex gap-0.5 overflow-x-auto border-b border-ouro-moss/20 -mx-1">
          {(() => {
            const order = deskPrefs?.tabOrder
            if (!order) return TABS
            const ordered = order
              .map((id) => TABS.find((t) => t.id === id))
              .filter((t): t is typeof TABS[number] => t !== undefined)
            const remaining = TABS.filter((t) => !order.includes(t.id))
            return [...ordered, ...remaining]
          })().map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabClick(tab.id)}
              className={`shrink-0 px-3 py-2 text-xs font-mono uppercase tracking-wider transition-colors rounded-t-md ${
                activeTab === tab.id
                  ? "bg-ouro-moss/20 text-ouro-glow border-b-2 border-ouro-glow"
                  : "text-ouro-shadow hover:text-ouro-mist hover:bg-ouro-moss/10"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Tab content */}
        <div className="mt-6">
          {activeTab === "overview" && <OverviewTab view={view} deskPrefs={deskPrefs} refreshGeneration={refreshGeneration} />}
          {activeTab === "mail" && <MailboxTab agentName={agentName} focus={focusTarget} onFocusConsumed={consumeFocus} refreshGeneration={refreshGeneration} />}
          {activeTab === "sessions" && <SessionsTab agentName={agentName} focus={focusTarget} onFocusConsumed={consumeFocus} deskPrefs={deskPrefs} refreshGeneration={refreshGeneration} />}
          {activeTab === "work" && <WorkTab agentName={agentName} view={view} focus={focusTarget} onFocusConsumed={consumeFocus} refreshGeneration={refreshGeneration} />}
          {activeTab === "connections" && <ConnectionsTab agentName={agentName} focus={focusTarget} onFocusConsumed={consumeFocus} refreshGeneration={refreshGeneration} />}
          {activeTab === "inner" && <InnerTab agentName={agentName} view={view} refreshGeneration={refreshGeneration} />}
          {activeTab === "notes" && <NotesTab agentName={agentName} refreshGeneration={refreshGeneration} />}
          {activeTab === "runtime" && <RuntimeTab agentName={agentName} view={view} refreshGeneration={refreshGeneration} />}
        </div>
      </div>
    </NavigationContext.Provider>
  )
}
