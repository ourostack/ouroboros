import type { ReactNode } from "react"
import { Badge } from "../../status-badge"
import { Alert } from "@/components/ouro/alert/alert"
import { CodeBlock } from "@/components/ouro/code-block/code-block"
import { Collapsible } from "@/components/ouro/collapsible/collapsible"
import { Separator } from "@/components/ouro/separator/separator"
import { classifyToolCall, type ClassifiedToolCall } from "../../../tools"
import { useStickyScroll } from "../../../hooks/use-sticky-scroll"
import type {
  MailboxSessionTranscript as Transcript,
  MailboxTranscriptMessage as TranscriptMessage,
} from "../../../contracts"
import {
  getMailboxTranscriptMessageText,
  getMailboxTranscriptTimestamp,
} from "../../../contracts"
import { Loading } from "./loading"

type TranscriptSurface = "imessage" | "teams" | "terminal" | "default"

export function channelLabel(channel: string): string {
  if (channel === "bluebubbles") return "iMessage"
  if (channel === "teams") return "Teams"
  if (channel === "cli") return "CLI"
  if (channel === "mail") return "Mail"
  if (channel === "voice") return "Voice"
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

export function TranscriptPanel({ loading, transcript }: { loading: boolean; transcript: Transcript | null }) {
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
        {transcript.truncatedHistory && (
          <Alert tone="primary" className="mb-2" title="Model context is trimmed; retained history is shown below." />
        )}
        {system.length > 0 && (
          <Collapsible title={`system context (${system.length})`} className="mb-2">
            <div className="space-y-2">
              {system.map((m) => (
                <div key={m.id} className="max-h-60 overflow-y-auto rounded bg-black/5 p-2 text-xs opacity-75 whitespace-pre-wrap break-words">
                  <p className="mb-1 font-mono text-[9px] opacity-70">{formatTranscriptTimestamp(m)}</p>
                  {getMailboxTranscriptMessageText(m)}
                </div>
              ))}
            </div>
          </Collapsible>
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

  const bubbles: ReactNode[] = []

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
                <p className="font-mono text-[9px] uppercase tracking-wider opacity-70">→ private runtime</p>
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
      bubbles.push(<Separator key={call.id} className="my-2" label="resting" />)
    } else if (call.kind === "observe") {
      bubbles.push(<Separator key={call.id} className="my-2" label={`observed${call.metadata ? `: ${call.metadata}` : ""}`} />)
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

function toolChipClass(surface: TranscriptSurface): string {
  if (surface === "terminal") return "bg-[#0f1a15] text-[#bbf7d0] ring-1 ring-[#1f3a2c]"
  if (surface === "teams") return "bg-white text-[#242424] ring-1 ring-[#d8d1ff]"
  if (surface === "imessage") return "bg-white text-[#1d1d1f] ring-1 ring-black/10"
  return "bg-ouro-moss/10 ring-1 ring-ouro-moss/12"
}

/** One action tool call: its name, opening to its arguments and its result. */
function ToolChip({ call, result, surface }: { call: ClassifiedToolCall; result?: TranscriptMessage; surface: TranscriptSurface }) {
  const resultText = result ? getMailboxTranscriptMessageText(result) : null
  return (
    <div className={`rounded px-2.5 ${toolChipClass(surface)}`}>
      <Collapsible title={<span className="font-mono text-xs">{call.name}</span>}>
        <div className="space-y-1.5">
          {call.rawArgs && <CodeBlock code={call.rawArgs} title="arguments" wrap className="max-h-40" />}
          {result && (
            <div className="space-y-1">
              <Badge>result</Badge>
              <CodeBlock code={resultText ?? ""} title="result" wrap className="max-h-48" />
            </div>
          )}
        </div>
      </Collapsible>
    </div>
  )
}
