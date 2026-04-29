import { useEffect, useRef, useState } from "react"
import { Badge } from "../../catalyst/badge"
import { fetchJson, relTime, truncate } from "../../api"
import { classifyToolCall, type ClassifiedToolCall } from "../../tools"
import { useNavigate } from "../../navigation"
import { useStickyScroll } from "../../hooks/use-sticky-scroll"
import type {
  MailboxDeskPrefs,
  MailboxSessionInventory as SessionInventory,
  MailboxSessionInventoryItem as SessionItem,
  MailboxSessionTranscript as Transcript,
  MailboxTranscriptMessage as TranscriptMessage,
} from "../../contracts"
import {
  getMailboxTranscriptMessageText,
  getMailboxTranscriptTimestamp,
} from "../../contracts"

const REPLY_STATE_BADGE: Record<string, { color: "red" | "yellow" | "lime" | "zinc"; label: string }> = {
  "needs-reply": { color: "red", label: "needs reply" },
  "on-hold": { color: "yellow", label: "on hold" },
  "monitoring": { color: "zinc", label: "monitoring" },
  "idle": { color: "zinc", label: "idle" },
}

type TranscriptSurface = "imessage" | "teams" | "terminal" | "default"

function channelLabel(channel: string): string {
  if (channel === "bluebubbles") return "iMessage"
  if (channel === "teams") return "Teams"
  if (channel === "cli") return "CLI"
  if (channel === "mail") return "Mail"
  return channel
}

function surfaceForChannel(channel: string): TranscriptSurface {
  if (channel === "bluebubbles") return "imessage"
  if (channel === "teams") return "teams"
  if (channel === "cli") return "terminal"
  return "default"
}

function surfaceShellClass(surface: TranscriptSurface): string {
  if (surface === "imessage") return "overflow-hidden rounded-xl bg-[#f5f5f7] text-[#1d1d1f] ring-1 ring-black/10"
  if (surface === "teams") return "overflow-hidden rounded-xl bg-[#f7f5ff] text-[#242424] ring-1 ring-[#d8d1ff]"
  if (surface === "terminal") return "overflow-hidden rounded-lg bg-[#050807] font-mono text-[#d1fae5] ring-1 ring-[#1f3a2c]"
  return "overflow-hidden rounded-lg bg-ouro-void/60 text-ouro-bone ring-1 ring-ouro-moss/15"
}

function surfaceHeaderClass(surface: TranscriptSurface): string {
  if (surface === "imessage") return "border-b border-black/10 bg-[#fbfbfd] px-4 py-3 text-center"
  if (surface === "teams") return "border-b border-[#d8d1ff] bg-[#4f3bb3] px-4 py-3 text-white"
  if (surface === "terminal") return "border-b border-[#1f3a2c] bg-[#101815] px-4 py-2 text-[#86efac]"
  return "border-b border-ouro-moss/15 px-4 py-3"
}

function userBubbleClass(surface: TranscriptSurface): string {
  if (surface === "imessage") return "max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-bl-md bg-[#e9e9eb] px-3.5 py-2 text-[#1d1d1f]"
  if (surface === "teams") return "max-w-[85%] sm:max-w-[75%] rounded-md bg-white px-3.5 py-2 text-[#242424] shadow-sm ring-1 ring-[#e5e5e5]"
  if (surface === "terminal") return "max-w-full rounded-none border-l-2 border-[#60a5fa] bg-transparent px-3 py-2 text-[#dbeafe]"
  return "max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-bl-sm bg-ouro-moss/25 px-3.5 py-2 ring-1 ring-ouro-moss/15"
}

function agentBubbleClass(surface: TranscriptSurface, tone: "normal" | "surface" = "normal"): string {
  if (surface === "imessage") return "max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-md bg-[#0a84ff] px-3.5 py-2 text-white"
  if (surface === "teams") return "max-w-[85%] sm:max-w-[75%] rounded-md bg-[#ede9fe] px-3.5 py-2 text-[#242424] shadow-sm ring-1 ring-[#c4b5fd]"
  if (surface === "terminal") return "max-w-full rounded-none border-l-2 border-[#22c55e] bg-transparent px-3 py-2 text-[#bbf7d0]"
  if (tone === "surface") return "max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-sm bg-ouro-scale/12 px-3.5 py-2 ring-1 ring-ouro-scale/15"
  return "max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-sm bg-ouro-glow/8 px-3.5 py-2 ring-1 ring-ouro-glow/12"
}

function labelClass(surface: TranscriptSurface, role: "user" | "agent" | "surface"): string {
  if (surface === "imessage") return role === "agent" ? "font-mono text-[9px] text-white/70" : "font-mono text-[9px] text-[#6b7280]"
  if (surface === "teams") return "font-mono text-[9px] uppercase tracking-wider text-[#5b5fc7]"
  if (surface === "terminal") return role === "agent" ? "font-mono text-[11px] text-[#22c55e]" : "font-mono text-[11px] text-[#60a5fa]"
  if (role === "surface") return "font-mono text-[9px] uppercase tracking-wider text-ouro-glow/70"
  return role === "agent" ? "font-mono text-[9px] uppercase tracking-wider text-ouro-glow/70" : "font-mono text-[9px] uppercase tracking-wider text-ouro-gold/70"
}

function messageTextClass(surface: TranscriptSurface, role: "user" | "agent" = "agent"): string {
  if (surface === "imessage") return "text-sm leading-relaxed whitespace-pre-wrap break-words"
  if (surface === "teams") return "text-sm leading-relaxed text-[#242424] whitespace-pre-wrap break-words"
  if (surface === "terminal") return `font-mono text-[12px] leading-6 whitespace-pre-wrap break-words ${role === "agent" ? "text-[#bbf7d0]" : "text-[#dbeafe]"}`
  return "text-sm leading-relaxed text-ouro-bone whitespace-pre-wrap break-words"
}

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

export function SessionsTab({ agentName, focus, onFocusConsumed, deskPrefs, refreshGeneration }: { agentName: string; focus?: string; onFocusConsumed?: () => void; deskPrefs?: MailboxDeskPrefs | null; refreshGeneration: number }) {
  const nav = useNavigate()
  const [inventory, setInventory] = useState<SessionInventory | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [loading, setLoading] = useState(false)
  const transcriptRequestRef = useRef<string | null>(null)

  useEffect(() => {
    fetchJson<SessionInventory>(`/agents/${encodeURIComponent(agentName)}/sessions`).then(setInventory)
  }, [agentName, refreshGeneration])

  useEffect(() => {
    if (!focus) return
    transcriptRequestRef.current = null
    setExpandedKey(focus)
    setTranscript(null)
    setLoading(true)
    onFocusConsumed?.()
  }, [agentName, focus, onFocusConsumed])

  useEffect(() => {
    if (!expandedKey) return
    const requestKey = `${expandedKey}:${refreshGeneration}`
    if (transcriptRequestRef.current === requestKey) return
    transcriptRequestRef.current = requestKey
    setLoading(true)
    const [fId, ch, k] = expandedKey.split("/")
    fetchJson<Transcript>(
      `/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(fId!)}/${encodeURIComponent(ch!)}/${encodeURIComponent(k!)}`
    )
      .then(setTranscript)
      .catch(() => setTranscript(null))
      .finally(() => setLoading(false))
  }, [agentName, expandedKey, refreshGeneration, focus])

  function loadTranscript(sessionKey: string) {
    if (expandedKey === sessionKey) {
      setExpandedKey(null)
      setTranscript(null)
      transcriptRequestRef.current = null
      return
    }
    setExpandedKey(sessionKey)
    setTranscript(null)
    setLoading(true)
  }

  const starredFriends = new Set(deskPrefs?.starredFriends ?? [])

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
                    <span className="shrink-0 text-xs text-ouro-shadow">via {channelLabel(s.channel)}</span>
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
  const latestMessageId = transcript?.messages[transcript.messages.length - 1]?.id ?? null
  const { ref, onScroll } = useStickyScroll<HTMLDivElement>(latestMessageId)

  return (
    <div
      ref={ref}
      data-testid="session-transcript-scroll"
      onScroll={onScroll}
      className="mt-1 max-h-[70vh] overflow-y-auto rounded-lg"
    >
      {loading && !transcript && <Loading label="Loading transcript" />}
      {transcript && <TranscriptView transcript={transcript} />}
    </div>
  )
}

function TranscriptView({ transcript }: { transcript: Transcript }) {
  const { messages, lastUsage: usage } = transcript
  const surface = surfaceForChannel(transcript.channel)
  const system = messages.filter((m) => m.role === "system")
  const conversation = messages.filter((m) => m.role !== "system")
  const [showSystem, setShowSystem] = useState(false)

  const toolResultMap = new Map<string, TranscriptMessage>()
  for (const m of conversation) {
    if (m.role === "tool" && m.toolCallId) toolResultMap.set(m.toolCallId, m)
  }

  return (
    <div className={surfaceShellClass(surface)}>
      <div className={surfaceHeaderClass(surface)}>
        <p className={surface === "terminal" ? "font-mono text-xs" : "text-sm font-semibold"}>
          {channelLabel(transcript.channel)}
        </p>
        <p className={surface === "terminal" ? "mt-0.5 font-mono text-[10px] text-[#6ee7b7]" : "mt-0.5 text-xs opacity-70"}>
          {transcript.friendName} · {transcript.messageCount} messages
        </p>
      </div>
      <div className="space-y-0.5 p-3">
        {usage && (
          <p className={surface === "terminal" ? "pb-2 font-mono text-[10px] text-[#6ee7b7]" : "pb-2 font-mono text-[10px] opacity-60"}>
            {usage.input_tokens.toLocaleString()} in · {usage.output_tokens.toLocaleString()} out · {usage.total_tokens.toLocaleString()} total
          </p>
        )}
        {system.length > 0 && (
          <div className="pb-2 mb-2 border-b border-current/10">
            <button
              onClick={() => setShowSystem(!showSystem)}
              className="font-mono text-[10px] uppercase tracking-wider opacity-60 transition-opacity hover:opacity-90"
            >
              {showSystem ? "▼" : "▶"} system context ({system.length})
            </button>
            {showSystem && system.map((m) => (
              <div key={m.id} className="mt-2 max-h-60 overflow-y-auto rounded bg-black/5 p-2 text-xs opacity-75 whitespace-pre-wrap break-words">
                <p className="mb-1 font-mono text-[9px] opacity-70">{formatTranscriptTimestamp(m)}</p>
                {getMailboxTranscriptMessageText(m)}
              </div>
            ))}
          </div>
        )}
        {conversation.map((m) => {
          if (m.role === "tool") return null
          if (m.role === "user") return <UserBubble key={m.id} msg={m} surface={surface} />
          if (m.role === "assistant") return <AgentBubble key={m.id} msg={m} toolResults={toolResultMap} surface={surface} />
          return null
        })}
      </div>
    </div>
  )
}

function UserBubble({ msg, surface }: { msg: TranscriptMessage; surface: TranscriptSurface }) {
  const text = getMailboxTranscriptMessageText(msg)
  return (
    <div className="flex justify-start py-1">
      <div className={userBubbleClass(surface)}>
        <div className="flex items-center gap-2 mb-0.5">
          <p className={labelClass(surface, "user")}>{surface === "terminal" ? "human $" : "user"}</p>
          <span className="font-mono text-[9px] text-ouro-shadow/40">#{msg.sequence}</span>
          <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(msg)}</span>
        </div>
        <p className={messageTextClass(surface, "user")}>{text}</p>
      </div>
    </div>
  )
}

function AgentBubble({ msg, toolResults, surface }: { msg: TranscriptMessage; toolResults: Map<string, TranscriptMessage>; surface: TranscriptSurface }) {
  const text = getMailboxTranscriptMessageText(msg)
  const classified = (msg.toolCalls ?? []).map(classifyToolCall)
  const mechanism = classified.filter((c) => c.kind !== "action")
  const actions = classified.filter((c) => c.kind === "action")

  const bubbles: React.ReactNode[] = []

  for (const call of mechanism) {
    if (call.kind === "response") {
      bubbles.push(
        <div key={call.id} className="flex justify-end py-1">
          <div className={agentBubbleClass(surface)}>
            <div className="mb-0.5 flex items-center gap-2">
              <p className={labelClass(surface, "agent")}>{surface === "terminal" ? "agent >" : "agent"}</p>
              <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(msg)}</span>
            </div>
            <p className={messageTextClass(surface)}>{call.deliveredText}</p>
            {call.metadata && call.metadata !== "complete" && (
              <p className="mt-1 font-mono text-[9px] text-ouro-shadow">intent: {call.metadata}</p>
            )}
          </div>
        </div>
      )
    } else if (call.kind === "delegation") {
      bubbles.push(
        <div key={call.id} className="flex justify-end py-1">
          <div className={agentBubbleClass(surface)}>
            <div className="mb-0.5 flex items-center gap-2">
              <p className={labelClass(surface, "agent")}>{surface === "terminal" ? "agent >" : "agent"}</p>
              <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(msg)}</span>
            </div>
            {call.deliveredText && (
              <p className={messageTextClass(surface)}>{call.deliveredText}</p>
            )}
            {call.delegatedThought && (
              <div className="mt-2 rounded bg-black/10 px-2.5 py-1.5 ring-1 ring-current/10">
                <p className="font-mono text-[9px] uppercase tracking-wider opacity-70">→ inner dialog</p>
                <p className="mt-0.5 text-xs opacity-80">{call.delegatedThought}</p>
              </div>
            )}
          </div>
        </div>
      )
    } else if (call.kind === "surface") {
      bubbles.push(
        <div key={call.id} className="flex justify-end py-1">
          <div className={agentBubbleClass(surface, "surface")}>
            <div className="mb-0.5 flex items-center gap-2">
              <p className={labelClass(surface, "surface")}>surfaced</p>
              <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(msg)}</span>
            </div>
            <p className={messageTextClass(surface)}>{call.deliveredText}</p>
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
  if (text && mechanism.length === 0) {
    bubbles.push(
      <div key={`${msg.id}-content`} className="flex justify-end py-1">
        <div className={agentBubbleClass(surface)}>
          <div className="mb-0.5 flex items-center gap-2">
            <p className={labelClass(surface, "agent")}>{surface === "terminal" ? "agent >" : "agent"}</p>
            <span className="font-mono text-[9px] text-ouro-shadow/60">{formatTranscriptTimestamp(msg)}</span>
          </div>
          <p className={messageTextClass(surface)}>{text}</p>
        </div>
      </div>
    )
  }

  // Action tool calls
  if (actions.length > 0) {
    bubbles.push(
      <div key={`${msg.id}-tools`} className="flex justify-end py-1">
        <div className="max-w-[85%] sm:max-w-[75%] space-y-1">
          {actions.map((call) => <ToolChip key={call.id} call={call} result={toolResults.get(call.id)} surface={surface} />)}
        </div>
      </div>
    )
  }

  return <>{bubbles}</>
}

function ToolChip({ call, result, surface }: { call: ClassifiedToolCall; result?: TranscriptMessage; surface: TranscriptSurface }) {
  const [open, setOpen] = useState(false)
  const resultText = result ? getMailboxTranscriptMessageText(result) : null
  return (
    <button
      onClick={() => setOpen(!open)}
      className={`w-full text-left rounded px-2.5 py-1.5 text-sm transition-colors ${
        surface === "terminal"
          ? "bg-[#0f1a15] font-mono text-[#bbf7d0] ring-1 ring-[#1f3a2c] hover:ring-[#22c55e]/40"
          : surface === "teams"
            ? "bg-white text-[#242424] ring-1 ring-[#d8d1ff] hover:ring-[#5b5fc7]/40"
            : surface === "imessage"
              ? "bg-white text-[#1d1d1f] ring-1 ring-black/10 hover:ring-[#0a84ff]/30"
              : "bg-ouro-moss/10 ring-1 ring-ouro-moss/12 hover:ring-ouro-glow/15"
      }`}
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
                {resultText}
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
