import type { HabitRunTrigger } from "../../arc/flight-recorder"
import type { DaemonResponse } from "../daemon/daemon"
import type { SchedulerOrigin } from "../daemon/scheduler-attestation"
import type { SupercronicSupervisorSnapshot } from "../daemon/supercronic-supervisor"
import type { ExternalEventInput } from "../external-events/router"
import type { ToolContext } from "../../repertoire/tools-base"

/**
 * The product seam: how a product built on the harness (the Butler is the first) tells core what it adds, so core files
 * never import product code. The image names the product's module in /opt/ouro/container-runtime.json (`product`); each
 * entry point loads it, and core asks `productFor(agentName)` for the job at hand. Each job gets one optional slot here,
 * added in the change that moves that job behind the seam.
 */
export interface OuroProduct {
  /** The seam version this product was built for; the harness refuses any other (see PRODUCT_SEAM_VERSION). */
  seamVersion: 1
  /** Static id for logs and error text. Never compared with agent names. */
  id: string
  /** The names this product's agent answers to: its current name first, then former ones. */
  agents: readonly [string, ...string[]]
  /**
   * Prepares the product's bundle when the daemon starts (J2). Called once, before the daemon starts anything, with what
   * the daemon knows about this start. `preflight` runs before and again after container credential bootstrap, and
   * `prepareManagedBundle` runs between them; a throw from either stops the start with the error's message.
   */
  startup?(input: ProductStartupInput): ProductStartup
  /**
   * Habits the daemon runs itself instead of waking the agent (J5), by habit name. A poke or cron fire of one of these
   * habits for this product's agent runs `run`, and the daemon records the run as it records any habit's.
   */
  habits?: Readonly<Record<string, ProductHabit>>
  /**
   * External-event sources whose events need the product's runtime ready before they wake the agent (J5), by source name.
   * The daemon checks `ready` before it claims a source's events, and the agent's process again before it runs one; a throw
   * holds the events, unclaimed, with the error's message as the repair line.
   */
  eventSources?: Readonly<Record<string, ProductEventSource>>
  /**
   * What a turn of this product's agent gets in its tool context (J4): the product's runtime for its tools, and the answer
   * gates it opts in to. Called for each private and A2A turn, and once when the Telegram sense starts. A rejection fails the turn (or the sense's start), except on an ordinary private turn (not one of the
   * product's own events), which runs without it so a gap in the product's config can't stop the agent from waking.
   */
  turnContext?(input: ProductTurnContextInput): Promise<ProductTurnContext>
}

export interface ProductTurnContextInput {
  agentName: string
  /** The sense the turn runs in: "telegram", "a2a" or "inner" for a private turn. */
  channel: string
  /** The source of the external event the turn handles, when it handles one. */
  externalEventSource?: string
}

/** The part of a turn's tool context a product supplies. */
export type ProductTurnContext = Partial<Pick<ToolContext, "agentRoot" | "sanctuary" | "answerGates">>

export interface ProductEventSource {
  ready(agentName: string): Promise<void>
}

export interface ProductHabit {
  /** Runs the habit; the response is the poke's. A throw records the run as failed with the error's message. */
  run(input: ProductHabitRunInput): Promise<DaemonResponse>
  /**
   * Whether a cron fire must prove it came from the container's scheduler (Supercronic). Core keeps the proof: it signs the
   * cron poke's process ancestry, checks it in the daemon, consumes each fire once, and refuses an unproven cron poke.
   */
  requiresSchedulerAttestation: boolean
  /** The acceptance scenario an attested fire binds to now, or null when none is running. Core signs it into the fire and checks it on arrival. */
  attestationScenario?(agentName: string): string | null
}

/** What the daemon gives a product habit's run. */
export interface ProductHabitRunInput {
  agent: string
  habitName: string
  trigger: HabitRunTrigger
  occurrenceId?: string
  /** This run's id, as its habit-run receipt records it. */
  runnerId: string
  /** The authenticated scheduler fire that started this run, on an attested cron fire only. */
  schedulerOrigin?: SchedulerOrigin
  /** The daemon's attested snapshot of the Supercronic it supervises for this agent, or null when it runs none. */
  schedulerSnapshot(): SupercronicSupervisorSnapshot | null
  /** Files an external event through the daemon, as `external.event.submit`; throws when the daemon refuses it. */
  submitExternalEvent(input: ExternalEventInput): Promise<{ shouldWake: boolean }>
}

/** What the daemon knows about this start when it asks the product to prepare. */
export interface ProductStartupInput {
  mode: "dev" | "production"
  /** The daemon's own argv, which carries the ENTRYPOINT's `--package-managed-agent`. */
  argv: readonly string[]
  /** The bundles homed on this machine. */
  managedAgents: readonly string[]
  repoRoot: string
  bundlesRoot: string
  runtimePackageVersion: string
}

export interface ProductStartup {
  preflight(): void
  prepareManagedBundle(): void
}

/** What a product module exports. */
export interface OuroProductModule {
  product: OuroProduct
}
