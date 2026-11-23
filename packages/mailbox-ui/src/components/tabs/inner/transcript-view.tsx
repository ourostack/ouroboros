import { useState } from "react"
import { Badge } from "@/components/ouro/badge/badge"
import { Button } from "@/components/ouro/button/button"
import { truncate } from "../../../api"
import { classifyToolCall } from "../../../tools"
import { useStickyScroll } from "../../../hooks/use-sticky-scroll"
import type { MailboxTranscriptMessage as TranscriptMessage } from "../../../contracts"
import { getMailboxTranscriptMessageText, getMailboxTranscriptTimestamp } from "../../../contracts"

function formatTranscriptTimestamp(msg: TranscriptMessage): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(getMailboxTranscriptTimestamp(msg)))
}

const RECENT = 30

/**
 * The private runtime's transcript: its most recent messages, with landmarks (surfaced, resting, still thinking) to jump to.
 * The bubbles stay hand-drawn: Ouro HX's message component is not installed in Mailbox.
 */
export function InnerTranscriptView({ messages }: { messages: TranscriptMessage[] }) {
  const conversation = messages.filter((m) => m.role !== "system" && m.role !== "tool")
  const [showAll, setShowAll] = useState(false)

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
            <Badge
              key={i}
              variant="soft"
              tone={lm.kind === "surfaced" ? "success" : lm.kind === "resting" ? "secondary" : "warning"}
              onClick={() => {
                preserveScroll()
                setShowAll(true)
                setTimeout(() => scrollToMessage(lm.index), 100)
              }}
            >
              {lm.kind === "surfaced" ? "★" : lm.kind === "resting" ? "—" : "→"} #{lm.index}
            </Badge>
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
        <Button
          variant="plain"
          size="sm"
          fullWidth
          className="mb-2"
          onClick={() => {
            preserveScroll()
            setShowAll(true)
          }}
        >
          Load {hiddenCount} earlier messages
        </Button>
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
