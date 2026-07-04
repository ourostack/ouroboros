import type { DaemonCommand } from "./daemon"
import { emitNervesEvent } from "../../nerves/runtime"

export type AwaitPrivateWakeTriggerSource = "await-poke" | "await-scheduler" | "await-expiry"

type PrivateWakeCommand = Extract<DaemonCommand, { kind: "private.wake" }>

const reasonPrefixByTrigger: Record<AwaitPrivateWakeTriggerSource, string> = {
  "await-poke": "manual await condition check",
  "await-scheduler": "scheduled await condition check",
  "await-expiry": "queued await expiry alert",
}

function awaitOriginRefs(
  awaitName: string,
  triggerSource: AwaitPrivateWakeTriggerSource,
): PrivateWakeCommand["originRefs"] {
  if (triggerSource === "await-poke") {
    return [
      { kind: "await", id: awaitName },
      { kind: "daemon-command", id: "await.poke" },
    ]
  }
  if (triggerSource === "await-scheduler") {
    return [
      { kind: "await", id: awaitName },
      { kind: "scheduler", id: "await-scheduler" },
    ]
  }
  return [
    { kind: "await", id: awaitName },
    { kind: "await-alert", id: "expired" },
  ]
}

export function buildAwaitPrivateWakeCommand(options: {
  agent: string
  awaitName: string
  triggerSource: AwaitPrivateWakeTriggerSource
  now?: () => Date
}): PrivateWakeCommand {
  const firedAt = (options.now ?? (() => new Date()))().toISOString()
  emitNervesEvent({
    component: "daemon",
    event: "daemon.await_private_wake_built",
    message: "built await private-runtime wake command",
    meta: {
      agent: options.agent,
      awaitName: options.awaitName,
      triggerSource: options.triggerSource,
    },
  })
  return {
    kind: "private.wake",
    agent: options.agent,
    reason: `${reasonPrefixByTrigger[options.triggerSource]} for ${options.awaitName}`,
    triggerSource: options.triggerSource,
    budgetClass: "scheduled",
    idempotencyKey: `await:${options.agent}:${options.awaitName}:${options.triggerSource}:${firedAt}`,
    originRefs: awaitOriginRefs(options.awaitName, options.triggerSource),
  }
}

export function awaitNameFromPrivateWakeCommand(
  command: Extract<DaemonCommand, { kind: "private.wake" | "inner.wake" }>,
): string | null {
  if (command.kind !== "private.wake") return null
  const awaitRef = command.originRefs?.find((ref) => ref.kind === "await" && typeof ref.id === "string")
  if (!awaitRef || typeof awaitRef.id !== "string") return null
  const trimmed = awaitRef.id.trim()
  return trimmed.length > 0 ? trimmed : null
}
