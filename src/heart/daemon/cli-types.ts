/**
 * CLI command types and dependency interface.
 *
 * Extracted from daemon-cli.ts — the OuroCliCommand union and OuroCliDeps
 * interface are the contract between parsing, execution, and default wiring.
 */

import type { AgentProvider } from "../identity"
import type { ProviderLane } from "../provider-lanes"
import type { Facing, TrustLevel, FriendStore } from "@ouro.bot/friends"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import type { HatchCredentialsInput, HatchFlowInput, HatchFlowResult } from "../hatch/hatch-flow"
import type { RuntimeAuthInput, RuntimeAuthResult } from "../auth/auth-flow"
import type { OuroPathInstallResult } from "../versioning/ouro-path-installer"
import type { CheckForUpdateResult } from "../versioning/update-checker"
import type { DaemonHealthState } from "./daemon-health"
import type { VaultUnlockStoreKind } from "../../repertoire/vault-unlock"
import type { AgentReadinessIssue } from "./readiness-repair"
import type { VaultItemCompatibilityAlias, VaultItemTemplate } from "./vault-items"
import type { HabitRunTrigger } from "../../arc/flight-recorder"
import type { HabitSummaryWhich } from "../habits/habit-session-summary"
import type { RsvpCutoverAction, RsvpCutoverDeps } from "../../rsvp/cutover"
import type { MailroomRegistry } from "../../mailroom/core"
import type { MailroomRuntimeConfig } from "../../mailroom/reader"
import type { HabitCancelDeps } from "../habits/habit-cancel"
import type { RsvpSendBoundaryDeps } from "../../rsvp/outbound-state"
import type { VersionIntent } from "../versioning/version-intent"
import type { Readable, Writable } from "stream"
import type { McpServer, McpServerOptions } from "../mcp/mcp-server"
import type { BlueBubblesWebhookRegistrationInput, BlueBubblesWebhookRegistrationResult } from "../../senses/bluebubbles/webhook-registration"
export type { RsvpCutoverAction } from "../../rsvp/cutover"

export type RuntimeConfigScope = "agent" | "machine"
export type RuntimeConfigStatusScope = RuntimeConfigScope | "all"
export type ConnectTarget = "providers" | "perplexity" | "embeddings" | "teams" | "bluebubbles" | "mail" | "voice" | "a2a" | "workbench"
export type DnsWorkflowAction = "backup" | "plan" | "apply" | "verify" | "rollback" | "certificate"
export type RsvpCliMode = "shadow" | "live"
export type RsvpSmokeMode = "preflight" | "live"
export type RsvpSmokeSurface = "bluebubbles"

export type OuroCliCommand =
  | { kind: "daemon.up"; noRepair?: boolean; latest?: boolean }
  | { kind: "daemon.stop" }
  | { kind: "daemon.status"; json?: boolean }
  | { kind: "daemon.logs" }
  | { kind: "daemon.logs.prune"; agent?: string }
  | { kind: "mailbox"; json?: boolean }
  | { kind: "provider.use"; agent?: string; lane: ProviderLane; provider: AgentProvider; model: string; force?: boolean; legacyFacing?: Facing }
  | { kind: "provider.check"; agent?: string; lane: ProviderLane; legacyFacing?: Facing }
  | { kind: "provider.status"; agent?: string }
  | { kind: "provider.refresh"; agent?: string }
  | { kind: "repair"; agent?: string }
  | { kind: "vault.create"; agent?: string; email?: string; serverUrl?: string; store?: VaultUnlockStoreKind; generateUnlockSecret?: boolean }
  | { kind: "vault.replace"; agent?: string; email?: string; serverUrl?: string; store?: VaultUnlockStoreKind; generateUnlockSecret?: boolean }
  | { kind: "vault.recover"; agent?: string; sources: string[]; email?: string; serverUrl?: string; store?: VaultUnlockStoreKind; generateUnlockSecret?: boolean }
  | { kind: "vault.unlock"; agent?: string; store?: VaultUnlockStoreKind }
  | { kind: "vault.status"; agent?: string; store?: VaultUnlockStoreKind }
  | { kind: "vault.config.set"; agent?: string; key: string; value?: string; scope?: RuntimeConfigScope }
  | { kind: "vault.config.status"; agent?: string; scope?: RuntimeConfigStatusScope }
  | { kind: "vault.item.set"; agent?: string; item: string; template?: VaultItemTemplate; secretFields?: string[]; publicFields?: string[]; note?: string; compatibilityAlias?: VaultItemCompatibilityAlias }
  | { kind: "vault.item.status"; agent?: string; item: string; compatibilityAlias?: VaultItemCompatibilityAlias }
  | { kind: "vault.item.list"; agent?: string; prefix?: string; compatibilityAlias?: VaultItemCompatibilityAlias }
  | { kind: "dns.workflow"; action: DnsWorkflowAction; agent?: string; bindingPath: string; outputPath?: string; backupPath?: string; yes?: boolean }
  | { kind: "connect"; agent?: string; target?: ConnectTarget; ownerEmail?: string; source?: string; noDelegatedSource?: boolean; rotateMissingMailKeys?: boolean }
  | { kind: "account.ensure"; agent?: string; ownerEmail?: string; source?: string; noDelegatedSource?: boolean; rotateMissingMailKeys?: boolean }
  | { kind: "mail.import-mbox"; agent?: string; filePath?: string; discover?: boolean; ownerEmail?: string; source?: string; foreground?: boolean; operationId?: string }
  | { kind: "mail.backfill-indexes"; agent?: string; foreground?: boolean; operationId?: string }
  | { kind: "mail.sync-cache"; agent?: string }
  | { kind: "auth.run"; agent?: string; provider?: AgentProvider }
  | { kind: "auth.verify"; agent?: string; provider?: AgentProvider }
  | { kind: "auth.switch"; agent?: string; provider: AgentProvider; facing?: Facing }
  | { kind: "chat.connect"; agent: string }
  | { kind: "message.send"; from: string; to: string; content: string; sessionId?: string; taskRef?: string }
  | { kind: "external.event.submit"; agent: string; source: string; eventType: string; eventId: string; summary?: string; evidence?: string[]; payloadPath?: string; priority?: string; sessionId?: string; taskRef?: string; wake?: boolean }
  | { kind: "task.poke"; agent: string; taskId: string }
  | { kind: "whoami"; agent?: string }
  | { kind: "session.list"; agent?: string }
  | { kind: "thoughts"; agent?: string; last?: number; json?: boolean; follow?: boolean }
  | { kind: "friend.list"; agent?: string }
  | { kind: "friend.show"; friendId: string; agent?: string }
  | { kind: "friend.create"; name: string; trustLevel?: string; agent?: string }
  | { kind: "friend.update"; friendId: string; trustLevel: TrustLevel; agent?: string }
  | { kind: "friend.link"; agent: string; friendId: string; provider: import("@ouro.bot/friends").IdentityProvider; externalId: string }
  | { kind: "friend.unlink"; agent: string; friendId: string; provider: import("@ouro.bot/friends").IdentityProvider; externalId: string }
  | { kind: "a2a.card"; agent?: string; baseUrl?: string; json?: boolean }
  | { kind: "a2a.onboard"; agent?: string; cardUrl: string; trustLevel?: TrustLevel; name?: string }
  | { kind: "a2a.serve"; agent?: string; host?: string; port?: number; baseUrl?: string; path?: string }
  | { kind: "changelog"; from?: string; agent?: string }
  | { kind: "mcp.list"; agent?: string }
  | { kind: "mcp.call"; agent?: string; server: string; tool: string; args?: string }
  | { kind: "mcp.canary"; agent: string; socketOverride?: string; requiredSenses?: string[]; json?: boolean }
  | { kind: "mcp.doctor"; agent: string; socketOverride?: string; json?: boolean; hostStallObserved?: boolean }
  | { kind: "config.model"; agent?: string; modelName: string; facing?: Facing }
  | { kind: "config.models"; agent?: string }
  | { kind: "hatch.start"; agentName?: string; humanName?: string; provider?: AgentProvider; credentials?: HatchCredentialsInput; migrationPath?: string }
  | { kind: "rollback"; version?: string }
  | { kind: "versions" }
  | { kind: "daemon.dev"; repoPath?: string; clone?: boolean; clonePath?: string }
  | { kind: "attention.list"; agent?: string }
  | { kind: "attention.show"; id: string; agent?: string }
  | { kind: "attention.history"; agent?: string }
  | { kind: "private.decisions"; agent?: string; limit: number; json: boolean }
  | { kind: "private.status"; agent?: string; json?: boolean; legacyAlias?: "inner" }
  | { kind: "work.card"; agent?: string; format?: "text" | "json" }
  | { kind: "work.gauntlet"; agent?: string; format?: "text" | "json" }
  | { kind: "work.sentinel"; agent?: string; format?: "text" | "json" }
  | { kind: "work.sentinel.refresh"; agent?: string; format?: "text" | "json" }
  | { kind: "nerves-review"; agent?: string; process: string; component?: string; event?: string; level?: string; since?: string; limit?: number; json: boolean }
  | { kind: "mcp-serve"; agent: string; friendId?: string; workbenchMcp?: string | true }
  | { kind: "setup"; tool: "claude-code" | "codex"; agent?: string }
  | { kind: "plugin.install"; source: string; agent?: string; version?: string }
  | { kind: "plugin.list"; agent?: string }
  | { kind: "plugin.remove"; pluginId: string; agent?: string }
  | { kind: "hook"; event: string; agent: string }
  | { kind: "habit.list"; agent?: string }
  | { kind: "habit.create"; agent?: string; name: string; cadence?: string }
  | { kind: "habit.runs"; agent?: string; limit: number }
  | { kind: "habit.inspect"; agent?: string; runId: string }
  | { kind: "habit.summary"; agent?: string; runId?: string; habitName?: string; operationId?: string; which?: HabitSummaryWhich; json: boolean }
  | { kind: "habit.cancel"; agent: string; habitName: string; evidenceLocator: string }
  | { kind: "habit.probe"; agent: string; habitName: string; noSend: true; json: boolean }
  | { kind: "habit.poke"; agent: string; habitName: string; trigger: HabitRunTrigger }
  | { kind: "await.poke"; agent: string; awaitName: string }
  | { kind: "desk"; agent?: string; tool: string; toolArgs: Record<string, unknown> }
  | { kind: "migrate-to-desk"; agent: string; root?: string; force?: boolean; dryRun?: boolean }
  | { kind: "doctor"; json?: boolean; category?: string; strict?: boolean }
  | { kind: "bluebubbles.replay"; agent?: string; messageGuid: string; eventType: "new-message" | "updated-message"; json?: boolean }
  | { kind: "bluebubbles.context-smoke"; agent?: string; messageGuid: string; persist?: boolean; json?: boolean }
  | { kind: "bluebubbles.host"; action: "install" | "status" | "repair" | "remove"; target?: { username: string; uid: number; homeDir: string }; json?: boolean }
  | { kind: "bluebubbles.host.collect"; requestId: string; json?: boolean }
  | { kind: "rsvp.doctor"; agent?: string; json?: boolean; strict?: boolean; outputPath?: string }
  | { kind: "rsvp.incident"; agent?: string; json?: boolean; outputPath?: string }
  | { kind: "rsvp.cutover"; agent?: string; legacyRoot: string; action: RsvpCutoverAction; yes?: boolean; json?: boolean; outputPath?: string }
  | { kind: "rsvp.legacy-render"; agent?: string; legacyRoot: string; json?: boolean; outputPath?: string }
  | { kind: "rsvp.replay"; agent?: string; fixturePath: string; json?: boolean; outputPath?: string }
  | { kind: "rsvp.config.import-legacy"; agent?: string; legacyRoot: string; mode: RsvpCliMode; yes?: boolean; json?: boolean; outputPath?: string }
  | { kind: "rsvp.habit.stage"; agent?: string; habitName?: string; title?: string; reportTitle?: string; mode: RsvpCliMode; cadence: string; json?: boolean; outputPath?: string }
  | { kind: "rsvp.import-legacy"; agent?: string; legacyRoot: string; mode: RsvpCliMode; yes?: boolean; json?: boolean; outputPath?: string }
  | { kind: "rsvp.refresh"; agent?: string; habitName?: string; mode: RsvpCliMode; noSend?: boolean; allowSend?: boolean; json?: boolean; outputPath?: string }
  | { kind: "rsvp.compare"; agent?: string; nativePath: string; legacyPath: string; json?: boolean; outputPath?: string }
  | { kind: "rsvp.smoke"; agent?: string; mode: RsvpSmokeMode; surface: RsvpSmokeSurface; question?: string; allowSend?: boolean; json?: boolean; outputPath?: string; replayOutputPath?: string }
  | { kind: "clone"; remote: string; agent?: string }
  | { kind: "help"; command?: string }

export interface OuroCliDeps {
  socketPath: string
  sendCommand: (socketPath: string, command: DaemonCommand) => Promise<DaemonResponse>
  startDaemonProcess: (socketPath: string) => Promise<{ pid: number | null }>
  writeStdout: (text: string) => void
  setExitCode?: (code: number) => void
  /** Raw terminal output. Does not append a newline. Use for in-place TTY renderers. */
  writeRaw?: (text: string) => void
  /** Whether stdout supports interactive cursor-control rendering. */
  isTTY?: boolean
  /** Terminal width override for width-aware command renderers in tests or alternate hosts. */
  stdoutColumns?: number
  checkSocketAlive: (socketPath: string) => Promise<boolean>
  cleanupStaleSocket: (socketPath: string) => void
  fallbackPendingMessage: (command: Extract<DaemonCommand, { kind: "message.send" }>) => string
  listDiscoveredAgents?: () => Promise<string[]> | string[]
  runHatchFlow?: (input: HatchFlowInput) => Promise<HatchFlowResult>
  runSerpentGuide?: () => Promise<string | null>
  runAuthFlow?: (input: RuntimeAuthInput) => Promise<RuntimeAuthResult>
  promptInput?: (question: string) => Promise<string>
  promptSecret?: (question: string) => Promise<string>
  registerOuroBundleType?: () => Promise<unknown> | unknown
  installOuroCommand?: () => OuroPathInstallResult
  ensureCurrentVersionInstalled?: () => void
  syncGlobalOuroBotWrapper?: () => Promise<unknown> | unknown
  ensureSkillManagement?: () => Promise<void>
  prepareDaemonRuntimeReplacement?: () => Promise<void> | void
  ensureDaemonBootPersistence?: (socketPath: string) => Promise<void> | void
  startChat?: (agentName: string) => Promise<void>
  tailLogs?: (options?: { follow?: boolean; lines?: number; agentFilter?: string }) => () => void
  pruneDaemonLogs?: (options?: { logsDir?: string; agentName?: string; bundlesRoot?: string }) => { filesCompacted: number; bytesFreed: number }
  friendStore?: FriendStore
  whoamiInfo?: () => { agentName: string; homePath: string; bonesVersion: string }
  scanSessions?: (agentName: string) => Promise<SessionEntry[]>
  getChangelogPath?: () => string
  fetchImpl?: typeof fetch
  /**
   * Reads the public Mailroom registry. Injected so hosted key assertion can be
   * exercised without Azure credentials; production uses `readMailroomRegistry`.
   */
  readMailroomRegistry?: (config: MailroomRuntimeConfig) => Promise<MailroomRegistry>
  checkForCliUpdate?: () => Promise<CheckForUpdateResult>
  readVersionIntent?: () => VersionIntent | null
  writeVersionIntent?: (intent: VersionIntent) => void
  updateCheckTimeoutMs?: number
  installCliVersion?: (version: string) => Promise<void>
  validateCliVersionForActivation?: (version: string) => { ok: boolean; message: string }
  activateCliVersion?: (version: string) => void
  getCurrentCliVersion?: () => string | null
  reExecFromNewVersion?: (args: string[]) => never
  getPreviousCliVersion?: () => string | null
  listCliVersions?: () => string[]
  existsSync?: (p: string) => boolean
  getRepoCwd?: () => string
  detectMode?: () => "dev" | "production"
  getInstalledBinaryPath?: () => string | null
  execInstalledBinary?: (binaryPath: string, args: string[]) => never
  agentBundleRoot?: string
  /** Test/alternate-host dependencies for grounded offline habit cancellation. */
  habitCancelDeps?: HabitCancelDeps
  /**
   * Root directory containing all `<agent>.ouro` bundles. Defaults to
   * `getAgentBundlesRoot()` (~/AgentBundles). Tests should set this to a
   * tmpdir to avoid leaking real bundles into the developer's home.
   */
  bundlesRoot?: string
  /**
   * Machine-local home directory for runtime state such as the stable machine id.
   * Tests should set this to a tmpdir to avoid leaking state into the developer's home.
   */
  homeDir?: string
  healthFilePath?: string
  readHealthState?: (healthPath: string) => DaemonHealthState | null
  readHealthUpdatedAt?: (healthPath: string) => number | null
  readRecentDaemonLogLines?: (lines?: number) => string[]
  sleep?: (ms: number) => Promise<void>
  spawnBackgroundCli?: (argv: string[]) => Promise<{ pid: number | null }>
  now?: () => number
  startupPollIntervalMs?: number
  startupStabilityWindowMs?: number
  startupTimeoutMs?: number
  startupRetryLimit?: number
  finalDaemonHealthSettleTimeoutMs?: number
  finalDaemonHealthSettlePollIntervalMs?: number
  reportDaemonStartupPhase?: (text: string) => void
  /**
   * Layer 2 boot sync probe injection — when set, called instead of the
   * real `runBootSyncProbe`. Tests inject a no-op stub so they don't trigger
   * real `git pull` invocations against the developer's home bundles.
   */
  runBootSyncProbeImpl?: typeof import("./boot-sync-probe").runBootSyncProbe
  /** Test/alternate-host injection for side-effect-safe RSVP legacy cutover probes. */
  rsvpCutoverDeps?: RsvpCutoverDeps
  /** Test/alternate-host injection for the durable RSVP send boundary. */
  rsvpSendBoundaryDeps?: RsvpSendBoundaryDeps
  /** Test/alternate-host seam for standard native BlueBubbles host setup during connect. */
  setupBlueBubblesHost?: (input: { bridgeUsername: string }) => Promise<{
    summary: string
    bridgeUsername: string
    bridgeUid: number
    bridgeHomeDir: string
  }>
  /** Test/alternate-host seam for connect-time owner-safe webhook reconciliation. */
  reconcileBlueBubblesWebhook?: (input: BlueBubblesWebhookRegistrationInput) => Promise<BlueBubblesWebhookRegistrationResult>
  /** Test/alternate-host MCP stdio and server ownership seams. */
  mcpServeInput?: Readable
  mcpServeOutput?: Writable
  createMcpServer?: (options: McpServerOptions) => McpServer
}

export interface SessionEntry {
  friendId: string
  friendName: string
  channel: string
  lastActivity: string
}

export interface EnsureDaemonResult {
  ok: boolean
  alreadyRunning: boolean
  message: string
  verifyStartupStatus?: boolean
  startedPid?: number | null
  startupFailureReason?: string | null
  stability?: {
    stable: string[]
    degraded: Array<{ agent: string; errorReason: string; fixHint: string; issue?: AgentReadinessIssue }>
  }
}

export interface GithubCopilotModel {
  id: string
  name: string
  capabilities?: string[]
}

export interface DiscoveredCredential {
  agentName: string
  provider: AgentProvider
  credentials: HatchCredentialsInput
  /** Full provider config block (model, endpoint, etc.) for runtime patching. */
  providerConfig: Record<string, string>
}

// ── Command group type aliases (used in toDaemonCommand exclusion) ──
export type FriendCliCommand = Extract<OuroCliCommand, { kind: "friend.list" } | { kind: "friend.show" } | { kind: "friend.create" } | { kind: "friend.update" } | { kind: "friend.link" } | { kind: "friend.unlink" }>
export type A2ACliCommand = Extract<OuroCliCommand, { kind: "a2a.card" } | { kind: "a2a.onboard" } | { kind: "a2a.serve" }>
export type WhoamiCliCommand = Extract<OuroCliCommand, { kind: "whoami" }>
export type SessionCliCommand = Extract<OuroCliCommand, { kind: "session.list" }>
export type ThoughtsCliCommand = Extract<OuroCliCommand, { kind: "thoughts" }>
export type AuthCliCommand = Extract<OuroCliCommand, { kind: "auth.run" }>
export type AuthVerifyCliCommand = Extract<OuroCliCommand, { kind: "auth.verify" }>
export type AuthSwitchCliCommand = Extract<OuroCliCommand, { kind: "auth.switch" }>
export type ProviderCliCommand = Extract<OuroCliCommand, { kind: "provider.use" } | { kind: "provider.check" } | { kind: "provider.status" } | { kind: "provider.refresh" }>
export type RepairCliCommand = Extract<OuroCliCommand, { kind: "repair" }>
export type VaultCliCommand = Extract<OuroCliCommand, { kind: "vault.create" } | { kind: "vault.replace" } | { kind: "vault.recover" } | { kind: "vault.unlock" } | { kind: "vault.status" } | { kind: "vault.config.set" } | { kind: "vault.config.status" } | { kind: "vault.item.set" } | { kind: "vault.item.status" } | { kind: "vault.item.list" }>
export type DnsCliCommand = Extract<OuroCliCommand, { kind: "dns.workflow" }>
export type ChangelogCliCommand = Extract<OuroCliCommand, { kind: "changelog" }>
export type ConfigModelCliCommand = Extract<OuroCliCommand, { kind: "config.model" }>
export type ConfigModelsCliCommand = Extract<OuroCliCommand, { kind: "config.models" }>
export type RollbackCliCommand = Extract<OuroCliCommand, { kind: "rollback" }>
export type VersionsCliCommand = Extract<OuroCliCommand, { kind: "versions" }>
export type AttentionCliCommand = Extract<OuroCliCommand, { kind: "attention.list" } | { kind: "attention.show" } | { kind: "attention.history" }>
export type PrivateDecisionsCliCommand = Extract<OuroCliCommand, { kind: "private.decisions" }>
export type PrivateStatusCliCommand = Extract<OuroCliCommand, { kind: "private.status" }>
export type WorkCardCliCommand = Extract<OuroCliCommand, { kind: "work.card" }>
export type WorkGauntletCliCommand = Extract<OuroCliCommand, { kind: "work.gauntlet" }>
export type WorkSentinelCliCommand = Extract<OuroCliCommand, { kind: "work.sentinel" } | { kind: "work.sentinel.refresh" }>
export type NervesReviewCliCommand = Extract<OuroCliCommand, { kind: "nerves-review" }>
export type McpServeCliCommand = Extract<OuroCliCommand, { kind: "mcp-serve" }>
export type SetupCliCommand = Extract<OuroCliCommand, { kind: "setup" }>
export type HookCliCommand = Extract<OuroCliCommand, { kind: "hook" }>
export type HabitLocalCliCommand = Extract<OuroCliCommand, { kind: "habit.list" } | { kind: "habit.create" } | { kind: "habit.runs" } | { kind: "habit.inspect" } | { kind: "habit.summary" } | { kind: "habit.cancel" }>
export type DeskCliCommand = Extract<OuroCliCommand, { kind: "desk" }>
export type MigrateToDeskCliCommand = Extract<OuroCliCommand, { kind: "migrate-to-desk" }>
export type McpListCliCommand = Extract<OuroCliCommand, { kind: "mcp.list" }>
export type McpCallCliCommand = Extract<OuroCliCommand, { kind: "mcp.call" }>
export type McpCanaryCliCommand = Extract<OuroCliCommand, { kind: "mcp.canary" }>
export type McpDoctorCliCommand = Extract<OuroCliCommand, { kind: "mcp.doctor" }>
export type DoctorCliCommand = Extract<OuroCliCommand, { kind: "doctor" }>
export type RsvpCliCommand = Extract<OuroCliCommand, { kind:
  | "rsvp.doctor"
  | "rsvp.incident"
  | "rsvp.cutover"
  | "rsvp.legacy-render"
  | "rsvp.replay"
  | "rsvp.config.import-legacy"
  | "rsvp.habit.stage"
  | "rsvp.import-legacy"
  | "rsvp.refresh"
  | "rsvp.compare"
  | "rsvp.smoke"
}>
export type CloneCliCommand = Extract<OuroCliCommand, { kind: "clone" }>
export type HelpCliCommand = Extract<OuroCliCommand, { kind: "help" }>
