import type { HabitRunTrigger } from "../../arc/flight-recorder"
import type { DaemonResponse } from "../daemon/daemon"
import type { SchedulerOrigin } from "../daemon/scheduler-attestation"
import type { SupercronicSupervisorSnapshot } from "../daemon/supercronic-supervisor"
import type { ExternalEventInput } from "../external-events/router"

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
