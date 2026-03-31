import { useEffect, useRef, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { classifyToolCall } from "../../tools"
import { useNavigate } from "../../navigation"

interface TranscriptMessage {
  index: number
  role: string
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
}

export function InnerTab({ agentName, view }: { agentName: string; view: Record<string, unknown> }) {
  const nav = useNavigate()
  const [habits, setHabits] = useState<Record<string, unknown> | null>(null)
  const [transcript, setTranscript] = useState<{ messages: TranscriptMessage[] } | null>(null)
  const [showTranscript, setShowTranscript] = useState(false)
  const inner = view.inner as Record<string, unknown>

  useEffect(() => {
    fetchJson<Record<string, unknown>>(`/agents/${encodeURIComponent(agentName)}/habits`).then(setHabits)
  }, [agentName])

  function loadTranscript() {
    if (transcript) { setShowTranscript(!showTranscript); return }
    fetchJson<{ messages: TranscriptMessage[] }>(`/agents/${encodeURIComponent(agentName)}/inner-transcript`)
      .then((data) => { setTranscript(data); setShowTranscript(true) })
  }

  const habitItems = (habits?.items ?? []) as Array<Record<string, unknown>>
  const overdueHabits = habitItems.filter((h) => h.isOverdue)
  const activeHealthy = habitItems.filter((h) => h.status === "active" && !h.isOverdue)
  const pausedHabits = habitItems.filter((h) => h.status === "paused")

  // Find heartbeat specifically
  const heartbeat = habitItems.find((h) => (h.name as string)?.toLowerCase() === "heartbeat")

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
                every {heartbeat.cadence as string} · last {heartbeat.lastRun ? relTime(heartbeat.lastRun as string) : "never"}
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Inner work status */}
      <section>
        <div className="rounded-xl bg-ouro-moss/15 p-4 ring-1 ring-ouro-glow/10">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ouro-glow">Inner work</p>
          <p className="mt-1 font-display text-xl italic font-semibold text-ouro-bone">{inner.status as string}</p>
          {inner.summary && <p className="mt-2 text-sm leading-relaxed text-ouro-mist">{inner.summary as string}</p>}
          <p className="mt-2 text-sm text-ouro-shadow">
            {inner.hasPending ? "Pending inner work queued." : "No pending inner work."}
          </p>
          {inner.mode === "deep" && inner.origin && (
            <div className="mt-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow">Triggered from</p>
              <button
                onClick={() => {
                  const o = inner.origin as Record<string, string>
                  nav({ tab: "sessions", focus: `${o.friendId}/${o.channel}/${o.key}` })
                }}
                className="mt-1 text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow"
              >
                {(inner.origin as Record<string, string>).friendId?.slice(0, 8)}…/{(inner.origin as Record<string, string>).channel}/{(inner.origin as Record<string, string>).key}
              </button>
              {inner.obligationStatus && (
                <button
                  onClick={() => nav({ tab: "work" })}
                  className="ml-2 text-xs text-ouro-glow underline decoration-ouro-glow/30 underline-offset-2 hover:decoration-ouro-glow"
                >
                  obligation: {inner.obligationStatus as string}
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
              {overdueHabits.map((h) => <HabitCard key={h.name as string} h={h} />)}
            </div>
          </div>
        )}

        {activeHealthy.length > 0 && (
          <div className="mt-3">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow mb-1.5">
              Running fine ({activeHealthy.length})
            </p>
            <div className="space-y-1.5">
              {activeHealthy.map((h) => <HabitCard key={h.name as string} h={h} />)}
            </div>
          </div>
        )}

        {pausedHabits.length > 0 && (
          <div className="mt-3">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-shadow mb-1.5">
              Paused ({pausedHabits.length})
            </p>
            <div className="space-y-1.5">
              {pausedHabits.map((h) => <HabitCard key={h.name as string} h={h} />)}
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
  const containerRef = useRef<HTMLDivElement>(null)

  const RECENT = 30
  const visible = showAll ? conversation : conversation.slice(-RECENT)
  const hiddenCount = conversation.length - visible.length

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight
  }, [visible.length])

  return (
    <div ref={containerRef} className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg bg-ouro-void/60 p-3 ring-1 ring-ouro-moss/15 space-y-1">
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full rounded-lg px-3 py-2 text-center font-mono text-xs text-ouro-shadow hover:text-ouro-mist ring-1 ring-ouro-moss/10 hover:ring-ouro-moss/20 transition-colors mb-2"
        >
          Load {hiddenCount} earlier messages
        </button>
      )}
      {visible.map((m) => {
        if (m.role === "user") {
          const isDelegated = m.content?.includes("[pending from") || m.content?.includes("[delegated")
          const isWakeUp = m.content?.includes("waking up") || m.content?.includes("world-state checkpoint")
          return (
            <div key={m.index} className="flex justify-start py-1">
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
                  <span className="font-mono text-[9px] text-ouro-shadow/40">#{m.index}</span>
                </div>
                <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">
                  {m.content}
                </p>
              </div>
            </div>
          )
        }

        if (m.role === "assistant") {
          const classified = (m.tool_calls ?? []).map(classifyToolCall)
          const surfaces = classified.filter((c) => c.kind === "surface")
          const rests = classified.filter((c) => c.kind === "rest")
          const ponders = classified.filter((c) => c.kind === "delegation")

          return (
            <div key={m.index}>
              {/* Surface = conclusion delivered outward — landmark */}
              {surfaces.map((sc) => (
                <div key={sc.id} className="flex justify-end py-1">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ouro-scale/15 px-3 py-2 ring-1 ring-ouro-scale/20">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow">★ surfaced outward</p>
                      <span className="font-mono text-[9px] text-ouro-shadow/40">#{m.index}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">{sc.deliveredText}</p>
                    {sc.metadata && <p className="mt-1 font-mono text-[9px] text-ouro-shadow">→ {sc.metadata}</p>}
                  </div>
                </div>
              ))}

              {ponders.length > 0 && (
                <div className="py-1 text-center font-mono text-[10px] text-ouro-gold/50">— still thinking — #{m.index}</div>
              )}

              {rests.length > 0 && (
                <div className="py-1 text-center font-mono text-[10px] text-ouro-shadow/40">— resting — #{m.index}</div>
              )}

              {/* Regular thinking (no mechanism calls) */}
              {surfaces.length === 0 && rests.length === 0 && ponders.length === 0 && m.content && (
                <div className="flex justify-end py-1">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ouro-glow/6 px-3 py-2 ring-1 ring-ouro-glow/8">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow/50">thinking</p>
                      <span className="font-mono text-[9px] text-ouro-shadow/40">#{m.index}</span>
                    </div>
                    <p className="text-sm leading-relaxed text-ouro-mist whitespace-pre-wrap break-words">{m.content}</p>
                  </div>
                </div>
              )}
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function HabitCard({ h }: { h: Record<string, unknown> }) {
  const isOverdue = h.isOverdue as boolean
  const isDegraded = h.isDegraded as boolean
  const status = h.status as string

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
        <span className="font-medium text-ouro-bone">{h.title as string}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-ouro-shadow">
        {h.cadence && <span>every {h.cadence as string}</span>}
        <span>{h.lastRun ? `last ${relTime(h.lastRun as string)}` : "never run"}</span>
        {isDegraded && h.degradedReason && <span className="text-ouro-gold">{h.degradedReason as string}</span>}
      </div>
      {h.bodyExcerpt && <p className="mt-1 text-xs text-ouro-shadow/70">{h.bodyExcerpt as string}</p>}
    </div>
  )
}
