import * as path from "node:path"

import {
  publishNewHabitDefinition,
  type HabitLifecycleDeps,
} from "../heart/habits/habit-lifecycle"
import { renderHabitFile } from "../heart/habits/habit-parser"
import { emitNervesEvent } from "../nerves/runtime"
import { ensureRsvpOutboundState } from "./outbound-state"
import { ensureRsvpSpendLedger } from "./spend-ledger"
import {
  DEFAULT_RSVP_HABIT_NAME,
  RSVP_HABIT_ALLOWED_TOOLS,
  RSVP_HABIT_POLICY_VERSION,
  isRsvpHabitName,
  type RsvpHabitMetadata,
  type RsvpHabitMode,
} from "./habit-policy"

export interface StageRsvpHabitInput {
  agent: string
  agentRoot: string
  habitName?: string
  title?: string
  reportTitle?: string
  mode: RsvpHabitMode
  cadence: string
  now?: Date
}

export interface StageRsvpHabitResult {
  ok: true
  sideEffect: true
  agent: string
  name: string
  habitName: string
  habitPath: string
  mode: RsvpHabitMode
  cadence: string
  rsvp: RsvpHabitMetadata
}

export interface StageRsvpHabitDeps {
  lifecycle?: HabitLifecycleDeps
}

export class RsvpHabitStageError extends Error {
  readonly code: string

  constructor(code: string, options: { cause?: unknown } = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "RsvpHabitStageError"
    this.code = code
  }
}

function defaultRsvpHabitMetadata(mode: RsvpHabitMode, reportTitle: string): RsvpHabitMetadata {
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
    reportTitle,
  }
}

function stagedHabitBody(): string {
  return [
    "Refresh AislePlanner RSVP state through the native RSVP workflow.",
    "Use the latest native snapshot to answer follow-up questions, and only surface RSVP updates through the guarded outbound policy.",
  ].join("\n\n")
}

function normalizeHabitName(name: string | undefined): string {
  const normalized = name?.trim() || DEFAULT_RSVP_HABIT_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized) || !isRsvpHabitName(normalized)) {
    throw new Error("RSVP habit name must start with rsvp- and contain only letters, numbers, underscores, or hyphens")
  }
  return normalized
}

export async function stageRsvpHabit(
  input: StageRsvpHabitInput,
  deps: StageRsvpHabitDeps = {},
): Promise<StageRsvpHabitResult> {
  const habitName = normalizeHabitName(input.habitName)
  const title = input.title?.trim() || "RSVP Updates"
  const rsvp = defaultRsvpHabitMetadata(input.mode, input.reportTitle?.trim() || title)
  const habitPath = path.join(input.agentRoot, "habits", `${habitName}.md`)
  const created = (input.now ?? new Date()).toISOString()
  const content = renderHabitFile({
    title,
    status: "active",
    cadence: input.cadence,
    created,
    tools: [...RSVP_HABIT_ALLOWED_TOOLS],
    continuity: { mode: "stateful" },
    rsvp,
  }, stagedHabitBody())

  const publication = publishNewHabitDefinition({
    agentRoot: input.agentRoot,
    habitId: habitName,
    bytes: content,
  }, deps.lifecycle)
  if (publication === "exists") throw new RsvpHabitStageError("habit_stage_exists")
  ensureRsvpOutboundState(input.agentRoot, created)
  ensureRsvpSpendLedger(input.agentRoot, created)
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.habit_staged",
    message: "staged native RSVP habit",
    meta: { agent: input.agent, habitName, mode: input.mode, cadence: input.cadence },
  })
  return {
    ok: true,
    sideEffect: true,
    agent: input.agent,
    name: habitName,
    habitName,
    habitPath,
    mode: input.mode,
    cadence: input.cadence,
    rsvp,
  }
}
