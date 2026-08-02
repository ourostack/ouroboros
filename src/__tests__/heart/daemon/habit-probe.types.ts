import type { OuroCliCommand, RsvpCliCommand } from "../../../heart/daemon/cli-types"
import type { DaemonCommand } from "../../../heart/daemon/daemon"
import type { RunNativeRsvpHabitInput } from "../../../rsvp/native-habit-runner"
import type { RunPrivateRuntimeTurnOptions } from "../../../senses/private-runtime"

export const cliProbeCommand: Extract<OuroCliCommand, { kind: "habit.probe" }> = {
  kind: "habit.probe",
  agent: "test-agent",
  habitName: "rsvp-demo",
  noSend: true,
  json: true,
}

export const daemonProbeCommand: Extract<DaemonCommand, { kind: "habit.probe" }> = {
  kind: "habit.probe",
  agent: "test-agent",
  habitName: "rsvp-demo",
}

export const refreshCommand: Extract<RsvpCliCommand, { kind: "rsvp.refresh" }> = {
  kind: "rsvp.refresh",
  agent: "test-agent",
  habitName: "rsvp-demo",
  mode: "live",
  allowSend: true,
  noSend: true,
  json: true,
}

export const nativeProbeInput: RunNativeRsvpHabitInput = {
  agent: "test-agent",
  bundlesRoot: "/tmp/test-bundles",
  habitName: "rsvp-demo",
  trigger: "manual",
  noSend: true,
}

export const privateProbeOptions: RunPrivateRuntimeTurnOptions = {
  reason: "habit",
  habitName: "daily-demo",
  noSend: true,
}
