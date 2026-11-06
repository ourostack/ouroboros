import { useEffect, useRef, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { classifyToolCall } from "../../tools"
import { useNavigate } from "../../navigation"
import { useStickyScroll } from "../../hooks/use-sticky-scroll"
import type {
  OutlookAgentView,
  OutlookHabitItem,
  OutlookHabitView,
  OutlookSessionTranscript,
  OutlookTranscriptMessage as TranscriptMessage,
} from "../../contracts"
import {
  getOutlookTranscriptMessageText,
  getOutlookTranscriptTimestamp,
} from "../../contracts"

function transcriptTimestamp(msg: TranscriptMessage): string {
  return getOutlookTranscriptTimestamp(msg)
}

function formatTranscriptTimestamp(msg: TranscriptMessage): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(transcriptTimestamp(msg)))
}

export function InnerTab({ agentName, view, refreshGeneration }: { agentName: string; view: OutlookAgentView; refreshGeneration: number }) {
  const nav = useNavigate()
  const [habits, setHabits] = useState<OutlookHabitView | null>(null)
  const [transcript, setTranscript] = useState<OutlookSessionTranscript | null>(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const transcriptRefreshRef = useRef<number | null>(null)
  const inner = view.inner

  useEffect(() => {
    fetchJson<OutlookHabitView>(`/agents/${encodeURIComponent(agentName)}/habits`).then(setHabits)
  }, [agentName, refreshGeneration])

  useEffect(() => {
    if (!transcript) return
    if (transcriptRefreshRef.current === refreshGeneration) return
    transcriptRefreshRef.current = refreshGeneration
    fetchJson<OutlookSessionTranscript>(`/agents/${encodeURIComponent(agentName)}/inner-transcript`).then(setTranscript)
  }, [agentName, refreshGeneration, transcript !== null])

  function loadTranscript() {
    if (transcript) { setShowTranscript(!showTranscript); return }
    fetchJson<OutlookSessionTranscript>(`/agents/${encodeURIComponent(agentName)}/inner-transcript`)
      .then((data) => {
        transcriptRefreshRef.current = refreshGeneration
        setTranscript(data)
        setShowTranscript(true)
      })
  }

  const habitItems = habits?.items ?? []
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
        const text = getOutlookTranscriptMessageText(m)
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

function HabitCard({ h }: { h: OutlookHabitItem }) {
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
