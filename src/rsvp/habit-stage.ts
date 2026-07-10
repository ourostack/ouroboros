import * as fs from "node:fs"
import * as path from "node:path"

import { renderHabitFile } from "../heart/habits/habit-parser"
import { emitNervesEvent } from "../nerves/runtime"
import {
  RSVP_HABIT_ALLOWED_TOOLS,
  RSVP_HABIT_NAME,
  RSVP_HABIT_POLICY_VERSION,
  type RsvpHabitMetadata,
  type RsvpHabitMode,
} from "./habit-policy"

export interface StageRsvpHabitInput {
  agent: string
  agentRoot: string
  mode: RsvpHabitMode
  cadence: string
  now?: Date
}

export interface StageRsvpHabitResult {
  ok: true
  sideEffect: true
  agent: string
  name: typeof RSVP_HABIT_NAME
  habitName: typeof RSVP_HABIT_NAME
  habitPath: string
  mode: RsvpHabitMode
  cadence: string
  rsvp: RsvpHabitMetadata
}

function defaultRsvpHabitMetadata(mode: RsvpHabitMode): RsvpHabitMetadata {
  return {
    policyVersion: RSVP_HABIT_POLICY_VERSION,
    mode,
    sense: "bluebubbles",
    source: "aisleplanner",
    routeRef: "rsvp/config.json#bluebubblesRoute",
    snapshotRef: "state/rsvp/snapshots/latest.json",
    outboundStateRef: "state/rsvp/outbound-state.json",
    budgetRef: "state/rsvp/spend-ledger.json",
    idempotencyRef: "state/rsvp/outbound-state.json",
    liveSendEligible: false,
  }
}

function stagedHabitBody(): string {
  return [
    "Refresh AislePlanner RSVP state through the native RSVP workflow.",
    "Use the latest native snapshot to answer follow-up questions, and only surface RSVP updates through the guarded outbound policy.",
  ].join("\n\n")
}

export function stageRsvpHabit(input: StageRsvpHabitInput): StageRsvpHabitResult {
  const habitPath = path.join(input.agentRoot, "habits", `${RSVP_HABIT_NAME}.md`)
  const rsvp = defaultRsvpHabitMetadata(input.mode)
  const content = renderHabitFile({
    title: "RSVP Ari & Rachel",
    status: "active",
    cadence: input.cadence,
    created: (input.now ?? new Date()).toISOString(),
    tools: [...RSVP_HABIT_ALLOWED_TOOLS],
    continuity: { mode: "stateful" },
    rsvp,
  }, stagedHabitBody())

  fs.mkdirSync(path.dirname(habitPath), { recursive: true })
  fs.writeFileSync(habitPath, content, "utf-8")
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.habit_staged",
    message: "staged native RSVP habit",
    meta: { agent: input.agent, habitName: RSVP_HABIT_NAME, mode: input.mode, cadence: input.cadence },
  })
  return {
    ok: true,
    sideEffect: true,
    agent: input.agent,
    name: RSVP_HABIT_NAME,
    habitName: RSVP_HABIT_NAME,
    habitPath,
    mode: input.mode,
    cadence: input.cadence,
    rsvp,
  }
}
