import { isHabitRunTrigger, type HabitRunTrigger } from "../../arc/flight-recorder"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonCommand } from "./daemon"

export type HabitPrivateWakeSourceRef =
  | { kind: "daemon-command"; id: "habit.poke" }
  | { kind: "daemon-entry"; id: "habit-scheduler" }

export type HabitPrivateWakeTriggerSource = `habit-${HabitRunTrigger}`

type PrivateWakeCommand = Extract<DaemonCommand, { kind: "private.wake" }>

export function buildHabitPrivateWakeCommand(options: {
  agent: string
  habitName: string
  trigger: HabitRunTrigger
  sourceRef: HabitPrivateWakeSourceRef
  occurrenceId?: string
  now?: () => Date
}): PrivateWakeCommand {
  const firedAt = (options.now ?? (() => new Date()))().toISOString()
  const occurrenceId = options.occurrenceId ?? firedAt
  const triggerSource: HabitPrivateWakeTriggerSource = `habit-${options.trigger}`
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_private_wake_built",
    message: "built habit private-runtime wake command",
    meta: {
      agent: options.agent,
      habitName: options.habitName,
      trigger: options.trigger,
      triggerSource,
      occurrenceId,
    },
  })
  return {
    kind: "private.wake",
    agent: options.agent,
    reason: `habit ${options.habitName} fired by ${options.trigger}`,
    triggerSource,
    budgetClass: "scheduled",
    idempotencyKey: `habit:${options.agent}:${options.habitName}:${options.trigger}:${occurrenceId}`,
    originRefs: [
      { kind: "habit", id: options.habitName },
      { kind: "habit-trigger", id: options.trigger },
      { kind: "habit-occurrence", id: occurrenceId },
      options.sourceRef,
    ],
  }
}

export function habitMessageFromPrivateWakeCommand(
  command: Extract<DaemonCommand, { kind: "private.wake" | "inner.wake" }>,
): { habitName: string; trigger: HabitRunTrigger } | null {
  if (command.kind !== "private.wake") return null
  if (typeof command.triggerSource !== "string" || !command.triggerSource.startsWith("habit-")) return null
  const habitRef = command.originRefs?.find((ref) => ref.kind === "habit" && typeof ref.id === "string")
  const triggerRef = command.originRefs?.find((ref) => ref.kind === "habit-trigger" && typeof ref.id === "string")
  if (!habitRef || typeof habitRef.id !== "string" || !triggerRef || typeof triggerRef.id !== "string") return null
  const habitName = habitRef.id.trim()
  const trigger = triggerRef.id.trim()
  if (habitName.length === 0) return null
  if (!isHabitRunTrigger(trigger)) return null
  if (command.triggerSource !== `habit-${trigger}`) return null
  return { habitName, trigger }
}
