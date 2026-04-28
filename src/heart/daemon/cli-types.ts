/**
 * CLI command types and dependency interface.
 *
 * Extracted from daemon-cli.ts — the OuroCliCommand union and OuroCliDeps
 * interface are the contract between parsing, execution, and default wiring.
 */

import type { AgentProvider } from "../identity"
import type { ProviderLane } from "../provider-state"
import type { Facing } from "../../mind/friends/channel"
import type { TrustLevel } from "../../mind/friends/types"
import type { DaemonCommand, DaemonResponse } from "./daemon"
import type { HatchCredentialsInput, HatchFlowInput, HatchFlowResult } from "../hatch/hatch-flow"
import type { RuntimeAuthInput, RuntimeAuthResult } from "../auth/auth-flow"
import type { OuroPathInstallResult } from "../versioning/ouro-path-installer"
import type { TaskModule } from "../../repertoire/tasks/types"
import type { FriendStore } from "../../mind/friends/store"
import type { CheckForUpdateResult } from "../versioning/update-checker"
import type { DaemonHealthState } from "./daemon-health"
import type { VaultUnlockStoreKind } from "../../repertoire/vault-unlock"
import type { AgentReadinessIssue } from "./readiness-repair"
import type { VaultItemCompatibilityAlias, VaultItemTemplate } from "./vault-items"

export type RuntimeConfigScope = "agent" | "machine"
export type RuntimeConfigStatusScope = RuntimeConfigScope | "all"
export type ConnectTarget = "providers" | "perplexity" | "embeddings" | "teams" | "bluebubbles" | "mail"
export type DnsWorkflowAction = "backup" | "plan" | "apply" | "verify" | "rollback" | "certificate"

export type OuroCliCommand =
  | { kind: "daemon.up"; noRepair?: boolean }
  | { kind: "daemon.stop" }
  | { kind: "daemon.status" }
  | { kind: "daemon.logs" }
  | { kind: "daemon.logs.prune" }
  | { kind: "outlook"; json?: boolean }
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
  | { kind: "auth.run"; agent?: string; provider?: AgentProvider }
  | { kind: "auth.verify"; agent?: string; provider?: AgentProvider }
  | { kind: "auth.switch"; agent?: string; provider: AgentProvider; facing?: Facing }
  | { kind: "chat.connect"; agent: string }
  | { kind: "message.send"; from: string; to: string; content: string; sessionId?: string; taskRef?: string }
  | { kind: "task.poke"; agent: string; taskId: string }
  | { kind: "task.board"; status?: string; agent?: string }
  | { kind: "task.create"; title: string; type?: string; agent?: string }
  | { kind: "task.update"; id: string; status: string; agent?: string }
  | { kind: "task.show"; id: string; agent?: string }
  | { kind: "task.actionable"; agent?: string }
  | { kind: "task.deps"; agent?: string }
  | { kind: "task.sessions"; agent?: string }
  | { kind: "task.fix"; mode: "dry-run" | "safe" | "single"; issueId?: string; option?: number; agent?: string }
  | { kind: "whoami"; agent?: string }
  | { kind: "session.list"; agent?: string }
  | { kind: "thoughts"; agent?: string; last?: number; json?: boolean; follow?: boolean }
  | { kind: "reminder.create"; title: string; body: string; scheduledAt?: string; cadence?: string; category?: string; requester?: string; agent?: string }
  | { kind: "friend.list"; agent?: string }
  | { kind: "friend.show"; friendId: string; agent?: string }
  | { kind: "friend.create"; name: string; trustLevel?: string; agent?: string }
  | { kind: "friend.update"; friendId: string; trustLevel: TrustLevel; agent?: string }
  | { kind: "friend.link"; agent: string; friendId: string; provider: import("../../mind/friends/types").IdentityProvider; externalId: string }
  | { kind: "friend.unlink"; agent: string; friendId: string; provider: import("../../mind/friends/types").IdentityProvider; externalId: string }
  | { kind: "changelog"; from?: string; agent?: string }
  | { kind: "mcp.list" }
  | { kind: "mcp.call"; server: string; tool: string; args?: string }
  | { kind: "config.model"; agent?: string; modelName: string; facing?: Facing }
  | { kind: "config.models"; agent?: string }
  | { kind: "hatch.start"; agentName?: string; humanName?: string; provider?: AgentProvider; credentials?: HatchCredentialsInput; migrationPath?: string }
  | { kind: "rollback"; version?: string }
  | { kind: "versions" }
  | { kind: "daemon.dev"; repoPath?: string; clone?: boolean; clonePath?: string }
  | { kind: "attention.list"; agent?: string }
  | { kind: "attention.show"; id: string; agent?: string }
  | { kind: "attention.history"; agent?: string }
  | { kind: "inner.status"; agent?: string }
  | { kind: "mcp-serve"; agent: string; friendId?: string }
  | { kind: "setup"; tool: "claude-code" | "codex"; agent?: string }
  | { kind: "hook"; event: string; agent: string }
  | { kind: "habit.list"; agent?: string }
  | { kind: "habit.create"; agent?: string; name: string; cadence?: string }
  | { kind: "habit.poke"; agent: string; habitName: string }
  | { kind: "doctor"; json?: boolean }
  | { kind: "bluebubbles.replay"; agent?: string; messageGuid: string; eventType: "new-message" | "updated-message"; json?: boolean }
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
  ensureDaemonBootPersistence?: (socketPath: string) => Promise<void> | void
  startChat?: (agentName: string) => Promise<void>
  tailLogs?: (options?: { follow?: boolean; lines?: number; agentFilter?: string }) => () => void
  pruneDaemonLogs?: (options?: { logsDir?: string; agentName?: string }) => { filesCompacted: number; bytesFreed: number }
  taskModule?: TaskModule
  friendStore?: FriendStore
  whoamiInfo?: () => { agentName: string; homePath: string; bonesVersion: string }
  scanSessions?: (agentName: string) => Promise<SessionEntry[]>
  getChangelogPath?: () => string
  fetchImpl?: typeof fetch
  checkForCliUpdate?: () => Promise<CheckForUpdateResult>
  updateCheckTimeoutMs?: number
  installCliVersion?: (version: string) => Promise<void>
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
  reportDaemonStartupPhase?: (text: string) => void
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

export type TaskCliCommand = Extract<OuroCliCommand,
  | { kind: "task.board" }
  | { kind: "task.create" }
  | { kind: "task.update" }
  | { kind: "task.show" }
  | { kind: "task.actionable" }
  | { kind: "task.deps" }
  | { kind: "task.sessions" }
  | { kind: "task.fix" }
>

export type ReminderCliCommand = Extract<OuroCliCommand, { kind: "reminder.create" }>
export type FriendCliCommand = Extract<OuroCliCommand, { kind: "friend.list" } | { kind: "friend.show" } | { kind: "friend.create" } | { kind: "friend.update" } | { kind: "friend.link" } | { kind: "friend.unlink" }>
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
export type InnerStatusCliCommand = Extract<OuroCliCommand, { kind: "inner.status" }>
export type McpServeCliCommand = Extract<OuroCliCommand, { kind: "mcp-serve" }>
export type SetupCliCommand = Extract<OuroCliCommand, { kind: "setup" }>
export type HookCliCommand = Extract<OuroCliCommand, { kind: "hook" }>
export type HabitLocalCliCommand = Extract<OuroCliCommand, { kind: "habit.list" } | { kind: "habit.create" }>
export type McpListCliCommand = Extract<OuroCliCommand, { kind: "mcp.list" }>
export type McpCallCliCommand = Extract<OuroCliCommand, { kind: "mcp.call" }>
export type DoctorCliCommand = Extract<OuroCliCommand, { kind: "doctor" }>
export type CloneCliCommand = Extract<OuroCliCommand, { kind: "clone" }>
export type HelpCliCommand = Extract<OuroCliCommand, { kind: "help" }>
