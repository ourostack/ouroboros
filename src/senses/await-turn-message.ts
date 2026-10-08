import { emitNervesEvent } from "../nerves/runtime"

export interface AwaitTurnMessageOptions {
  awaitName: string
  condition: string
  body: string | undefined
  lastCheckedAt: string | null
  lastObservation: string | null
  checkedCount: number
  checkpoint: string | undefined
  /** From the runtime ask ledger: when the owner was last asked about this await, or null if never. */
  ownerAsk?: { at: string; question: string | null } | null
  now: () => Date
}

const WAITING_ON_OWNER = /\b(await(ing)?|wait(ing)?)\b[^.]{0,40}\b(ari|owner|decision|decide|choice)\b|\bdecision\b/i

function formatElapsed(ms: number): string {
  if (ms < 60_000) return "<1m ago"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function relativeAge(lastCheckedAt: string | null, now: () => Date): string | null {
  if (!lastCheckedAt) return null
  const lastMs = new Date(lastCheckedAt).getTime()
  if (!Number.isFinite(lastMs)) return null
  return formatElapsed(now().getTime() - lastMs)
}

export function buildAwaitTurnMessage(options: AwaitTurnMessageOptions): string {
  emitNervesEvent({
    component: "senses",
    event: "senses.await_turn_message_built",
    message: "built await tick message",
    meta: { awaitName: options.awaitName, checkedCount: options.checkedCount },
  })

  const lines: string[] = []
  lines.push(`await tick: ${options.awaitName} — ${options.condition}`)

  if (options.body && options.body.trim().length > 0) {
    lines.push("")
    lines.push("what would count as ready:")
    lines.push(options.body.trim())
  }

  const age = relativeAge(options.lastCheckedAt, options.now)
  const obs = options.lastObservation && options.lastObservation.trim().length > 0
    ? `last observation: "${options.lastObservation.trim()}"`
    : "last observation: (none yet)"
  if (options.checkedCount === 0) {
    lines.push("")
    lines.push("history: never checked. this is my first look.")
  } else {
    lines.push("")
    lines.push(`history: checked ${options.checkedCount}x so far. last checked ${age ?? "(unknown)"}. ${obs}.`)
  }

  const ask = options.ownerAsk ?? null
  lines.push(ask ? `owner asked: ${ask.at}${ask.question ? ` ("${ask.question}")` : ""}` : "owner asked: never")
  if (!ask && options.lastObservation && WAITING_ON_OWNER.test(options.lastObservation)) {
    lines.push("my owner has not been asked about this await, so \"awaiting a decision\" is not true. if the download is confirmed stalled, or media_queue marks it owner_decision_needed, ask now with verdict 'ask_owner'.")
  }

  if (options.checkpoint) {
    lines.push("")
    lines.push(`last checkpoint: ${options.checkpoint}`)
  }

  lines.push("")
  lines.push("look around and decide. if the condition is met, call resolve_await with verdict='yes' and a one-line observation. otherwise call resolve_await with verdict='no' and a one-line observation of what i saw this tick.")
  lines.push("verdicts: 'yes' (condition met), 'no' (not yet or unsure), 'ask_owner' (only when the condition cannot be met without my owner deciding, e.g. a confirmed dead download, or a stall the tool marks owner_decision_needed; give a plain question and 2-4 choices).")

  return lines.join("\n")
}
