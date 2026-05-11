import { emitNervesEvent } from "../nerves/runtime"

export interface AwaitTurnMessageOptions {
  awaitName: string
  condition: string
  body: string | undefined
  lastCheckedAt: string | null
  lastObservation: string | null
  checkedCount: number
  checkpoint: string | undefined
  now: () => Date
}

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

  if (options.checkpoint) {
    lines.push("")
    lines.push(`last checkpoint: ${options.checkpoint}`)
  }

  lines.push("")
  lines.push("look around and decide. if the condition is met, call resolve_await with verdict='yes' and a one-line observation. otherwise call resolve_await with verdict='no' and a one-line observation of what i saw this tick.")

  return lines.join("\n")
}
