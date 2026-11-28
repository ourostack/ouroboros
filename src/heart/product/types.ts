import type { HabitRunTrigger } from "../../arc/flight-recorder"
import type { DaemonResponse } from "../daemon/daemon"
import type { SchedulerOrigin } from "../daemon/scheduler-attestation"
import type { SupercronicSupervisorSnapshot } from "../daemon/supercronic-supervisor"
import type { ExternalEventInput } from "../external-events/router"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"
import type { ProviderCapability } from "../core"

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
  /** The product's tools, and the turns of its agent that get them (J3). */
  tools?: ProductTools
  /** What the agent reads about itself (J7). */
  status?: ProductStatus
  /** Core senses the product runs its own way (J6). */
  senses?: ProductSenses
  /** What the product's agent does for other agents over A2A beyond conversation (J8). */
  a2a?: ProductA2A
  /** The live acceptance run the product's own harness may have started, which core's senses record evidence for. */
  acceptance?: ProductAcceptance
}

export interface ProductA2A {
  /**
   * Accept delegated commands from peers the operator granted. A delegated command runs on the owner's menu, and core
   * announces each one through `notifyPrincipal` before it runs; a rejection refuses the command.
   */
  delegation?: { notifyPrincipal(agentName: string, notice: ProductNotice): Promise<void> }
  /** File failure reports from escalation peers, and confirm each one to the owner once the running version carries its fix. */
  escalation?: boolean
}

/** A notice for the owner: its id keeps a retry from sending it twice. */
export interface ProductNotice {
  noticeId: string
  text: string
}

/** The acceptance run in progress, as core's senses need it: its handle's digest and, when it has one, its label. */
export interface ProductAcceptanceMarker {
  scenarioHandleDigest: string
  label?: string
}

export interface ProductAcceptance {
  /** The run in progress for this agent, or null. A marker that can't be read throws. */
  marker(agentName: string): ProductAcceptanceMarker | null
  /** Runs an approved tool call inside the run, bound to its approval, so the run's evidence can name it. */
  runApproved<T>(approval: { approvalId: string; argumentDigest: string }, operation: () => T): T
}

export interface ProductSenses {
  telegram?: ProductSense
}

/**
 * How a product's agent sets up one of core's senses. The daemon's sense status and the prompt's both judge readiness
 * here, so they can't disagree.
 */
export interface ProductSense {
  /** Whether the sense reads this machine's config (`runtime/machines/<machine-id>/config`) as well as the portable one. */
  needsMachineConfig: boolean
  /** Whether the sense is set up, from the agent's two runtime configs. */
  readiness(input: ProductSenseReadinessInput): ProductSenseReadiness
  /** The repair line for a sense that isn't set up. */
  repairHint(agentName: string): string
  /** The name the sense shows for the admitted owner, when the product knows it. Core says "Owner" otherwise. */
  ownerName?(agentName: string): string
  /** The text the owner actually gets for a reply to their request; core sends the reply unchanged otherwise. */
  presentOwnerReply?(agentName: string, reply: ProductOwnerReply): string
}

/** A reply about to go to the owner, and the request it answers (normalised: NFKC, trimmed, lower case). */
export interface ProductOwnerReply {
  request: string | null
  text: string
}

export interface ProductSenseReadinessInput {
  /** The portable runtime config: whether it could be read, and what it holds ({} when it couldn't). */
  runtime: { ok: boolean; config: Record<string, unknown> }
  /** This machine's runtime config, the same way. */
  machine: { ok: boolean; config: Record<string, unknown> }
}

export interface ProductSenseReadiness {
  configured: boolean
  /** What the status shows: how the sense runs when it's set up, or what is missing when it isn't. */
  detail: string
}

export interface ProductTools {
  /**
   * The product's own tools. Core registers them while the product is loaded, so the collision check, the tool manifests
   * and the Ouro AX X-ray see them, but a turn is offered one only when `select` returns it.
   */
  definitions: readonly ToolDefinition[]
  /**
   * Whether this agent's turns are scoped to a relationship whenever one is known, and whenever the turn comes from outside
   * the host (any channel but inner, cli and mcp): such a turn gets only the relationship menu, and no tools at all
   * without a known profile.
   */
  relationshipScoped?: boolean
  /**
   * Tools to add to this turn's menu, after core's own selection and before core's filters (chat-action channels, the
   * relationship's advertised names, provider capabilities). Return only registered definitions: core's, through
   * `input.registered`, or one of `definitions` (or a copy with the same handler). Anything else stops the selection.
   */
  select?(input: ProductToolSelectionInput): readonly ToolDefinition[]
}

export interface ProductToolSelectionInput {
  /** The channel the turn runs in, when it has one. */
  channel: string | undefined
  /** Whether core scoped this turn to a relationship (see `relationshipScoped`). */
  relationshipScoped: boolean
  providerCapabilities: ReadonlySet<ProviderCapability> | undefined
  context: ProductToolSelectionContext
  /** One of core's registered tools by name, or undefined. */
  registered(name: string): ToolDefinition | undefined
}

export type ProductToolSelectionContext = Pick<ToolContext, "agentName" | "agentRoot" | "rootHost" | "context" | "currentSession" | "currentExternalEvent"> & {
  relationshipAuthorization?: Pick<NonNullable<ToolContext["relationshipAuthorization"]>, "profileId" | "advertisedToolNames"> & Partial<NonNullable<ToolContext["relationshipAuthorization"]>>
}

export interface ProductStatus {
  /** Sections `query_active_work` adds after the live world-state, for this agent. A rejection fails the tool call. */
  activeWorkSections(input: ProductStatusInput): Promise<string>
}

export interface ProductStatusInput {
  agentName: string
  /** The section the call asked for; the product says what its sections are. */
  section?: string
  offset: number
  limit: number
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
