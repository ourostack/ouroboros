import { useEffect, useRef, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { classifyToolCall, type ClassifiedToolCall } from "../../tools"
import { useNavigate } from "../../navigation"

interface SessionItem {
  friendId: string
  friendName: string
  channel: string
  key: string
  messageCount: number
  lastActivityAt: string
  replyState: "needs-reply" | "on-hold" | "monitoring" | "idle"
  lastUsage: { total_tokens: number } | null
  continuity: { mustResolveBeforeHandoff: boolean } | null
  latestUserExcerpt: string | null
  latestAssistantExcerpt: string | null
  estimatedTokens: number | null
}

interface SessionInventory {
  totalCount: number
  activeCount: number
  staleCount: number
  items: SessionItem[]
}

interface TranscriptMessage {
  index: number
  role: string
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
}

interface Transcript {
  messageCount: number
  messages: TranscriptMessage[]
  lastUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | null
}

const REPLY_STATE_BADGE: Record<string, { color: "red" | "yellow" | "lime" | "zinc"; label: string }> = {
  "needs-reply": { color: "red", label: "needs reply" },
  "on-hold": { color: "yellow", label: "on hold" },
  "monitoring": { color: "zinc", label: "monitoring" },
  "idle": { color: "zinc", label: "idle" },
}

export function SessionsTab({ agentName, focus, onFocusConsumed, deskPrefs }: { agentName: string; focus?: string; onFocusConsumed?: () => void; deskPrefs?: Record<string, unknown> | null }) {
  const nav = useNavigate()
  const [inventory, setInventory] = useState<SessionInventory | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetchJson<SessionInventory>(`/agents/${encodeURIComponent(agentName)}/sessions`).then((data) => {
      setInventory(data)
      if (focus) {
        loadTranscript(focus)
        onFocusConsumed?.()
      }
    })
  }, [agentName, focus])

  function loadTranscript(sessionKey: string) {
    if (expandedKey === sessionKey) {
      setExpandedKey(null)
      setTranscript(null)
      return
    }
    setExpandedKey(sessionKey)
    setTranscript(null)
    setLoading(true)
    const [fId, ch, k] = sessionKey.split("/")
    fetchJson<Transcript>(
      `/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(fId!)}/${encodeURIComponent(ch!)}/${encodeURIComponent(k!)}`
    )
      .then(setTranscript)
      .catch(() => setTranscript(null))
      .finally(() => setLoading(false))
  }

  const starredFriends = new Set(((deskPrefs as any)?.starredFriends ?? []) as string[])

  if (!inventory) {
    return <Loading label="Loading sessions" />
  }

  // Group by person, sort starred to top, then by session count
  const byPerson = new Map<string, SessionItem[]>()
  for (const s of inventory.items) {
    if (!byPerson.has(s.friendId)) byPerson.set(s.friendId, [])
    byPerson.get(s.friendId)!.push(s)
  }
  const personEntries = [...byPerson.entries()].sort((a, b) => {
    const aStarred = starredFriends.has(a[0]) ? 0 : 1
    const bStarred = starredFriends.has(b[0]) ? 0 : 1
    if (aStarred !== bStarred) return aStarred - bStarred
    return b[1].length - a[1].length
  })

  // Flatten back with person group separators
  const sortedItems: SessionItem[] = []
  const personHeaders = new Map<number, { name: string; channels: number; starred: boolean }>()
  for (const [friendId, sessions] of personEntries) {
    personHeaders.set(sortedItems.length, {
      name: sessions[0]!.friendName,
      channels: sessions.length,
      starred: starredFriends.has(friendId),
    })
    sortedItems.push(...sessions)
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-ouro-glow">
        {inventory.totalCount} sessions · {inventory.activeCount} active · {inventory.staleCount} stale
      </p>

      <div className="space-y-1.5">
        {sortedItems.map((s, idx) => {
          const header = personHeaders.get(idx)
          const isStarred = starredFriends.has(s.friendId)
          const key = `${s.friendId}/${s.channel}/${s.key}`
          const isOpen = expandedKey === key
          const badge = REPLY_STATE_BADGE[s.replyState] ?? REPLY_STATE_BADGE.idle
          // Context pressure: last-turn input_tokens is the real count from the API
          // Agent maxTokens defaults to 80k, context oscillates between 64k (trimmed) and 80k (before trim)
          const inputTokens = s.lastUsage?.total_tokens ?? s.estimatedTokens ?? 0
          const maxTokens = 80000
          const pressurePct = inputTokens > 0 ? Math.min(100, Math.round((inputTokens / maxTokens) * 100)) : 0

          return (
            <div key={key}>
              {/* Person header — shows when same person has multiple channels */}
              {header && header.channels > 1 && (
                <div className="flex items-center gap-2 pt-3 pb-1">
                  {header.starred && <span className="text-ouro-gold text-sm">★</span>}
                  <span className="font-medium text-ouro-bone text-sm">{header.name}</span>
                  <span className="text-xs text-ouro-shadow">{header.channels} channels</span>
                </div>
              )}
              <button
                onClick={() => loadTranscript(key)}
                className={`flex w-full flex-col gap-1.5 rounded-lg px-3 py-3 text-left transition-colors ring-1 ${
                  isOpen ? "bg-ouro-moss/15 ring-ouro-glow/20" : "ring-ouro-moss/15 hover:bg-ouro-moss/8"
                }`}
              >
                {/* Row 1: name + reply state + time */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {isStarred && <span className="text-ouro-gold" title="Starred">★</span>}
                    <span className="truncate font-medium text-ouro-bone">{s.friendName}</span>
                    <span className="shrink-0 text-xs text-ouro-shadow">via {s.channel}</span>
                    <Badge color={badge.color}>{badge.label}</Badge>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-ouro-shadow">{relTime(s.lastActivityAt)}</span>
                </div>

                {/* Row 2: excerpt */}
                {/* Last inbound + last outbound — session state at a glance */}
                {s.latestUserExcerpt && (
                  <p className="truncate text-xs text-ouro-gold/70">
                    <span className="font-mono text-[9px] uppercase tracking-wider">in:</span> {truncate(s.latestUserExcerpt, 100)}
                  </p>
                )}
                {s.latestAssistantExcerpt && (
                  <p className="truncate text-xs text-ouro-glow/60">
                    <span className="font-mono text-[9px] uppercase tracking-wider">out:</span> {truncate(s.latestAssistantExcerpt, 100)}
                  </p>
                )}

                {/* Row 3: stats + context pressure bar */}
                <div className="flex items-center gap-3 text-xs text-ouro-shadow">
                  <span className="tabular-nums">{s.messageCount} msgs</span>
                  {s.lastUsage && <span className="tabular-nums">{s.lastUsage.total_tokens.toLocaleString()} tok</span>}
                  {pressurePct > 0 && (
                    <div className="flex items-center gap-1.5 flex-1 max-w-32" title="Context pressure — steady state oscillates between 80-100%">
                      <div className="h-1 flex-1 rounded-full bg-ouro-moss/20">
                        <div
                          className={`h-1 rounded-full transition-all ${
                            pressurePct > 100 ? "bg-ouro-fang" : pressurePct > 80 ? "bg-ouro-gold" : "bg-ouro-glow"
                          }`}
                          style={{ width: `${Math.min(100, pressurePct)}%` }}
                        />
                      </div>
                      <span className="tabular-nums text-[10px]">{pressurePct}%</span>
                    </div>
                  )}
                </div>
              </button>

              {isOpen && <TranscriptPanel loading={loading} transcript={transcript} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TranscriptPanel({ loading, transcript }: { loading: boolean; transcript: Transcript | null }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (transcript && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [transcript])

  return (
    <div ref={ref} className="mt-1 max-h-[70vh] overflow-y-auto rounded-lg bg-ouro-void/60 p-3 ring-1 ring-ouro-moss/15">
      {loading && <Loading label="Loading transcript" />}
      {transcript && <TranscriptView messages={transcript.messages} usage={transcript.lastUsage} />}
    </div>
  )
}

function TranscriptView({ messages, usage }: { messages: TranscriptMessage[]; usage: Transcript["lastUsage"] }) {
  const system = messages.filter((m) => m.role === "system")
  const conversation = messages.filter((m) => m.role !== "system")
  const [showSystem, setShowSystem] = useState(false)

  const toolResultMap = new Map<string, TranscriptMessage>()
  for (const m of conversation) {
    if (m.role === "tool" && m.tool_call_id) toolResultMap.set(m.tool_call_id, m)
  }

  return (
    <div className="space-y-0.5">
      {usage && (
        <p className="pb-2 font-mono text-[10px] text-ouro-shadow">
          {usage.input_tokens.toLocaleString()} in · {usage.output_tokens.toLocaleString()} out · {usage.total_tokens.toLocaleString()} total
        </p>
      )}
      {system.length > 0 && (
        <div className="pb-2 mb-2 border-b border-ouro-moss/15">
          <button
            onClick={() => setShowSystem(!showSystem)}
            className="font-mono text-[10px] uppercase tracking-wider text-ouro-shadow hover:text-ouro-mist transition-colors"
          >
            {showSystem ? "▼" : "▶"} system context ({system.length})
          </button>
          {showSystem && system.map((m) => (
            <div key={m.index} className="mt-2 max-h-60 overflow-y-auto rounded bg-ouro-void/40 p-2 text-xs text-ouro-shadow whitespace-pre-wrap break-words">
              {m.content}
            </div>
          ))}
        </div>
      )}
      {conversation.map((m) => {
        if (m.role === "tool") return null
        if (m.role === "user") return <UserBubble key={m.index} msg={m} />
        if (m.role === "assistant") return <AgentBubble key={m.index} msg={m} toolResults={toolResultMap} />
        return null
      })}
    </div>
  )
}

function UserBubble({ msg }: { msg: TranscriptMessage }) {
  return (
    <div className="flex justify-start py-1">
      <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-bl-sm bg-ouro-moss/25 px-3.5 py-2 ring-1 ring-ouro-moss/15">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-gold/70">user</p>
          <span className="font-mono text-[9px] text-ouro-shadow/40">#{msg.index}</span>
        </div>
        <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">{msg.content}</p>
      </div>
    </div>
  )
}

function AgentBubble({ msg, toolResults }: { msg: TranscriptMessage; toolResults: Map<string, TranscriptMessage> }) {
  const classified = (msg.tool_calls ?? []).map(classifyToolCall)
  const mechanism = classified.filter((c) => c.kind !== "action")
  const actions = classified.filter((c) => c.kind === "action")

  const bubbles: React.ReactNode[] = []

  for (const call of mechanism) {
    if (call.kind === "response") {
      bubbles.push(
        <div key={call.id} className="flex justify-end py-1">
          <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-sm bg-ouro-glow/8 px-3.5 py-2 ring-1 ring-ouro-glow/12">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow/70 mb-0.5">agent</p>
            <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">{call.deliveredText}</p>
            {call.metadata && call.metadata !== "complete" && (
              <p className="mt-1 font-mono text-[9px] text-ouro-shadow">intent: {call.metadata}</p>
            )}
          </div>
        </div>
      )
    } else if (call.kind === "delegation") {
      bubbles.push(
        <div key={call.id} className="flex justify-end py-1">
          <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-sm bg-ouro-glow/8 px-3.5 py-2 ring-1 ring-ouro-glow/12">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow/70 mb-0.5">agent</p>
            {call.deliveredText && (
              <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">{call.deliveredText}</p>
            )}
            {call.delegatedThought && (
              <div className="mt-2 rounded-lg bg-ouro-moss/20 px-2.5 py-1.5 ring-1 ring-ouro-glow/8">
                <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow/60">→ inner dialog</p>
                <p className="mt-0.5 text-xs text-ouro-mist">{call.delegatedThought}</p>
              </div>
            )}
          </div>
        </div>
      )
    } else if (call.kind === "surface") {
      bubbles.push(
        <div key={call.id} className="flex justify-end py-1">
          <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-sm bg-ouro-scale/12 px-3.5 py-2 ring-1 ring-ouro-scale/15">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow/70 mb-0.5">surfaced</p>
            <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">{call.deliveredText}</p>
            {call.metadata && <p className="mt-1 font-mono text-[9px] text-ouro-shadow">→ {call.metadata}</p>}
          </div>
        </div>
      )
    } else if (call.kind === "rest") {
      bubbles.push(<div key={call.id} className="py-1 text-center font-mono text-[10px] text-ouro-shadow/50">— resting —</div>)
    } else if (call.kind === "observe") {
      bubbles.push(<div key={call.id} className="py-1 text-center font-mono text-[10px] text-ouro-shadow/50">— observed{call.metadata ? `: ${call.metadata}` : ""} —</div>)
    }
  }

  // Regular assistant content without mechanism tools
  if (msg.content && mechanism.length === 0) {
    bubbles.push(
      <div key={`${msg.index}-content`} className="flex justify-end py-1">
        <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-sm bg-ouro-glow/8 px-3.5 py-2 ring-1 ring-ouro-glow/12">
          <p className="font-mono text-[9px] uppercase tracking-wider text-ouro-glow/70 mb-0.5">agent</p>
          <p className="text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words">{msg.content}</p>
        </div>
      </div>
    )
  }

  // Action tool calls
  if (actions.length > 0) {
    bubbles.push(
      <div key={`${msg.index}-tools`} className="flex justify-end py-1">
        <div className="max-w-[85%] sm:max-w-[75%] space-y-1">
          {actions.map((call) => <ToolChip key={call.id} call={call} result={toolResults.get(call.id)} />)}
        </div>
      </div>
    )
  }

  return <>{bubbles}</>
}

function ToolChip({ call, result }: { call: ClassifiedToolCall; result?: TranscriptMessage }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      onClick={() => setOpen(!open)}
      className="w-full text-left rounded-lg bg-ouro-moss/10 px-2.5 py-1.5 text-sm ring-1 ring-ouro-moss/12 hover:ring-ouro-glow/15 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-ouro-glow">{call.name}</span>
        {!open && <span className="text-[10px] text-ouro-shadow">tap to inspect</span>}
      </div>
      {open && (
        <>
          {call.rawArgs && (
            <pre className="mt-1.5 max-h-24 overflow-y-auto rounded bg-ouro-void/40 p-1.5 font-mono text-[11px] text-ouro-shadow whitespace-pre-wrap break-words">
              {call.rawArgs}
            </pre>
          )}
          {result && (
            <div className="mt-1.5 border-t border-ouro-moss/15 pt-1.5">
              <Badge>result</Badge>
              <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-ouro-void/40 p-1.5 font-mono text-[11px] text-ouro-mist whitespace-pre-wrap break-words">
                {result.content}
              </pre>
            </div>
          )}
        </>
      )}
    </button>
  )
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6">
      <div className="h-2 w-2 animate-pulse rounded-full bg-ouro-glow" />
      <span className="font-mono text-xs text-ouro-shadow">{label}…</span>
    </div>
  )
}
