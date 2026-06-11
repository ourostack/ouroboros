import { useEffect, useRef, useState, type ReactNode } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { classifyToolCall } from "../../tools"
import { useNavigate } from "../../navigation"
import { useStickyScroll } from "../../hooks/use-sticky-scroll"
import type {
  MailboxAgentView,
  MailboxHabitItem,
  MailboxHabitRunSummary,
  MailboxHabitRunView,
  MailboxHabitView,
  MailboxSessionTranscript,
  MailboxTranscriptMessage as TranscriptMessage,
} from "../../contracts"
import {
  getMailboxTranscriptMessageText,
  getMailboxTranscriptTimestamp,
} from "../../contracts"

function transcriptTimestamp(msg: TranscriptMessage): string {
  return getMailboxTranscriptTimestamp(msg)
}

function formatTranscriptTimestamp(msg: TranscriptMessage): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(transcriptTimestamp(msg)))
}

export function InnerTab({ agentName, view, refreshGeneration }: { agentName: string; view: MailboxAgentView; refreshGeneration: number }) {
  const nav = useNavigate()
  const [habits, setHabits] = useState<MailboxHabitView | null>(null)
  const [habitRuns, setHabitRuns] = useState<MailboxHabitRunView | null>(null)
  const [habitRunsError, setHabitRunsError] = useState(false)
  const [transcript, setTranscript] = useState<MailboxSessionTranscript | null>(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const transcriptRefreshRef = useRef<number | null>(null)
  const inner = view.inner

  useEffect(() => {
    fetchJson<MailboxHabitView>(`/agents/${encodeURIComponent(agentName)}/habits`).then(setHabits)
  }, [agentName, refreshGeneration])

  useEffect(() => {
    let cancelled = false
    setHabitRunsError(false)
    fetchJson<MailboxHabitRunView>(`/agents/${encodeURIComponent(agentName)}/habit-runs`)
      .then((data) => {
        if (!cancelled) setHabitRuns(data)
      })
      .catch(() => {
        if (!cancelled) setHabitRunsError(true)
      })
    return () => { cancelled = true }
  }, [agentName, refreshGeneration])

  useEffect(() => {
    if (!transcript) return
    if (transcriptRefreshRef.current === refreshGeneration) return
    transcriptRefreshRef.current = refreshGeneration
    fetchJson<MailboxSessionTranscript>(`/agents/${encodeURIComponent(agentName)}/inner-transcript`).then(setTranscript)
  }, [agentName, refreshGeneration, transcript !== null])

  function loadTranscript() {
    if (transcript) { setShowTranscript(!showTranscript); return }
    fetchJson<MailboxSessionTranscript>(`/agents/${encodeURIComponent(agentName)}/inner-transcript`)
      .then((data) => {
        transcriptRefreshRef.current = refreshGeneration
        setTranscript(data)
        setShowTranscript(true)
      })
  }

  const habitItems = habits?.items ?? []
  const habitRunItems = habitRuns?.items ?? []
  const overdueHabits = habitItems.filter((h) => h.isOverdue)
  const activeHealthy = habitItems.filter((h) => h.status === "active" && !h.isOverdue)
  const pausedHabits = habitItems.filter((h) => h.status === "paused")
  const innerOrigin = inner.mode === "deep" ? inner.origin : null
  const innerObligationStatus = inner.mode === "deep" ? inner.obligationStatus : null

  // Find heartbeat specifically
  const heartbeat = habitItems.find((h) => h.name.toLowerCase() === "heartbeat")

  return (
    <div className="space-y-8">
      {/* Heartbeat — front and center */}
      {heartbeat && (
        <section>
          <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">Heartbeat</p>
          <div className={`mt-2 rounded-xl p-4 ring-1 ${
            heartbeat.isOverdue ? "bg-ouro-fang/5 ring-ouro-fang/15" : "bg-ouro-moss/10 ring-ouro-glow/10"
          }`}>
            <div className="flex items-center gap-2">
              <div className={`h-2.5 w-2.5 rounded-full ${
                heartbeat.isOverdue ? "bg-ouro-fang animate-pulse" : "bg-ouro-glow"
              }`} />
              <span className="font-medium text-ouro-bone">
                {heartbeat.isOverdue ? "Overdue" : "Healthy"}
              </span>
              <span className="text-xs text-ouro-shadow">
                every {heartbeat.cadence ?? "unknown"} · last {heartbeat.lastRun ? relTime(heartbeat.lastRun) : "never"}
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Inner work status */}
      <section>
        <div className="rounded-xl bg-ouro-moss/15 p-4 ring-1 ring-ouro-glow/10">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">Inner work</p>
          <p className="mt-1 font-display text-xl italic font-semibold text-ouro-bone">{inner.status}</p>
          {inner.summary && <p className="mt-2 text-sm leading-relaxed text-ouro-mist">{inner.summary}</p>}
          <p className="mt-2 text-sm text-ouro-shadow">
            {inner.hasPending ? "Pending inner work queued." : "No pending inner work."}
          </p>
          {(inner.returnObligationQueue.queuedCount > 0 || inner.returnObligationQueue.runningCount > 0) && (
            <p className="mt-1 text-sm text-ouro-mist">
              Held work items:{" "}
              <span className="font-medium text-ouro-bone">{inner.returnObligationQueue.queuedCount + inner.returnObligationQueue.runningCount}</span>
              {" "}({inner.returnObligationQueue.queuedCount} queued
              {inner.returnObligationQueue.runningCount > 0 ? `, ${inner.returnObligationQueue.runningCount} running` : ""})
              {inner.returnObligationQueue.oldestActiveAt !== null && (
                <span className="text-ouro-shadow"> · oldest {relTime(new Date(inner.returnObligationQueue.oldestActiveAt).toISOString())}</span>
              )}
            </p>
          )}
          {innerOrigin && (
            <div className="mt-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">Triggered from</p>
              <button
                onClick={() => {
                  nav({ tab: "sessions", focus: `${innerOrigin.friendId}/${innerOrigin.channel}/${innerOrigin.key}` })
                }}
                className="mt-1 text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow"
              >
                {innerOrigin.friendId.slice(0, 8)}…/{innerOrigin.channel}/{innerOrigin.key}
              </button>
              {innerObligationStatus && (
                <button
                  onClick={() => nav({ tab: "work" })}
                  className="ml-2 text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow"
                >
                  obligation: {innerObligationStatus}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Habit session receipts — explicit private work ledger */}
      <section>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">Habit sessions</p>
            <p className="mt-1 text-xs text-ouro-shadow">
              {habitRuns ? `${habitRuns.totalCount} recorded` : habitRunsError ? "Run history unavailable" : "Loading runs"}
            </p>
          </div>
          {habitRuns && habitRuns.totalCount > habitRunItems.length && (
            <span className="shrink-0 font-mono text-[10px] text-ouro-shadow">
              showing {habitRunItems.length}/{habitRuns.totalCount}
            </span>
          )}
        </div>

        {!habitRuns ? (
          <p className="mt-2 text-sm text-ouro-shadow">
            {habitRunsError ? "Habit sessions unavailable." : "Loading habit sessions."}
          </p>
        ) : habitRunItems.length > 0 ? (
          <div className="mt-3 space-y-2">
            {habitRunItems.map((run) => <HabitRunRow key={run.runId} run={run} />)}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ouro-shadow">No habit sessions recorded.</p>
        )}
      </section>

      {/* Inner dialog — always show recent, load more on demand */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">
          Inner dialog {transcript ? `(${transcript.messages.length} total)` : ""}
        </p>
        {!transcript ? (
          <button
            onClick={loadTranscript}
            className="mt-2 w-full rounded-lg px-3 py-2.5 text-left font-mono text-xs text-ouro-glow ring-1 ring-ouro-moss/15 hover:ring-ouro-glow/20 transition-colors"
          >
            Load inner dialog
          </button>
        ) : (
          <InnerTranscriptView messages={transcript.messages} />
        )}
      </section>

      {/* Habits — triage */}
      <section>
        <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">
          Habits ({habits?.totalCount ?? 0})
        </p>

        {overdueHabits.length > 0 && (
          <div className="mt-3">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-fang mb-1.5">
              Overdue ({overdueHabits.length})
            </p>
            <div className="space-y-1.5">
              {overdueHabits.map((h) => <HabitCard key={h.name} h={h} />)}
            </div>
          </div>
        )}

        {activeHealthy.length > 0 && (
          <div className="mt-3">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow mb-1.5">
              Running fine ({activeHealthy.length})
            </p>
            <div className="space-y-1.5">
              {activeHealthy.map((h) => <HabitCard key={h.name} h={h} />)}
            </div>
          </div>
        )}

        {pausedHabits.length > 0 && (
          <div className="mt-3">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow mb-1.5">
              Paused ({pausedHabits.length})
            </p>
            <div className="space-y-1.5">
              {pausedHabits.map((h) => <HabitCard key={h.name} h={h} />)}
            </div>
          </div>
        )}

        {habitItems.length === 0 && (
          <p className="mt-2 text-sm text-ouro-shadow">No habits configured.</p>
        )}
      </section>
    </div>
  )
}

function outcomeTone(outcome: MailboxHabitRunSummary["outcome"]): "good" | "warn" | "bad" | "quiet" {
  if (outcome === "error" || outcome === "blocked") return "bad"
  if (outcome === "surfaced" || outcome === "wrote_arc" || outcome === "updated_desk" || outcome === "wrote_record") return "good"
  if (outcome === "no_change") return "quiet"
  return "warn"
}

function outcomeClass(outcome: MailboxHabitRunSummary["outcome"]): string {
  const tone = outcomeTone(outcome)
  if (tone === "bad") return "bg-ouro-fang/10 text-ouro-fang ring-ouro-fang/20"
  if (tone === "good") return "bg-ouro-scale/10 text-ouro-glow ring-ouro-scale/20"
  if (tone === "warn") return "bg-ouro-gold/10 text-ouro-gold ring-ouro-gold/20"
  return "bg-ouro-void/60 text-ouro-shadow ring-ouro-moss/15"
}

function HabitRunRow({ run }: { run: MailboxHabitRunSummary }) {
  const routes = run.permissionEnvelope.returnRoutes
  const attempts = run.surfaceAttempts
  const deniedTools = Array.from(new Set([
    ...run.permissionEnvelope.deniedTools,
    ...run.toolPolicy.deniedTools,
  ]))

  return (
    <article className="rounded-lg bg-ouro-void/45 px-3 py-3 ring-1 ring-ouro-moss/15">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ring-1 ${outcomeClass(run.outcome)}`}>
              {run.outcome}
            </span>
            <span className="min-w-0 break-all font-medium text-ouro-bone">{run.habitName}</span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-ouro-shadow">{run.trigger}</span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-ouro-shadow break-all">{run.runId}</p>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <p className="font-mono text-[10px] text-ouro-shadow">{relTime(run.endedAt)}</p>
          {run.nextRunAt && <p className="font-mono text-[10px] text-ouro-glow">next {relTime(run.nextRunAt)}</p>}
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-3">
        <RunFact label="routes">
          {routes.length > 0 ? (
            <div className="space-y-1.5">
              {routes.map((route, index) => (
                <div key={`${route.kind}-${route.recipient}-${index}`} className="min-w-0">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="max-w-full break-all rounded bg-ouro-moss/20 px-1.5 py-0.5 font-mono text-[10px] text-ouro-mist ring-1 ring-ouro-moss/20">
                      {route.kind}
                    </span>
                    <span className="max-w-full break-all rounded bg-ouro-void/60 px-1.5 py-0.5 font-mono text-[10px] text-ouro-shadow ring-1 ring-ouro-moss/15">
                      {route.status}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-ouro-shadow break-all">{route.recipient}</p>
                  {(route.friendId || route.channel || route.key) && [route.friendId, route.channel, route.key].filter(Boolean).join("/") !== route.recipient && (
                    <p className="mt-0.5 font-mono text-[10px] text-ouro-shadow/70 break-all">
                      {[route.friendId, route.channel, route.key].filter(Boolean).join("/")}
                    </p>
                  )}
                  {route.reason && <p className="mt-0.5 text-[11px] text-ouro-shadow break-words">{route.reason}</p>}
                </div>
              ))}
            </div>
          ) : (
            <span className="text-ouro-shadow">none</span>
          )}
          <p className="mt-1 text-[11px] text-ouro-shadow">
            outward {run.permissionEnvelope.canMessageOutward ? "allowed" : "closed"}
          </p>
          {run.permissionEnvelope.warnings.length > 0 && (
            <div className="mt-1.5 space-y-1">
              {run.permissionEnvelope.warnings.map((warning, index) => (
                <p key={`${warning}-${index}`} className="text-[11px] text-ouro-gold break-words">{warning}</p>
              ))}
            </div>
          )}
        </RunFact>

        <RunFact label="attempts">
          {attempts.length > 0 ? (
            <div className="space-y-1">
              {attempts.map((attempt, index) => (
                <div key={`${attempt.recipient}-${attempt.channel}-${index}`} className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-ouro-moss/20 px-1.5 py-0.5 font-mono text-[10px] text-ouro-bone ring-1 ring-ouro-moss/20">
                      {attempt.result}
                    </span>
                    <span className="text-[11px] text-ouro-shadow">{attempt.reason}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-ouro-shadow break-all">
                    {attempt.recipient}/{attempt.channel}
                    {attempt.error ? ` - ${attempt.error}` : ""}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-ouro-shadow">none</span>
          )}
        </RunFact>

        <RunFact label="tools">
          <div className="flex flex-wrap gap-1.5">
            {run.toolPolicy.grantedTools.map((tool) => (
              <span key={`granted-${tool}`} className="max-w-full break-all rounded bg-ouro-scale/10 px-1.5 py-0.5 font-mono text-[10px] text-ouro-glow ring-1 ring-ouro-scale/15">{tool}</span>
            ))}
            {deniedTools.map((tool) => (
              <span key={`denied-${tool}`} className="max-w-full break-all rounded bg-ouro-fang/8 px-1.5 py-0.5 font-mono text-[10px] text-ouro-fang ring-1 ring-ouro-fang/15">{tool}</span>
            ))}
            {run.toolPolicy.grantedTools.length === 0 && deniedTools.length === 0 && <span className="text-ouro-shadow">none</span>}
          </div>
          {run.errorCount > 0 && <p className="mt-1 font-mono text-[10px] text-ouro-fang">{run.errorCount} error{run.errorCount === 1 ? "" : "s"}</p>}
        </RunFact>
      </div>

      {(run.producedRefs.length > 0 || run.receiptLocator) && (
        <div className="mt-3 border-t border-ouro-moss/15 pt-2">
          {run.producedRefs.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {run.producedRefs.map((ref, index) => (
                <span key={`${ref.kind}-${ref.locator}-${index}`} className="max-w-full break-all rounded bg-ouro-void/60 px-1.5 py-0.5 font-mono text-[10px] text-ouro-shadow ring-1 ring-ouro-moss/10">
                  {ref.kind}: {ref.locator}
                </span>
              ))}
            </div>
          )}
          <p className="font-mono text-[10px] text-ouro-shadow break-all">{run.receiptLocator}</p>
        </div>
      )}
    </article>
  )
}

function RunFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-l border-ouro-moss/15 pl-2.5">
      <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">{label}</p>
      <div className="min-w-0 text-xs text-ouro-mist">{children}</div>
    </div>
  )
}

function InnerTranscriptView({ messages }: { messages: TranscriptMessage[] }) {
  const conversation = messages.filter((m) => m.role !== "system" && m.role !== "tool")
  const [showAll, setShowAll] = useState(false)

  const RECENT = 30
  const visible = showAll ? conversation : conversation.slice(-RECENT)
  const hiddenCount = conversation.length - visible.length
  const latestVisibleId = visible[visible.length - 1]?.id ?? null
  const { ref: containerRef, onScroll, preserveScroll } = useStickyScroll<HTMLDivElement>(latestVisibleId)

  // Extract landmarks for navigation
  const landmarks: Array<{ index: number; kind: string; label: string }> = []
  for (const m of conversation) {
    if (m.role !== "assistant") continue
    const calls = (m.toolCalls ?? []).map(classifyToolCall)
    for (const c of calls) {
      if (c.kind === "surface") landmarks.push({ index: m.sequence, kind: "surfaced", label: truncate(c.deliveredText ?? "", 40) })
      if (c.kind === "rest") landmarks.push({ index: m.sequence, kind: "resting", label: "resting" })
      if (c.kind === "delegation") landmarks.push({ index: m.sequence, kind: "delegated", label: "continued thinking" })
    }
  }

  function scrollToMessage(index: number) {
    const el = containerRef.current?.querySelector(`[data-msg-index="${index}"]`)
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  return (
    <div>
      {/* Landmark navigation bar */}
      {landmarks.length > 0 && (
        <div className="mt-2 mb-1 flex flex-wrap gap-1">
          {landmarks.map((lm, i) => (
            <button
              key={i}
              onClick={() => {
                preserveScroll()
                setShowAll(true)
                setTimeout(() => scrollToMessage(lm.index), 100)
              }}
              className={`rounded-md px-2 py-0.5 text-[10px] font-mono ring-1 transition-colors ${
                lm.kind === "surfaced" ? "bg-ouro-scale/10 text-ouro-glow ring-ouro-scale/20 hover:ring-ouro-glow/30"
                  : lm.kind === "resting" ? "bg-ouro-void/40 text-ouro-shadow ring-ouro-moss/10"
                    : "bg-ouro-gold/5 text-ouro-gold ring-ouro-gold/10"
              }`}
            >
              {lm.kind === "surfaced" ? "★" : lm.kind === "resting" ? "—" : "→"} #{lm.index}
            </button>
          ))}
        </div>
      )}

      <div
        ref={containerRef}
        data-testid="inner-transcript-scroll"
        onScroll={onScroll}
        className="max-h-[60vh] overflow-y-auto rounded-lg bg-ouro-void/60 p-3 ring-1 ring-ouro-moss/15 space-y-1"
      >
      {hiddenCount > 0 && (
        <button
          onClick={() => {
            preserveScroll()
            setShowAll(true)
          }}
          className="w-full rounded-lg px-3 py-2 text-center font-mono text-xs text-ouro-shadow hover:text-ouro-mist ring-1 ring-ouro-moss/10 hover:ring-ouro-moss/20 transition-colors mb-2"
        >
          Load {hiddenCount} earlier messages
        </button>
      )}
      {visible.map((m) => {
        const text = getMailboxTranscriptMessageText(m)
        if (m.role === "user") {
          const isDelegated = text.includes("[pending from") || text.includes("[delegated")
          const isWakeUp = text.includes("waking up") || text.includes("world-state checkpoint")
          return (
            <div key={m.id} data-msg-index={m.sequence} className="flex justify-start py-1">
              <div className={`max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 ring-1 ${
                isDelegated
                  ? "bg-ouro-gold/8 ring-ouro-gold/15"
                  : isWakeUp
                    ? "bg-ouro-moss/20 ring-ouro-moss/15"
                    : "bg-ouro-moss/25 ring-ouro-moss/15"
              }`}>
                <div className="flex items-center gap-2 mb-0.5">
                  <p className="font-mono text-[9px] uppercase tracking-wider" style={{
                    color: isDelegated ? "var(--color-ouro-gold)" : "var(--color-ouro-shadow)"
                  }}>
                    {isDelegated ? "★ delegated" : isWakeUp ? "heartbeat" : "prompt"}
                  </p>
                  <span className="font-mono text-[9px] text-ouro-shadow/40">#{m.sequence}</span>
                  <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(m)}</span>
                </div>
                <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">
                  {text}
                </p>
              </div>
            </div>
          )
        }

        if (m.role === "assistant") {
          const classified = (m.toolCalls ?? []).map(classifyToolCall)
          const surfaces = classified.filter((c) => c.kind === "surface")
          const rests = classified.filter((c) => c.kind === "rest")
          const ponders = classified.filter((c) => c.kind === "delegation")

          return (
            <div key={m.id} data-msg-index={m.sequence}>
              {/* Surface = conclusion delivered outward — landmark */}
              {surfaces.map((sc) => (
                <div key={sc.id} className="flex justify-end py-1">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ouro-scale/15 px-3 py-2 ring-1 ring-ouro-scale/20">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow">★ surfaced outward</p>
                      <span className="font-mono text-[9px] text-ouro-shadow/40">#{m.sequence}</span>
                      <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(m)}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">{sc.deliveredText}</p>
                    {sc.metadata && <p className="mt-1 font-mono text-[9px] text-ouro-shadow">→ {sc.metadata}</p>}
                  </div>
                </div>
              ))}

              {ponders.length > 0 && (
                <div className="py-1 text-center font-mono text-[10px] text-ouro-gold/50">— still thinking — #{m.sequence} · {formatTranscriptTimestamp(m)}</div>
              )}

              {rests.length > 0 && (
                <div className="py-1 text-center font-mono text-[10px] text-ouro-shadow/40">— resting — #{m.sequence} · {formatTranscriptTimestamp(m)}</div>
              )}

              {/* Regular thinking (no mechanism calls) */}
              {surfaces.length === 0 && rests.length === 0 && ponders.length === 0 && text && (
                <div className="flex justify-end py-1">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ouro-glow/6 px-3 py-2 ring-1 ring-ouro-glow/8">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow/50">thinking</p>
                      <span className="font-mono text-[9px] text-ouro-shadow/40">#{m.sequence}</span>
                      <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(m)}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-ouro-mist whitespace-pre-wrap break-words">{text}</p>
                  </div>
                </div>
              )}
            </div>
          )
        }
        return null
      })}
      </div>
    </div>
  )
}

function HabitCard({ h }: { h: MailboxHabitItem }) {
  const isOverdue = h.isOverdue
  const isDegraded = h.isDegraded
  const status = h.status

  return (
    <div className={`rounded-lg px-3 py-2.5 ring-1 ${
      isOverdue ? "bg-ouro-fang/5 ring-ouro-fang/15"
        : isDegraded ? "bg-ouro-gold/5 ring-ouro-gold/15"
          : status === "paused" ? "bg-ouro-void/30 ring-ouro-moss/10"
            : "bg-ouro-void/40 ring-ouro-moss/15"
    }`}>
      <div className="flex items-center gap-2">
        <Badge color={isOverdue ? "red" : isDegraded ? "yellow" : status === "active" ? "lime" : "zinc"}>
          {isOverdue ? "overdue" : isDegraded ? "degraded" : status}
        </Badge>
        <span className="font-medium text-ouro-bone">{h.title}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-ouro-shadow">
        {h.cadence && <span>every {h.cadence}</span>}
        <span>{h.lastRun ? `last ${relTime(h.lastRun)}` : "never run"}</span>
        {isDegraded && h.degradedReason && <span className="text-ouro-gold">{h.degradedReason}</span>}
        {/* Confidence indicator */}
        {!isOverdue && !isDegraded && status === "active" && h.lastRun && (
          <span className="text-ouro-glow">on schedule</span>
        )}
        {isOverdue && h.overdueMs && (
          <span className="text-ouro-fang">{Math.floor(h.overdueMs / 60000)}m overdue</span>
        )}
        {!h.lastRun && status === "active" && (
          <span className="text-ouro-gold">never fired — may be misconfigured</span>
        )}
      </div>
      {h.bodyExcerpt && <p className="mt-1 text-xs text-ouro-shadow/70">{h.bodyExcerpt}</p>}
    </div>
  )
}
