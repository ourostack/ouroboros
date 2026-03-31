import { useCallback, useEffect, useRef, useState } from "react"
import { fetchJson, subscribeToEvents } from "./api"
import { buildHash, parseHash, type RouteState } from "./navigation"
import { SidebarLayout } from "./catalyst/sidebar-layout"
import {
  Sidebar,
  SidebarBody,
  SidebarHeader,
  SidebarItem,
  SidebarLabel,
  SidebarSection,
  SidebarHeading,
  SidebarFooter,
} from "./catalyst/sidebar"
import { Navbar, NavbarItem, NavbarSection, NavbarSpacer } from "./catalyst/navbar"
import { Badge } from "./catalyst/badge"
import { AgentInspector } from "./components/agent-inspector"

interface MachineView {
  overview: {
    productName: string
    observedAt: string
    daemon: { status: string; mode: string; health: string }
    runtime: { version: string }
    freshness: { status: string; latestActivityAt: string | null; ageMs: number | null }
    degraded: { status: string; issues: Array<{ code: string; detail: string }> }
    totals: Record<string, number>
  }
  agents: Array<{
    agentName: string
    enabled: boolean
    attention: { level: string; label: string }
    freshness: { status: string; latestActivityAt: string | null }
    degraded: { status: string; issues: Array<{ code: string; detail: string }> }
    tasks: { liveCount: number; blockedCount: number }
    obligations: { openCount: number }
    coding: { activeCount: number; blockedCount: number }
  }>
}

function getInitialRoute(): RouteState | null {
  return parseHash(window.location.hash)
}

function attentionBadgeColor(level: string): "red" | "yellow" | "lime" | "zinc" {
  if (level === "degraded" || level === "blocked") return "red"
  if (level === "stale") return "yellow"
  if (level === "active") return "lime"
  return "zinc"
}

export function App() {
  const [machine, setMachine] = useState<MachineView | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string>(getInitialRoute()?.agent ?? "")
  const [agentView, setAgentView] = useState<Record<string, unknown> | null>(null)
  const refreshRef = useRef(0)
  const initialRoute = useRef(getInitialRoute())

  const loadMachine = useCallback(async () => {
    try {
      const data = await fetchJson<MachineView>("/machine")
      setMachine(data)
      if (!selectedAgent && data.agents.length > 0) {
        const agent = initialRoute.current?.agent ?? data.agents[0]!.agentName
        setSelectedAgent(agent)
      }
    } catch { /* retry on SSE */ }
  }, [selectedAgent])

  const [deskPrefs, setDeskPrefs] = useState<Record<string, unknown> | null>(null)

  const loadAgent = useCallback(async (name: string) => {
    if (!name) { setAgentView(null); setDeskPrefs(null); return }
    try {
      const [view, prefs] = await Promise.all([
        fetchJson<Record<string, unknown>>(`/agents/${encodeURIComponent(name)}`),
        fetchJson<Record<string, unknown>>(`/agents/${encodeURIComponent(name)}/desk-prefs`),
      ])
      setAgentView(view)
      setDeskPrefs(prefs)
    } catch { setAgentView(null); setDeskPrefs(null) }
  }, [])

  useEffect(() => { loadMachine() }, [loadMachine])
  useEffect(() => { if (selectedAgent) loadAgent(selectedAgent) }, [selectedAgent, loadAgent])

  // SSE-driven refresh
  useEffect(() => {
    const unsubscribe = subscribeToEvents(() => {
      const id = ++refreshRef.current
      loadMachine().then(() => {
        if (refreshRef.current === id && selectedAgent) loadAgent(selectedAgent)
      })
    })
    return unsubscribe
  }, [loadMachine, loadAgent, selectedAgent])

  // Browser back/forward
  useEffect(() => {
    const onHash = () => {
      const route = parseHash(window.location.hash)
      if (route) setSelectedAgent(route.agent)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const handleSelectAgent = useCallback((name: string) => {
    setSelectedAgent(name)
    // Don't clear agentView — show stale data until fresh data arrives.
    // The inspector will show the previous agent briefly, which is better than a blank flash.
    window.history.pushState(null, "", buildHash({ agent: name, tab: "overview", focus: undefined }))
  }, [])

  if (!machine) {
    return (
      <div className="flex h-screen items-center justify-center bg-ouro-void">
        <div className="text-center">
          <div className="mx-auto mb-4 h-4 w-4 animate-pulse rounded-full bg-ouro-glow shadow-[0_0_20px_theme(--color-ouro-glow)]" />
          <p className="font-mono text-sm text-ouro-mist">Connecting to Outlook…</p>
        </div>
      </div>
    )
  }

  const t = machine.overview.totals

  return (
    <SidebarLayout
      navbar={
        <Navbar>
          <NavbarSpacer />
          <NavbarSection>
            <NavbarItem>
              <Badge color={machine.overview.daemon.mode === "dev" ? "yellow" : "lime"}>
                {machine.overview.daemon.mode}
              </Badge>
            </NavbarItem>
          </NavbarSection>
        </Navbar>
      }
      sidebar={
        <Sidebar className="bg-ouro-deep">
          <SidebarHeader className="border-ouro-moss/30">
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 shrink-0 rounded-full bg-ouro-glow shadow-[0_0_16px_theme(--color-ouro-glow)]" />
              <div className="min-w-0">
                <p className="truncate font-display text-lg italic font-semibold text-ouro-bone">
                  Ouro Outlook
                </p>
              </div>
            </div>
          </SidebarHeader>
          <SidebarBody className="[&>[data-slot=section]+[data-slot=section]]:mt-4">
            {/* Machine stats — compact row */}
            <SidebarSection>
              <SidebarHeading className="text-ouro-mist/60">Machine</SidebarHeading>
              <div className="grid grid-cols-3 gap-1.5 px-2">
                {[
                  { v: t.liveTasks ?? 0, l: "Tasks", alert: (t.blockedTasks ?? 0) > 0 },
                  { v: t.openObligations ?? 0, l: "Oblig." },
                  { v: t.activeCodingAgents ?? 0, l: "Coding" },
                ].map((s) => (
                  <div key={s.l} className="rounded-md bg-ouro-void/60 px-2 py-1.5 text-center ring-1 ring-ouro-moss/20">
                    <div className={`text-base font-semibold tabular-nums ${s.alert ? "text-ouro-fang" : "text-ouro-bone"}`}>
                      {s.v}
                    </div>
                    <div className="text-[9px] uppercase tracking-widest text-ouro-shadow">{s.l}</div>
                  </div>
                ))}
              </div>
            </SidebarSection>

            {/* Agent list */}
            <SidebarSection>
              <SidebarHeading className="text-ouro-mist/60">Agents</SidebarHeading>
              {machine.agents.map((agent) => (
                <SidebarItem
                  key={agent.agentName}
                  current={agent.agentName === selectedAgent}
                  onClick={() => handleSelectAgent(agent.agentName)}
                >
                  <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <div className="min-w-0">
                      <SidebarLabel className="text-ouro-bone">{agent.agentName}</SidebarLabel>
                      <p className="truncate text-xs text-ouro-shadow">
                        {agent.tasks.liveCount}t · {agent.obligations.openCount}o · {agent.coding.activeCount}c
                      </p>
                    </div>
                    <Badge color={attentionBadgeColor(agent.attention.level)}>
                      {agent.attention.label}
                    </Badge>
                  </div>
                </SidebarItem>
              ))}
            </SidebarSection>
          </SidebarBody>
          <SidebarFooter className="border-ouro-moss/30">
            <div className="px-2 text-xs text-ouro-shadow">
              <p className="font-mono">{machine.overview.runtime.version}</p>
              <p className="mt-0.5">{machine.overview.daemon.mode} · {machine.overview.freshness.status}</p>
            </div>
          </SidebarFooter>
          {/* Agent status line — manual override or auto-derived */}
          {selectedAgent && agentView && (
            <div className="px-4 py-2 border-t border-ouro-moss/20">
              <p className="text-xs italic text-ouro-shadow/70">
                {(() => {
                  const manualStatus = (deskPrefs as any)?.statusLine
                  if (manualStatus) return manualStatus
                  const inner = (agentView as any)?.inner
                  const status = inner?.status
                  if (status === "working" || inner?.hasPending) return "thinking through something privately"
                  const work = (agentView as any)?.work
                  const obCount = work?.obligations?.openCount ?? 0
                  if (obCount > 2) return "a few loose ends"
                  if (obCount > 0) return "carrying something"
                  return "steady"
                })()}
              </p>
            </div>
          )}
        </Sidebar>
      }
    >
      <AgentInspector
        agentName={selectedAgent}
        view={agentView}
        deskPrefs={deskPrefs}
        initialRoute={initialRoute.current?.agent === selectedAgent ? initialRoute.current : undefined}
      />
    </SidebarLayout>
  )
}
