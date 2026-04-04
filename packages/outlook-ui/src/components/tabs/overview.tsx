import { useEffect, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { useNavigate, type TabId } from "../../navigation"

interface NeedsMeItem {
  urgency: string
  label: string
  detail: string
  ref: { tab: string; focus?: string } | null
  ageMs: number | null
}

const URGENCY_COLORS: Record<string, "red" | "yellow" | "lime" | "zinc"> = {
  "owed-reply": "red",
  "blocking-obligation": "red",
  "broken-return": "red",
  "stale-delegation": "yellow",
  "return-ready": "lime",
  "overdue-habit": "yellow",
}

const URGENCY_LABELS: Record<string, string> = {
  "owed-reply": "owed reply",
  "blocking-obligation": "blocking",
  "broken-return": "broken return",
  "stale-delegation": "stale",
  "return-ready": "ready to return",
  "overdue-habit": "overdue",
}

const URGENCY_WHY: Record<string, string> = {
  "owed-reply": "Someone spoke last and is waiting for your response",
  "blocking-obligation": "This obligation is open and blocking forward progress",
  "broken-return": "Work was done but the result was never returned to the requester",
  "stale-delegation": "This was delegated to you and hasn't been addressed",
  "return-ready": "The result is ready — deliver it to close the loop",
  "overdue-habit": "This routine is past its scheduled cadence",
}

const STALE_URGENCIES = new Set(["stale-delegation"])
const ACTION_URGENCIES = new Set(["owed-reply", "blocking-obligation", "broken-return", "return-ready", "overdue-habit"])

interface OrientationView {
  currentSession: { friendId: string; channel: string; key: string; lastActivityAt: string | null } | null
  centerOfGravity: string
  primaryObligation: { id: string; content: string; status: string; nextAction: string | null; waitingOn: string | null } | null
  resumeHandle: {
    sessionLabel: string | null
    lane: string | null
    artifact: string | null
    blockerOrWaitingOn: string | null
    nextAction: string | null
    confidence: string
  } | null
  otherActiveSessions: Array<{ friendId: string; friendName: string; channel: string; key: string; lastActivityAt: string }>
}

interface ChangesView {
  changeCount: number
  items: Array<{ kind: string; id: string; from: string | null; to: string | null; summary: string }>
  snapshotAge: string | null
  formatted: string
}

interface ContinuityView {
  presence: {
    self: { agentName: string; availability: string; lane?: string; tempo?: string; updatedAt?: string } | null
    peers: Array<{ agentName: string; availability: string; lane?: string; updatedAt?: string }>
  }
  cares: { activeCount: number; items: Array<{ id: string; label: string; status: string; salience: string }> }
  episodes: { recentCount: number; items: Array<{ id: string; kind: string; summary: string; timestamp: string }> }
}

export function OverviewTab({ view, deskPrefs }: { view: Record<string, unknown>; deskPrefs?: Record<string, unknown> | null }) {
  const nav = useNavigate()
  const [needsMe, setNeedsMe] = useState<{ items: NeedsMeItem[] } | null>(null)
  const [codingDeep, setCodingDeep] = useState<{ items: Array<Record<string, unknown>> } | null>(null)
  const [continuity, setContinuity] = useState<ContinuityView | null>(null)
  const [orientation, setOrientation] = useState<OrientationView | null>(null)
  const [changes, setChanges] = useState<ChangesView | null>(null)
  const agent = view.agent as Record<string, unknown>
  const work = view.work as Record<string, unknown>
  const inner = view.inner as Record<string, unknown>
  const activity = view.activity as {
    freshness: { status: string }
    recent: Array<{ kind: string; at: string; label: string; detail: string }>
  }
  const degraded = agent.degraded as { status: string; issues: Array<{ code: string; detail: string }> }
  const attention = agent.attention as { level: string; label: string }
  const tasks = work.tasks as { liveCount: number; blockedCount: number }
  const obligations = work.obligations as { openCount: number }
  const sessions = work.sessions as { liveCount: number }
  const coding = work.coding as { activeCount: number; blockedCount: number }
  const senses = (agent.senses as string[]) ?? []
  const bridges = (work.bridges as string[]) ?? []

  useEffect(() => {
    fetchJson<{ items: NeedsMeItem[] }>(`/agents/${encodeURIComponent(agent.agentName as string)}/needs-me`).then(setNeedsMe)
    fetchJson<{ items: Array<Record<string, unknown>> }>(`/agents/${encodeURIComponent(agent.agentName as string)}/coding`).then(setCodingDeep)
    fetchJson<ContinuityView>(`/agents/${encodeURIComponent(agent.agentName as string)}/continuity`).then(setContinuity).catch(() => {})
    fetchJson<OrientationView>(`/agents/${encodeURIComponent(agent.agentName as string)}/orientation`).then(setOrientation).catch(() => {})
    fetchJson<ChangesView>(`/agents/${encodeURIComponent(agent.agentName as string)}/changes`).then(setChanges).catch(() => {})
  }, [agent.agentName])

  return (
    <div className="space-y-6">
      {/* "What needs me now" — triaged queue */}
      {needsMe && needsMe.items.length > 0 && (() => {
        const actionItems = needsMe.items.filter((i) => ACTION_URGENCIES.has(i.urgency))
        const staleItems = needsMe.items.filter((i) => STALE_URGENCIES.has(i.urgency))

        return (
          <div className="space-y-3">
            {/* Action now — things that need immediate attention */}
            {actionItems.length > 0 && (
              <div className="rounded-xl bg-ouro-fang/5 p-4 ring-1 ring-ouro-fang/15">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-fang">
                  Action now ({actionItems.length})
                </p>
                <div className="mt-2 space-y-1.5">
                  {actionItems.map((item, i) => (
                    <NeedsMeRow key={`action-${i}`} item={item} nav={nav} agentName={agent.agentName as string} onDismiss={() => {
                      setNeedsMe((prev) => prev ? { items: prev.items.filter((_, idx) => needsMe.items.indexOf(item) !== idx) } : prev)
                    }} />
                  ))}
                </div>
              </div>
            )}

            {/* Stale — old stuff that might need clearing */}
            {staleItems.length > 0 && (
              <div className="rounded-xl bg-ouro-gold/5 p-4 ring-1 ring-ouro-gold/15">
                <div className="flex items-center justify-between">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-gold">
                    Stale ({staleItems.length})
                  </p>
                  <button
                    onClick={async () => {
                      for (const item of staleItems) {
                        if (item.ref?.focus) {
                          await fetch(`/api/agents/${encodeURIComponent(agent.agentName as string)}/dismiss-obligation`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ obligationId: item.ref.focus }),
                          })
                        }
                      }
                      fetchJson<{ items: NeedsMeItem[] }>(`/agents/${encodeURIComponent(agent.agentName as string)}/needs-me`).then(setNeedsMe)
                    }}
                    className="text-xs text-ouro-gold underline underline-offset-2 hover:text-ouro-bone transition-colors"
                  >
                    Clear all stale
                  </button>
                </div>
                <div className="mt-2 space-y-1.5">
                  {staleItems.map((item, i) => (
                    <NeedsMeRow key={`stale-${i}`} item={item} nav={nav} agentName={agent.agentName as string} onDismiss={() => {
                      fetchJson<{ items: NeedsMeItem[] }>(`/agents/${encodeURIComponent(agent.agentName as string)}/needs-me`).then(setNeedsMe)
                    }} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* "What I'm carrying" — agent-written, editable via outlook-prefs.json */}
      {(deskPrefs as any)?.carrying && (
        <div className="rounded-xl bg-ouro-moss/10 p-4 ring-1 ring-ouro-glow/8">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">What I'm carrying</p>
          <p className="mt-1 text-sm leading-relaxed text-ouro-bone">{(deskPrefs as any).carrying}</p>
        </div>
      )}

      {/* Pinned constellations — linked threads */}
      {(() => {
        const constellations = ((deskPrefs as any)?.pinnedConstellations ?? []) as Array<Record<string, unknown>>
        if (constellations.length === 0) return null
        return (
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">Pinned threads</p>
            <div className="mt-2 space-y-2">
              {constellations.map((c, i) => (
                <div key={i} className="rounded-lg bg-ouro-void/40 px-3 py-2.5 ring-1 ring-ouro-moss/15">
                  <p className="font-medium text-ouro-bone">{c.label as string}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {((c.friendIds ?? []) as string[]).map((f) => (
                      <button key={f} onClick={() => nav({ tab: "sessions" })} className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2">friend:{f.slice(0,8)}…</button>
                    ))}
                    {((c.taskRefs ?? []) as string[]).map((t) => (
                      <button key={t} onClick={() => nav({ tab: "work" })} className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2">task:{t}</button>
                    ))}
                    {((c.bridgeIds ?? []) as string[]).map((b) => (
                      <button key={b} onClick={() => nav({ tab: "connections", focus: b })} className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2">bridge:{b.slice(0,8)}…</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Center of gravity */}
      <div className="rounded-xl bg-ouro-moss/15 p-4 ring-1 ring-ouro-glow/10 sm:p-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">
          Center of gravity
        </p>
        <p className="mt-1 font-display text-xl italic font-semibold text-ouro-bone sm:text-2xl">{attention.label}</p>
        <p className="mt-2 text-sm leading-relaxed text-ouro-mist">
          {agent.agentName as string} has{" "}
          <NavLink tab="work">{tasks.liveCount} live tasks</NavLink>,{" "}
          <NavLink tab="work">{obligations.openCount} obligations</NavLink>,{" "}
          <NavLink tab="work">{coding.activeCount} coding lanes</NavLink>, and{" "}
          <NavLink tab="sessions">{sessions.liveCount} live sessions</NavLink>.
        </p>

        {degraded.status === "degraded" && degraded.issues.length > 0 && (
          <div className="mt-3 space-y-1">
            {degraded.issues.slice(0, 5).map((issue, i) => (
              <button
                key={i}
                onClick={() => nav({ tab: "runtime" })}
                className="flex w-full items-start gap-2 rounded-lg bg-ouro-fang/5 px-3 py-2 text-left text-sm ring-1 ring-ouro-fang/10 hover:ring-ouro-fang/25 transition-colors"
              >
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-ouro-fang" />
                <span className="text-ouro-mist">
                  <span className="font-semibold text-ouro-fang">{issue.code}</span>
                  <span className="text-ouro-shadow"> — {truncate(issue.detail, 80)}</span>
                </span>
              </button>
            ))}
            {degraded.issues.length > 5 && (
              <button onClick={() => nav({ tab: "runtime" })} className="text-xs text-ouro-glow underline underline-offset-2">
                +{degraded.issues.length - 5} more issues
              </button>
            )}
          </div>
        )}
      </div>

      {/* Orientation — resume handle and primary obligation */}
      {orientation && (
        <div className="rounded-xl bg-ouro-moss/10 p-4 ring-1 ring-ouro-glow/8">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">Orientation</p>
          {orientation.currentSession && (
            <div className="mt-2 flex items-center gap-2">
              <Badge color="lime">active session</Badge>
              <button
                onClick={() => nav({ tab: "sessions", focus: `${orientation.currentSession!.friendId}/${orientation.currentSession!.channel}/${orientation.currentSession!.key}` })}
                className="text-sm text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2"
              >
                {orientation.currentSession.channel}/{orientation.currentSession.key}
              </button>
              {orientation.currentSession.lastActivityAt && (
                <span className="text-xs text-ouro-shadow">{relTime(orientation.currentSession.lastActivityAt)}</span>
              )}
            </div>
          )}
          {orientation.primaryObligation && (
            <div className="mt-2 rounded-lg bg-ouro-void/40 px-3 py-2 ring-1 ring-ouro-moss/15">
              <div className="flex items-center gap-2">
                <Badge color="yellow">{orientation.primaryObligation.status}</Badge>
                <span className="text-sm font-medium text-ouro-bone">{truncate(orientation.primaryObligation.content, 80)}</span>
              </div>
              {orientation.primaryObligation.nextAction && (
                <p className="mt-1 text-xs text-ouro-mist">Next: {orientation.primaryObligation.nextAction}</p>
              )}
              {orientation.primaryObligation.waitingOn && (
                <p className="mt-0.5 text-xs text-ouro-shadow">Waiting on: {orientation.primaryObligation.waitingOn}</p>
              )}
            </div>
          )}
          {orientation.resumeHandle && (
            <div className="mt-2 rounded-lg bg-ouro-void/40 px-3 py-2 ring-1 ring-ouro-moss/15">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">Resume handle</p>
              <div className="mt-1 space-y-0.5 text-sm">
                {orientation.resumeHandle.lane && <p className="text-ouro-bone">Lane: {orientation.resumeHandle.lane}</p>}
                {orientation.resumeHandle.artifact && <p className="text-ouro-mist">Artifact: {orientation.resumeHandle.artifact}</p>}
                {orientation.resumeHandle.nextAction && <p className="text-ouro-mist">Next: {orientation.resumeHandle.nextAction}</p>}
                {orientation.resumeHandle.blockerOrWaitingOn && <p className="text-ouro-shadow">Blocked: {orientation.resumeHandle.blockerOrWaitingOn}</p>}
                <Badge color={orientation.resumeHandle.confidence === "high" ? "lime" : orientation.resumeHandle.confidence === "medium" ? "yellow" : "zinc"}>
                  {orientation.resumeHandle.confidence} confidence
                </Badge>
              </div>
            </div>
          )}
          {orientation.otherActiveSessions.length > 0 && (
            <div className="mt-2">
              <p className="text-[10px] uppercase tracking-wider text-ouro-shadow">Other sessions ({orientation.otherActiveSessions.length})</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {orientation.otherActiveSessions.slice(0, 5).map((s) => (
                  <button
                    key={`${s.friendId}/${s.channel}/${s.key}`}
                    onClick={() => nav({ tab: "sessions", focus: `${s.friendId}/${s.channel}/${s.key}` })}
                    className="text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2"
                  >
                    {s.friendName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* What changed — cross-session drift */}
      {changes && changes.changeCount > 0 && (
        <div className="rounded-xl bg-ouro-gold/5 p-4 ring-1 ring-ouro-gold/15">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-gold">
            What changed ({changes.changeCount})
          </p>
          {changes.snapshotAge && (
            <p className="mt-0.5 text-xs text-ouro-shadow">Since {relTime(changes.snapshotAge)}</p>
          )}
          <div className="mt-2 space-y-1">
            {changes.items.slice(0, 8).map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Badge color={c.kind.includes("status") ? "yellow" : "zinc"}>{c.kind.replace(/_/g, " ")}</Badge>
                <span className="truncate text-ouro-mist">{c.summary}</span>
              </div>
            ))}
            {changes.items.length > 8 && (
              <p className="text-xs text-ouro-shadow">+{changes.items.length - 8} more changes</p>
            )}
          </div>
        </div>
      )}

      {/* Continuity — presence, cares, episodes */}
      {continuity && (
        <div className="grid gap-4 sm:grid-cols-3">
          {/* Self presence */}
          <div className="rounded-xl bg-ouro-void/50 p-4 ring-1 ring-ouro-moss/20">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">Presence</p>
            {continuity.presence.self ? (
              <div className="mt-2 space-y-1">
                <p className="text-sm font-medium text-ouro-bone">{continuity.presence.self.availability}</p>
                {continuity.presence.self.lane && (
                  <p className="text-xs text-ouro-shadow">Lane: {continuity.presence.self.lane}</p>
                )}
                {continuity.presence.self.tempo && (
                  <p className="text-xs text-ouro-shadow">Tempo: {continuity.presence.self.tempo}</p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-sm text-ouro-shadow">No presence data</p>
            )}
            {continuity.presence.peers.length > 0 && (
              <div className="mt-2 border-t border-ouro-moss/20 pt-2">
                <p className="text-[10px] uppercase tracking-wider text-ouro-shadow">Peers</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {continuity.presence.peers.map((p) => (
                    <Badge key={p.agentName} color={p.availability === "active" ? "lime" : "zinc"}>
                      {p.agentName}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Active cares */}
          <div className="rounded-xl bg-ouro-void/50 p-4 ring-1 ring-ouro-moss/20">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">
              Cares ({continuity.cares.activeCount})
            </p>
            {continuity.cares.items.length > 0 ? (
              <div className="mt-2 space-y-1.5">
                {continuity.cares.items.slice(0, 5).map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <Badge color={c.salience === "high" ? "red" : c.salience === "medium" ? "yellow" : "zinc"}>
                      {c.salience}
                    </Badge>
                    <p className="truncate text-sm text-ouro-bone">{c.label}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-ouro-shadow">No active cares</p>
            )}
          </div>

          {/* Recent episodes */}
          <div className="rounded-xl bg-ouro-void/50 p-4 ring-1 ring-ouro-moss/20">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">
              Episodes ({continuity.episodes.recentCount})
            </p>
            {continuity.episodes.items.length > 0 ? (
              <div className="mt-2 space-y-1.5">
                {continuity.episodes.items.slice(0, 5).map((ep) => (
                  <div key={ep.id} className="flex items-start gap-2">
                    <Badge color="zinc">{ep.kind}</Badge>
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ouro-bone">{ep.summary}</p>
                      <p className="text-xs text-ouro-shadow">{relTime(ep.timestamp)}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-ouro-shadow">No recent episodes</p>
            )}
          </div>
        </div>
      )}

      {/* Meters */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Meter label="Tasks" value={tasks.liveCount} sub={`${tasks.blockedCount} blocked`} onClick={() => nav({ tab: "work" })} />
        <Meter label="Obligations" value={obligations.openCount} sub={`${sessions.liveCount} sessions`} onClick={() => nav({ tab: "work" })} />
        <Meter label="Coding" value={coding.activeCount} sub={`${coding.blockedCount} blocked`} onClick={() => nav({ tab: "work" })} />
        <Meter label="Inner" value={inner.status as string} sub={truncate((inner.summary as string) ?? "", 30)} onClick={() => nav({ tab: "inner" })} />
      </div>

      {/* Active coding sessions — visible from overview */}
      {codingDeep && codingDeep.items.length > 0 && (() => {
        const active = codingDeep.items.filter((c) => ["spawning","running","waiting_input","stalled"].includes(c.status as string))
        if (active.length === 0) return null
        return (
          <Section title={`Active coding (${active.length})`}>
            <div className="space-y-1.5">
              {active.map((c) => (
                <button
                  key={c.id as string}
                  onClick={() => nav({ tab: "work" })}
                  className="flex w-full items-center gap-2 rounded-lg bg-ouro-void/40 px-3 py-2 text-left ring-1 ring-ouro-moss/15 hover:ring-ouro-glow/20 transition-colors"
                >
                  <Badge color={(c.status as string) === "running" ? "lime" : (c.status as string) === "waiting_input" ? "yellow" : "zinc"}>
                    {c.status as string}
                  </Badge>
                  <span className="truncate text-sm text-ouro-bone">{c.runner as string} — {truncate(c.workdir as string, 40)}</span>
                  <span className="shrink-0 text-xs text-ouro-shadow">{relTime(c.lastActivityAt as string)}</span>
                </button>
              ))}
            </div>
          </Section>
        )
      })()}

      {/* Senses + Bridges */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Senses">
          {senses.length > 0
            ? <Pills items={senses} />
            : <Muted>No active senses</Muted>}
        </Section>
        <Section title="Bridges">
          {bridges.length > 0
            ? <div className="flex flex-wrap gap-1.5">
                {bridges.map((b) => (
                  <button key={b} onClick={() => nav({ tab: "connections", focus: b })}>
                    <Badge color="lime">{b}</Badge>
                  </button>
                ))}
              </div>
            : <Muted>No active bridges</Muted>}
        </Section>
      </div>

      {/* Recently closed — closure memory */}
      {(() => {
        const allObligations = (work.obligations as any)?.items ?? []
        const fulfilled = allObligations.filter((o: any) => o.status === "fulfilled")
        if (fulfilled.length === 0) return null
        return (
          <Section title="Recently closed">
            <div className="space-y-1">
              {fulfilled.slice(0, 3).map((o: any, i: number) => (
                <div key={i} className="flex items-center gap-2 rounded-lg px-3 py-2 bg-ouro-glow/5 ring-1 ring-ouro-glow/10">
                  <Badge color="lime">closed</Badge>
                  <p className="text-sm text-ouro-mist truncate">{truncate(o.content, 80)}</p>
                  <span className="shrink-0 text-xs text-ouro-shadow">{relTime(o.updatedAt)}</span>
                </div>
              ))}
            </div>
          </Section>
        )
      })()}

      {/* Recent activity */}
      <Section title="Recent activity">
        {activity.recent.length > 0 ? (
          <div className="space-y-1">
            {activity.recent.map((item, i) => {
              const tab: TabId = item.kind === "coding" || item.kind === "obligation" ? "work"
                : item.kind === "session" ? "sessions" : "inner"
              return (
                <button
                  key={i}
                  onClick={() => nav({ tab })}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left hover:bg-ouro-moss/10 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Badge>{item.kind}</Badge>
                    <span className="text-xs text-ouro-shadow">{relTime(item.at)}</span>
                  </div>
                  <p className="truncate text-sm font-medium text-ouro-bone">{truncate(item.label, 100)}</p>
                  <p className="truncate text-xs text-ouro-shadow">{truncate(item.detail, 80)}</p>
                </button>
              )
            })}
          </div>
        ) : (
          <Muted>No recent activity yet.</Muted>
        )}
      </Section>
    </div>
  )
}

function NeedsMeRow({ item, nav, agentName, onDismiss }: { item: NeedsMeItem; nav: (t: { tab: TabId; focus?: string }) => void; agentName: string; onDismiss: () => void }) {
  const isReturnReady = item.urgency === "return-ready"
  return (
    <div className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left ring-1 transition-colors ${
      isReturnReady ? "bg-ouro-glow/5 ring-ouro-glow/15" : "bg-ouro-void/40 ring-ouro-moss/10"
    }`}>
      <button
        onClick={() => item.ref && nav({ tab: item.ref.tab as TabId, focus: item.ref.focus })}
        className="flex min-w-0 flex-1 items-start gap-2.5"
      >
        <Badge color={URGENCY_COLORS[item.urgency] ?? "zinc"}>
          {URGENCY_LABELS[item.urgency] ?? item.urgency}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${isReturnReady ? "text-ouro-glow" : "text-ouro-bone"}`}>{item.label}</p>
          <p className="text-xs text-ouro-shadow truncate">{item.detail}</p>
          <p className="text-[10px] italic text-ouro-shadow/60 mt-0.5">{URGENCY_WHY[item.urgency] ?? ""}</p>
        </div>
        {item.ageMs != null && (
          <span className="shrink-0 text-xs tabular-nums text-ouro-shadow">
            {item.ageMs < 3600000 ? `${Math.floor(item.ageMs / 60000)}m` : item.ageMs < 86400000 ? `${Math.floor(item.ageMs / 3600000)}h` : `${Math.floor(item.ageMs / 86400000)}d`}
          </span>
        )}
      </button>
      {item.ref?.focus && (
        <button
          onClick={async (e) => {
            e.stopPropagation()
            await fetch(`/api/agents/${encodeURIComponent(agentName)}/dismiss-obligation`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ obligationId: item.ref!.focus }),
            })
            onDismiss()
          }}
          className="shrink-0 text-xs text-ouro-shadow hover:text-ouro-fang transition-colors"
          title="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  )
}

function NavLink({ tab, children }: { tab: TabId; children: React.ReactNode }) {
  const nav = useNavigate()
  return (
    <button onClick={() => nav({ tab })} className="text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow transition-colors">
      {children}
    </button>
  )
}

function Meter({ label, value, sub, onClick }: { label: string; value: string | number; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-xl bg-ouro-void/50 p-3 text-left ring-1 ring-ouro-moss/20 hover:ring-ouro-glow/20 transition-all">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ouro-shadow">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ouro-bone">{value}</p>
      <p className="mt-0.5 truncate text-xs text-ouro-shadow">{sub}</p>
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">{title}</p>
      <div className="mt-2">{children}</div>
    </div>
  )
}

function Pills({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((s) => <Badge key={s} color="lime">{s}</Badge>)}
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ouro-shadow">{children}</p>
}
