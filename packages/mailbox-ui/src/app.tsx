import { useCallback, useEffect, useRef, useState } from "react"
import { fetchJson, subscribeToEvents, type ConnectionState } from "./api"
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
import type { MailboxAgentInnerView, MailboxAgentView, MailboxDeskPrefs, MailboxMachineView } from "./contracts"

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
  const [machine, setMachine] = useState<MailboxMachineView | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<string>(getInitialRoute()?.agent ?? "")
  const [agentView, setAgentView] = useState<MailboxAgentView | null>(null)
  const [deskPrefs, setDeskPrefs] = useState<MailboxDeskPrefs | null>(null)
  const [machineError, setMachineError] = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [machineReceivedAt, setMachineReceivedAt] = useState<string | null>(null)
  const [agentReceivedAt, setAgentReceivedAt] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>("connecting")
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const refreshRef = useRef(0)
  const initialRoute = useRef(getInitialRoute())
  const selectedRef = useRef(selectedAgent)
  const mounted = useRef(true)
  const machineRequest = useRef(0)
  const agentRequest = useRef(0)
  const machineAbort = useRef<AbortController | null>(null)
  const agentAbort = useRef<AbortController | null>(null)

  const selectAgent = useCallback((name: string) => {
    if (selectedRef.current === name) return
    selectedRef.current = name
    agentRequest.current += 1
    refreshRef.current += 1
    agentAbort.current?.abort()
    setSelectedAgent(name)
    setAgentView(null)
    setDeskPrefs(null)
    setAgentError(null)
    setAgentReceivedAt(null)
  }, [])

  const loadMachine = useCallback(async () => {
    const id = ++machineRequest.current
    machineAbort.current?.abort()
    const controller = new AbortController()
    machineAbort.current = controller
    try {
      const data = await fetchJson<MailboxMachineView>("/machine", { signal: controller.signal })
      if (!mounted.current || id !== machineRequest.current) return
      setMachine(data)
      setMachineError(null)
      setMachineReceivedAt(new Date().toISOString())
      if (!selectedRef.current && data.agents.length > 0) {
        const agent = initialRoute.current?.agent ?? data.agents[0]!.agentName
        selectAgent(agent)
      }
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || id !== machineRequest.current) return
      setMachineError(error instanceof Error ? error.message : String(error))
    }
  }, [selectAgent])

  const loadAgent = useCallback(async (name: string) => {
    if (!name) return
    const id = ++agentRequest.current
    agentAbort.current?.abort()
    const controller = new AbortController()
    agentAbort.current = controller
    const isCurrent = () => mounted.current && id === agentRequest.current && selectedRef.current === name
    try {
      const [view, prefs] = await Promise.all([
        fetchJson<MailboxAgentView>(`/agents/${encodeURIComponent(name)}`, { signal: controller.signal }),
        fetchJson<MailboxDeskPrefs>(`/agents/${encodeURIComponent(name)}/desk-prefs`, { signal: controller.signal }),
      ])
      if (!isCurrent()) return
      if (view.agent.agentName !== name) throw new Error("the response belongs to another agent")
      setAgentView(view)
      setDeskPrefs(prefs)
      setAgentError(null)
      setAgentReceivedAt(new Date().toISOString())
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return
      setAgentError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      machineRequest.current += 1
      agentRequest.current += 1
      refreshRef.current += 1
      machineAbort.current?.abort()
      agentAbort.current?.abort()
    }
  }, [])

  useEffect(() => { loadMachine() }, [loadMachine])
  useEffect(() => { if (selectedAgent) loadAgent(selectedAgent) }, [selectedAgent, loadAgent])

  const refresh = useCallback(async () => {
    const id = ++refreshRef.current
    const name = selectedRef.current
    await Promise.all([loadMachine(), name ? loadAgent(name) : Promise.resolve()])
    if (mounted.current && refreshRef.current === id) setRefreshGeneration((current) => current + 1)
  }, [loadMachine, loadAgent])

  useEffect(() => {
    return subscribeToEvents(() => { void refresh() }, setConnection)
  }, [refresh])

  // Browser back/forward
  useEffect(() => {
    const onHash = () => {
      const route = parseHash(window.location.hash)
      if (route) selectAgent(route.agent)
    }
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [selectAgent])

  const handleSelectAgent = useCallback((name: string) => {
    selectAgent(name)
    window.history.pushState(null, "", buildHash({ agent: name, tab: "overview", focus: undefined }))
  }, [selectAgent])

  if (!machine) {
    return (
      <div className="flex h-screen items-center justify-center bg-ouro-void">
        <div className="text-center">
          {machineError ? (
            <div role="alert">
              <p className="text-ouro-bone">Could not connect to Mailbox: {machineError}</p>
              <button type="button" onClick={() => { void refresh() }} className="mt-3 text-ouro-glow underline">
                Retry connection
              </button>
            </div>
          ) : (
            <>
              <div className="mx-auto mb-4 h-4 w-4 animate-pulse rounded-full bg-ouro-glow shadow-[0_0_20px_theme(--color-ouro-glow)]" />
              <p role="status" className="font-mono text-sm text-ouro-mist">Connecting to Mailbox…</p>
            </>
          )}
        </div>
      </div>
    )
  }

  const t = machine.overview.totals
  const currentView = agentView?.agent.agentName === selectedAgent ? agentView : null

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
                  Ouro Mailbox
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
          {selectedAgent && currentView && (
            <div className="px-4 py-2 border-t border-ouro-moss/20">
              <p className="text-xs italic text-ouro-shadow/70">
                {(() => {
                  const manualStatus = deskPrefs?.statusLine
                  if (manualStatus) return manualStatus
                  const inner: MailboxAgentInnerView = currentView.inner
                  const status = inner.status
                  if (status === "running" || inner.hasPending) return "thinking through something privately"
                  const obCount = currentView.work.obligations.openCount
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
      <div role="status" className="mb-4 text-xs text-ouro-mist">
        {connection === "connected" ? "Live connection" : connection === "reconnecting"
          ? "Disconnected - reconnecting. Displayed snapshots may be stale."
          : "Connecting to live updates. Displayed snapshots may be stale."}
        {machineReceivedAt && <> Last machine snapshot received <time dateTime={machineReceivedAt}>{new Date(machineReceivedAt).toLocaleTimeString()}</time>.</>}
      </div>
      {machineError && (
        <div role="alert" className="mb-4 text-sm text-ouro-gold">
          Could not refresh the machine snapshot: {machineError}. Showing the last successful machine snapshot.
          <button type="button" onClick={() => { void refresh() }} className="ml-2 underline">Retry</button>
        </div>
      )}
      {agentError && (
        <div role="alert" className="mb-4 text-sm text-ouro-gold">
          Could not load {selectedAgent}: {agentError}.
          {currentView && <> Showing the last successful snapshot for {selectedAgent}{agentReceivedAt && <> received <time dateTime={agentReceivedAt}>{new Date(agentReceivedAt).toLocaleTimeString()}</time></>}.</>}
          <button type="button" onClick={() => { void loadAgent(selectedAgent) }} className="ml-2 underline">Retry agent</button>
        </div>
      )}
      {currentView || !selectedAgent ? (
        <AgentInspector
          key={selectedAgent}
          agentName={selectedAgent}
          view={currentView}
          deskPrefs={deskPrefs}
          refreshGeneration={refreshGeneration}
          initialRoute={initialRoute.current?.agent === selectedAgent ? initialRoute.current : undefined}
        />
      ) : (
        <p role="status" className="py-12 text-ouro-mist">
          {agentError ? `No snapshot available for ${selectedAgent}.` : `Loading ${selectedAgent}...`}
        </p>
      )}
    </SidebarLayout>
  )
}
