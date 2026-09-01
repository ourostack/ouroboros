import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { randomUUID } from "node:crypto"
import { getAgentBundlesRoot, getRepoRoot, setAgentName } from "../identity"
import {
  listAllBundleAgents,
  listBundleSyncRows,
  listEnabledBundleAgents,
  type BundleAgentRow,
  type BundleSyncRow,
} from "./agent-discovery"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonSenseManagerLike, DaemonSenseRow } from "./sense-manager"
import { getRuntimeMetadata } from "./runtime-metadata"
import { detectRuntimeMode } from "./runtime-mode"
import { applyPendingUpdates, registerUpdateHook } from "../versioning/update-hooks"
import { bundleMetaHook } from "./hooks/bundle-meta"
import { agentConfigV2Hook } from "./hooks/agent-config-v2"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { CLI_UPDATE_DIST_TAG, startUpdateChecker, stopUpdateChecker } from "../versioning/update-checker"
import { execSync } from "child_process"
import { drainPending, PRIVATE_RUNTIME_PENDING, queuePendingMessageOnce } from "../../mind/pending"
import {
  handleAgentCatchup, handleAgentCheckGuidance,
  handleAgentCheckScope, handleAgentDelegate, handleAgentGetContext,
  handleAgentGetTask, handleAgentReportBlocker, handleAgentReportComplete,
  handleAgentReportProgress, handleAgentRequestDecision, handleAgentSearchFacts,
  handleAgentStatus,
} from "./agent-service"
import { getAlwaysOnSenseNames } from "@ouro.bot/friends"
import { getSharedMcpManager, shutdownSharedMcpManager } from "../../repertoire/mcp-manager"
import type { RuntimeMcpServers } from "../../repertoire/mcp-manager"
import { startMailboxHttpServer, type MailboxHttpServerHandle } from "../mailbox/mailbox-http"
import { MAILBOX_DEFAULT_PORT } from "../mailbox/mailbox-types"
import { readMailboxAgentState, readMailboxMachineState } from "../mailbox/mailbox-read"
import { buildMailboxAgentView, buildMailboxMachineView } from "../mailbox/mailbox-view"
import { buildAgentProviderVisibility, providerVisibilityStatusRows, type ProviderStatusRow } from "../provider-visibility"
import { resolveEffectiveProviderBinding } from "../provider-binding-resolver"
import {
  buildPrivateDecisionReadPayload,
  privateDecisionCountSummary,
  privateTurnLedgerPath,
  requestPrivateTurnDecision,
  readPrivateTurnLedger,
} from "../private-runtime"
import type { PrivateTurnDecision, PrivateTurnDenialCode, PrivateTurnOriginRef, PrivateTurnPolicyDeps, PrivateTurnRequest } from "../private-runtime"
import { DEFAULT_DAEMON_SOCKET_PATH } from "./socket-client"
import { isHabitRunTrigger, type HabitRunTrigger } from "../../arc/flight-recorder"
import { awaitNameFromPrivateWakeCommand, buildAwaitPrivateWakeCommand } from "./await-private-wake"
import { buildHabitPrivateWakeCommand, habitMessageFromPrivateWakeCommand } from "./habit-private-wake"
import { createDegradedHabitFile, parseHabitFile, type HabitFile } from "../habits/habit-parser"
import { applyHabitRuntimeState } from "../habits/habit-runtime-state"
import { buildExternalEventMessage, claimExternalEvent, externalEventRecoveryFailure, failExternalEventAttempt, getExternalEventRoot, isExactLegacyProviderRecoveryFailure, listExternalEventStatus, readExternalEventRecord, reconcileExternalEvent, recordExternalEvent, reviveExternalEventAfterRecovery, scanPrivilegedEventSpool, type ExternalEventFailureClass, type ExternalEventLeaseContext, type ExternalEventLeaseMember, type ExternalEventRecord, type ExternalEventStatus } from "../external-events/router"
import { isRsvpHabitName } from "../../rsvp/habit-policy"
import { readContainerRuntimePolicy } from "./container-runtime"
import type { RunNativeRsvpHabitInput, RunNativeRsvpHabitResult } from "../../rsvp/native-habit-runner"
import { completeHabitRun } from "../habits/habit-session"
import type { SanctuarySchedulerFireCommand, SanctuarySchedulerOrigin } from "./sanctuary-scheduler-origin"

const PIDFILE_PATH = path.join(os.homedir(), ".ouro-cli", "daemon.pids")

type HabitDispatchResolution =
  | { kind: "ready"; habit: HabitFile; occurrenceId?: string }
  | { kind: "skipped"; habit: HabitFile; skipReason: string }

/**
 * Defense-in-depth: detect if we're running under vitest. The pidfile lives
 * at a hardcoded path under the user's real ~/.ouro-cli/ — there's no DI
 * seam to redirect it. So when a test creates a real OuroDaemon and calls
 * start(), the daemon's killOrphanProcesses() reads the REAL pidfile,
 * ps-verifies the PIDs, and SIGTERMs the production daemon. We saw this
 * cause an outage on 2026-04-08 (alpha.265 daemon killed 93s after startup
 * by a vitest test that called daemon.start()).
 *
 * Both killOrphanProcesses() and writePidfile() short-circuit under vitest
 * to make the production pidfile sacred. Tests that need to verify these
 * functions' behavior should use the extracted pure helpers
 * (parseOrphanPidsFromPs, filterPidfilePidsToActualOrphans).
 */
function isVitestProcess(): boolean {
  /* v8 ignore next -- defensive: process and process.argv always exist in node @preserve */
  if (typeof process === "undefined" || !Array.isArray(process.argv)) return false
  return process.argv.some((arg) => typeof arg === "string" && arg.includes("vitest"))
}

export function messageFromHabitPokeError(error: unknown): string {
  if (error instanceof Error) return error.message
  /* v8 ignore next -- defensive fallback for hostile/non-Error throws from filesystem or parsers @preserve */
  return String(error)
}

/**
 * Scan `ps -eo pid,ppid,command` output for daemon-owned entry points whose
 * parent has died (PPID reparented to init/PID 1). Returns the list of PIDs
 * that are safe to SIGTERM — true orphans, not children of live sibling
 * daemons running from worktrees, test suites, or other users of the harness.
 *
 * Exported so unit tests can exercise the filter without shelling out.
 */
export function parseOrphanPidsFromPs(psOutput: string, selfPid: number): number[] {
  const orphans: number[] = []
  for (const line of psOutput.split("\n")) {
    // Explicitly exclude MCP server processes — they share a harness entry
    // point but are not daemon children and must never be killed.
    if (line.includes("mcp-serve") || line.includes("mcp serve")) continue
    // Match only daemon-owned JS entry points.
    if (
        !line.includes("agent-entry.js")
        && !line.includes("daemon-entry.js")
      && !line.includes("bluebubbles/entry.js")
      && !line.includes("mail-entry.js")
      && !line.includes("teams-entry.js")
      && !line.includes("a2a-entry.js")
      && !line.includes("telegram-entry.js")
      && !line.includes("voice-entry.js")
    ) continue
    // Parse `<pid> <ppid> <command...>`. ps pads these with leading spaces.
    // Regex guarantees both groups are \d+ so parseInt can't produce NaN.
    const match = line.trim().match(/^(\d+)\s+(\d+)\s/)
    if (!match) continue
    const pid = parseInt(match[1]!, 10)
    const ppid = parseInt(match[2]!, 10)
    if (pid === selfPid) continue
    // CRITICAL: only kill processes whose parent is init (PID 1). A live
    // PPID means the process belongs to another daemon instance (parallel
    // test run, sibling worktree, another user of /tmp/ouroboros-daemon.sock).
    // Killing those will crash unrelated harnesses — we saw this in B6
    // when a vitest worker's daemon killed a production agent's children.
    if (ppid !== 1) continue
    orphans.push(pid)
  }
  return orphans
}

/**
 * Given a list of PIDs from the pidfile, return only those that are actual
 * orphans (PPID reparented to init/PID 1). Protects against a polluted
 * pidfile killing a PID that the OS has reassigned to an unrelated process.
 *
 * Implementation: shells out to `ps -p <csv> -o pid,ppid` for a batch lookup.
 * Returns the empty list if ps fails — safer to skip cleanup than to
 * wildcard-kill on a bad read.
 *
 * Exported for direct unit coverage.
 */
export function filterPidfilePidsToActualOrphans(
  candidatePids: number[],
  psRunner: (pids: number[]) => string | null = runPsCheck,
): number[] {
  if (candidatePids.length === 0) return []
  const psOutput = psRunner(candidatePids)
  if (psOutput === null) return []
  const survivingOrphans: number[] = []
  // `ps -p x,y,z -o pid,ppid` emits a header line then one row per found PID.
  // PIDs not found (already exited) are silently omitted — which is the
  // correct behavior for us: we only want to kill live orphans.
  for (const line of psOutput.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/)
    if (!match) continue
    const pid = parseInt(match[1]!, 10)
    const ppid = parseInt(match[2]!, 10)
    if (ppid !== 1) continue
    if (!candidatePids.includes(pid)) continue
    survivingOrphans.push(pid)
  }
  return survivingOrphans
}

export function mergeUniqueOrphanPids(...sources: number[][]): number[] {
  const merged: number[] = []
  const seen = new Set<number>()
  for (const source of sources) {
    for (const pid of source) {
      if (seen.has(pid)) continue
      seen.add(pid)
      merged.push(pid)
    }
  }
  return merged
}

interface OrphanSettleDeps {
  isPidAlive?: (pid: number) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
}

const ORPHAN_CLEANUP_SETTLE_TIMEOUT_MS = 5_000
const ORPHAN_CLEANUP_SETTLE_POLL_INTERVAL_MS = 50

/* v8 ignore start -- process liveness probe; pure wait behavior covered via injected deps @preserve */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
/* v8 ignore stop */

/* v8 ignore start -- real timer wiring; wait behavior covered via injected sleep @preserve */
async function defaultSettleSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
/* v8 ignore stop */

export async function waitForOrphanProcessesToSettle(
  pids: number[],
  deps: OrphanSettleDeps = {},
): Promise<number[]> {
  if (pids.length === 0) return []
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSettleSleep
  const timeoutMs = deps.timeoutMs ?? ORPHAN_CLEANUP_SETTLE_TIMEOUT_MS
  const pollIntervalMs = deps.pollIntervalMs ?? ORPHAN_CLEANUP_SETTLE_POLL_INTERVAL_MS
  const deadline = now() + timeoutMs
  let survivors = pids.filter(isPidAlive)

  while (survivors.length > 0 && now() < deadline) {
    await sleep(pollIntervalMs)
    survivors = pids.filter(isPidAlive)
  }

  return survivors
}

export function assertOrphanCleanupComplete(survivingPids: number[]): void {
  if (survivingPids.length === 0) return
  const errorReason = `refusing startup while ${survivingPids.length} orphaned Ouro processes remain: ${survivingPids.join(", ")}`
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.orphan_cleanup_incomplete",
    message: errorReason,
    meta: { survivingPids },
  })
  throw new Error(errorReason)
}

export interface OrphanStartupDrainDeps {
  signalOrphans?: (socketPath: string) => number[]
  settleOrphans?: (pids: number[]) => Promise<number[]>
  maxSignalPasses?: number
}

const ORPHAN_CLEANUP_MAX_SIGNAL_PASSES = 8

export async function drainOrphanProcessesBeforeStartup(
  socketPath = DEFAULT_DAEMON_SOCKET_PATH,
  deps: OrphanStartupDrainDeps = {},
): Promise<void> {
  const signalOrphans = deps.signalOrphans ?? killOrphanProcesses
  const settleOrphans = deps.settleOrphans ?? waitForOrphanProcessesToSettle
  const maxSignalPasses = deps.maxSignalPasses ?? ORPHAN_CLEANUP_MAX_SIGNAL_PASSES

  for (let pass = 0; pass < maxSignalPasses; pass += 1) {
    const signaledPids = signalOrphans(socketPath)
    if (signaledPids.length === 0) return
    const survivingPids = await settleOrphans(signaledPids)
    assertOrphanCleanupComplete(survivingPids)
  }

  const errorReason = `orphan cleanup did not reach a fixed point after ${maxSignalPasses} signaling round(s)`
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.orphan_cleanup_not_converged",
    message: errorReason,
    meta: { maxSignalPasses },
  })
  throw new Error(errorReason)
}

/* v8 ignore start -- shells out to ps; covered by filterPidfilePidsToActualOrphans unit tests via injected runner @preserve */
function runPsCheck(pids: number[]): string | null {
  try {
    const csv = pids.join(",")
    return execSync(`ps -p ${csv} -o pid=,ppid=`, { encoding: "utf-8", timeout: 5000 })
  } catch {
    // ps returns non-zero when none of the requested PIDs exist. Treat as
    // "no survivors" rather than an error.
    return ""
  }
}
/* v8 ignore stop */

/**
 * Kill all ouro processes from the previous daemon instance using the pidfile.
 * On startup, reads PIDs from ~/.ouro-cli/daemon.pids, kills them all, then
 * deletes the file. The new daemon writes its own PIDs after spawning.
 *
 * Safety: pidfile contents are verified before being killed — each PID must
 * be an actual orphan (PPID reparented to init/PID 1) via
 * `filterPidfilePidsToActualOrphans`. Otherwise a polluted pidfile (written
 * by a test, or a crashed daemon whose PIDs have since been reused by the
 * OS) could SIGTERM unrelated processes.
 *
 * Falls back to ps-based scanning scoped to true orphans (PPID=1) if the
 * pidfile doesn't exist (first run, previous daemon crashed before writing,
 * manual cleanup). The scope is narrow on purpose — see parseOrphanPidsFromPs.
 */
/* v8 ignore start -- process lifecycle: uses kill/ps, tested via deployment @preserve */
function isProductionDaemonSocketPath(socketPath: string): boolean {
  return socketPath === DEFAULT_DAEMON_SOCKET_PATH
}

export function killOrphanProcesses(socketPath = DEFAULT_DAEMON_SOCKET_PATH): number[] {
  if (!isProductionDaemonSocketPath(socketPath)) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.orphan_cleanup_nonproduction_blocked",
      message: "blocked orphan cleanup for non-production daemon socket",
      meta: { socketPath, pidfilePath: PIDFILE_PATH },
    })
    return []
  }
  if (isVitestProcess()) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.orphan_cleanup_test_blocked",
      message: "blocked killOrphanProcesses from touching real pidfile under vitest",
      meta: { pidfilePath: PIDFILE_PATH },
    })
    return []
  }
  try {
    let pidfileOrphans: number[] = []
    let scanOrphans: number[] = []

    // Primary: read pidfile from previous daemon
    try {
      const raw = fs.readFileSync(PIDFILE_PATH, "utf-8")
      const candidates = raw.split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n !== process.pid)
      // Verify each candidate is an actual live orphan before killing. See
      // docstring above for why this matters.
      pidfileOrphans = filterPidfilePidsToActualOrphans(candidates)
      fs.unlinkSync(PIDFILE_PATH)
    } catch {
      // No pidfile — the ps scan below still covers true orphans.
    }

    // Always supplement the pidfile with the scoped ps scan. A stale or
    // partial pidfile can otherwise kill one old daemon while leaving a
    // sibling PPID=1 daemon alive without a socket.
    try {
      const result = execSync("ps -eo pid,ppid,command", { encoding: "utf-8", timeout: 5000 })
      scanOrphans = parseOrphanPidsFromPs(result, process.pid)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`could not discover orphaned Ouro processes: ${detail}`)
    }

    const pidsToKill = mergeUniqueOrphanPids(pidfileOrphans, scanOrphans)

    if (pidsToKill.length > 0) {
      for (const pid of pidsToKill) {
        try { process.kill(pid, "SIGTERM") } catch { /* already exited */ }
      }
      emitNervesEvent({
        component: "daemon",
        event: "daemon.orphan_cleanup",
        message: `killed ${pidsToKill.length} orphaned ouro processes`,
        meta: { pids: pidsToKill },
      })
    }
    return pidsToKill
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.orphan_cleanup_error",
      message: "failed to clean up orphaned ouro processes",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Write all managed PIDs (daemon + children) to the pidfile.
 * Called after all agents and senses are spawned.
 */
export function writePidfile(extraPids: number[] = [], socketPath = DEFAULT_DAEMON_SOCKET_PATH): void {
  if (!isProductionDaemonSocketPath(socketPath)) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.write_pidfile_nonproduction_blocked",
      message: "blocked production pidfile write for non-production daemon socket",
      meta: { socketPath, pidfilePath: PIDFILE_PATH, attemptedPids: extraPids.length },
    })
    return
  }
  if (isVitestProcess()) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.write_pidfile_test_blocked",
      message: "blocked writePidfile from clobbering real pidfile under vitest",
      meta: { pidfilePath: PIDFILE_PATH, attemptedPids: extraPids.length },
    })
    return
  }
  try {
    const pids = [process.pid, ...extraPids].filter(Boolean)
    fs.mkdirSync(path.dirname(PIDFILE_PATH), { recursive: true })
    fs.writeFileSync(PIDFILE_PATH, pids.join("\n") + "\n", "utf-8")
  } catch { /* best effort */ }
}
/* v8 ignore stop */

export interface DaemonCronJobSummary {
  id: string
  schedule: string
  lastRun: string | null
}

export interface DaemonHealthResult {
  name: string
  status: "ok" | "warn" | "critical"
  message: string
}

export interface DaemonMessageReceipt {
  id: string
  queuedAt: string
}

export interface DaemonProcessManagerLike {
  startAutoStartAgents(): Promise<void>
  triggerAutoStartAgents?(): void
  stopAll(): Promise<void>
  startAgent(agent: string, options?: { skipConfigCheck?: boolean }): Promise<void>
  resetAgentFailureState(agent: string): void
  stopAgent?(agent: string): Promise<void>
  restartAgent?(agent: string, options?: { skipConfigCheck?: boolean }): Promise<void>
  sendToAgent?(agent: string, message: Record<string, unknown>): void
  listAgentSnapshots(): Array<{
    name: string
    channel: string
    autoStart?: boolean
    status: string
    pid: number | null
    restartCount: number
    startedAt: string | null
    lastCrashAt: string | null
    backoffMs: number
    lastExitCode?: number | null
    lastSignal?: string | null
    errorReason?: string | null
    fixHint?: string | null
  }>
}

export interface DaemonSchedulerLike {
  listJobs(): DaemonCronJobSummary[]
  listDegradedJobs?: () => Array<{ id: string; reason: string }>
  triggerJob(jobId: string): Promise<{ ok: boolean; message: string }>
  triggerHabitJob?(jobId: string): Promise<{ ok: boolean; message: string }>
  start?: () => void
  stop?: () => void
  reconcile?: () => Promise<void> | void
  recordTaskRun?: (agent: string, taskId: string) => Promise<void> | void
}

export interface DaemonHealthMonitorLike {
  runChecks(): Promise<DaemonHealthResult[]>
  stopPeriodicChecks?(): void
  getLastResults?(): DaemonHealthResult[]
}

export interface DaemonRouterLike {
  send(message: {
    from: string
    to: string
    content: string
    priority?: string
    sessionId?: string
    taskRef?: string
  }): Promise<DaemonMessageReceipt>
  pollInbox(agent: string): Array<{ id: string; from: string; content: string; queuedAt: string; priority: string }>
}

export type DaemonCommand =
  | { kind: "daemon.start" }
  | { kind: "daemon.stop" }
  | { kind: "daemon.restart"; reason?: string; requestedBy?: string }
  | { kind: "daemon.status" }
  | { kind: "daemon.health" }
  | { kind: "daemon.logs" }
  | { kind: "daemon.sense_revive"; agent: string; sense: string; reason: string }
  | { kind: "agent.start"; agent: string }
  | { kind: "agent.stop"; agent: string }
  | { kind: "agent.restart"; agent: string; skipConfigCheck?: boolean }
  | { kind: "agent.ask"; agent: string; friendId: string; question?: string; [key: string]: unknown }
  | { kind: "agent.status"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.catchup"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.delegate"; agent: string; friendId: string; task?: string; context?: string; [key: string]: unknown }
  | { kind: "agent.getContext"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.searchFacts"; agent: string; friendId: string; query?: string; [key: string]: unknown }
  | { kind: "agent.getTask"; agent: string; friendId: string; [key: string]: unknown }
  | { kind: "agent.checkScope"; agent: string; friendId: string; item?: string; [key: string]: unknown }
  | { kind: "agent.requestDecision"; agent: string; friendId: string; topic?: string; options?: string[]; [key: string]: unknown }
  | { kind: "agent.checkGuidance"; agent: string; friendId: string; topic?: string; [key: string]: unknown }
  | { kind: "agent.reportProgress"; agent: string; friendId: string; summary?: string; [key: string]: unknown }
  | { kind: "agent.reportBlocker"; agent: string; friendId: string; blocker?: string; [key: string]: unknown }
  | { kind: "agent.reportComplete"; agent: string; friendId: string; summary?: string; [key: string]: unknown }
  | { kind: "cron.list" }
  | { kind: "cron.trigger"; jobId: string }
  | { kind: "private.decisions"; agent: string; limit?: number }
  | {
    kind: "private.wake"
    agent: string
    reason?: string
    triggerSource?: string
    budgetClass?: string
    idempotencyKey?: string
    originRefs?: PrivateTurnOriginRef[]
    noSend?: true
  }
  | { kind: "inner.wake"; agent: string }
  | { kind: "chat.connect"; agent: string }
  | { kind: "task.poke"; agent: string; taskId: string }
  | { kind: "habit.poke"; agent: string; habitName: string; trigger?: HabitRunTrigger; occurrenceId?: string }
  | SanctuarySchedulerFireCommand
  | { kind: "habit.probe"; agent: string; habitName: string; noSend?: true }
  | { kind: "await.poke"; agent: string; awaitName: string }
  | { kind: "external.event.submit"; agent: string; source: string; eventType: string; eventId: string; summary?: string; evidence?: string[]; payloadPath?: string; priority?: string; sessionId?: string; taskRef?: string; wake?: boolean; observationRevision?: string; transition?: import("../external-events/router").ExternalEventTransition }
  | { kind: "message.send"; from: string; to: string; content: string; priority?: string; sessionId?: string; taskRef?: string }
  | { kind: "message.poll"; agent: string }
  | { kind: "mcp.list"; agent?: string }
  | { kind: "mcp.call"; agent?: string; server: string; tool: string; args?: string }
  | { kind: "hatch.start" }
  | { kind: "agent.senseTurn"; agent: string; friendId: string; channel: string; sessionKey: string; message: string; runtimeMcp?: RuntimeMcpServers }

export interface DaemonResponse {
  ok: boolean
  summary?: string
  message?: string
  error?: string
  denialCode?: PrivateTurnDenialCode | "managed_runtime_unavailable"
  data?: unknown
}

export interface OuroDaemonOptions {
  socketPath: string
  processManager: DaemonProcessManagerLike
  scheduler: DaemonSchedulerLike
  healthMonitor: DaemonHealthMonitorLike
  router: DaemonRouterLike
  senseManager?: DaemonSenseManagerLike
  bundlesRoot?: string
  mode?: "dev" | "production"
  /**
   * Factory for the Mailbox HTTP server. Tests inject a stub so they can
   * exercise the full start/stop lifecycle without binding to port 6876
   * (which is held by a running production daemon on dev machines and
   * causes EADDRINUSE flakes). Defaults to the real `startMailboxHttpServer`
   * wired with the daemon's bundlesRoot and view builders.
   */
  mailboxServerFactory?: () => Promise<MailboxHttpServerHandle>
  privateRuntimePolicyDeps?: PrivateTurnPolicyDeps
  /**
   * Runs after a daemon.stop command has completed daemon-owned cleanup but
   * before the JSON response is returned to the command socket. Entrypoints
   * use this to schedule process-level shutdown without putting process.exit()
   * in the daemon core.
   */
  onStopCommandComplete?: () => void | Promise<void>
  /** Test seam for external-event receipts. Defaults to ~/.ouro-cli/daemon/external-events. */
  externalEventRoot?: string
  /** Root-owned host detector spool, mounted read-only in the daemon container. */
  privilegedEventSpoolRoot?: string
  privilegedEventScanner?: typeof scanPrivilegedEventSpool
  /** Test seam for typed native RSVP habit execution. Defaults to the real native runner. */
  rsvpHabitRunner?: (input: RunNativeRsvpHabitInput) => Promise<RunNativeRsvpHabitResult>
  nativeHabitRunner?: (input: { agent: string; habitName: string; trigger: HabitRunTrigger; occurrenceId?: string; runnerId: string; schedulerOrigin?: SanctuarySchedulerOrigin }) => Promise<DaemonResponse | null>
  nativeHabitMatch?: (agent: string, habitName: string) => boolean
  schedulerFireVerifier?: (command: SanctuarySchedulerFireCommand) => SanctuarySchedulerOrigin & { occurrenceId: string }
  schedulerFireConsumer?: (origin: SanctuarySchedulerOrigin & { occurrenceId: string }) => void
  /** Startup barrier that proves no prior Ouro daemon/worker remains before
   *  this daemon opens its socket or autostarts any replacement. */
  orphanStartupDrain?: (socketPath: string) => Promise<void>
}

interface DaemonWorkerRow {
  agent: string
  worker: string
  autoStart: boolean
  status: string
  pid: number | null
  restartCount: number
  startedAt: string | null
  lastExitCode: number | null
  lastSignal: string | null
  errorReason: string | null
  fixHint: string | null
}

interface DaemonStatusOverview {
  daemon: "running" | "stopped"
  health: "ok" | "warn"
  socketPath: string
  mailboxUrl: string
  outlookUrl: string
  version: string
  lastUpdated: string
  repoRoot: string
  configFingerprint: string
  workerCount: number
  senseCount: number
  entryPath: string
  mode: "dev" | "production"
}

interface DaemonStatusPayload {
  overview: DaemonStatusOverview
  workers: DaemonWorkerRow[]
  senses: DaemonSenseRow[]
  healthChecks?: DaemonHealthResult[]
  sync: BundleSyncRow[]
  /** Every discovered bundle (`<name>.ouro` with a parseable agent.json),
   * including disabled ones. The senses/workers/sync rows above only cover
   * enabled bundles, so without this field disabled agents are invisible
   * in `ouro status`. */
  agents: BundleAgentRow[]
  /** Safe provider/model/readiness rows for every discovered bundle. */
  providers?: ProviderStatusRow[]
  externalEvents?: ExternalEventStatus[]
}

interface SocketIdentity {
  dev: number
  ino: number
  ctimeMs: number
}

function readSocketIdentity(socketPath: string): SocketIdentity | null {
  try {
    const stats = fs.lstatSync(socketPath)
    return {
      dev: stats.dev,
      ino: stats.ino,
      ctimeMs: stats.ctimeMs,
    }
  } catch {
    return null
  }
}

function sameSocketIdentity(left: SocketIdentity | null, right: SocketIdentity | null): boolean {
  if (!left || !right) return false
  return left.dev === right.dev && left.ino === right.ino && left.ctimeMs === right.ctimeMs
}

function buildWorkerRows(
  snapshots: ReturnType<DaemonProcessManagerLike["listAgentSnapshots"]>,
): DaemonWorkerRow[] {
  return snapshots.map((snapshot) => ({
    agent: snapshot.name,
    worker: snapshot.channel,
    autoStart: snapshot.autoStart ?? true,
    status: snapshot.status,
    pid: snapshot.pid,
    restartCount: snapshot.restartCount,
    startedAt: snapshot.startedAt,
    lastExitCode: snapshot.lastExitCode ?? null,
    lastSignal: snapshot.lastSignal ?? null,
    errorReason: snapshot.errorReason ?? null,
    fixHint: snapshot.fixHint ?? null,
  }))
}

function unhealthySenseRows(senses: DaemonSenseRow[]): DaemonSenseRow[] {
  return senses.filter((row) => {
    if (!row.enabled) return false
    if (row.status === "disabled" || row.status === "not_attached") return false
    if (row.status === "interactive" || row.status === "running") return false
    return true
  })
}

function isParkedWorker(row: DaemonWorkerRow): boolean {
  return row.autoStart === false && row.status === "stopped"
}

function unhealthyWorkerRows(workers: DaemonWorkerRow[]): DaemonWorkerRow[] {
  return workers.filter((row) => !isParkedWorker(row) && row.status !== "running")
}

function unhealthyHealthChecks(healthChecks: DaemonHealthResult[]): DaemonHealthResult[] {
  return healthChecks.filter((row) => row.status !== "ok")
}

function overviewHealth(workers: DaemonWorkerRow[], senses: DaemonSenseRow[], healthChecks: DaemonHealthResult[] = []): "ok" | "warn" {
  if (unhealthyWorkerRows(workers).length > 0) return "warn"
  if (unhealthySenseRows(senses).length > 0) return "warn"
  if (unhealthyHealthChecks(healthChecks).length > 0) return "warn"
  return "ok"
}

function formatStatusSummary(payload: DaemonStatusPayload): string {
  if (payload.overview.workerCount === 0 && payload.overview.senseCount === 0 && (payload.healthChecks ?? []).length === 0) {
    return "no managed agents"
  }
  const degraded = [
    ...unhealthyWorkerRows(payload.workers)
      .map((row) => `worker:${row.agent}/${row.worker}:${row.status}`),
    ...unhealthySenseRows(payload.senses)
      .map((row) => `sense:${row.agent}/${row.sense}:${row.status}`),
    ...(payload.healthChecks ?? [])
      .filter((row) => row.status !== "ok")
      .map((row) => `health-check:${row.name}:${row.status}`),
  ]
  const detail = degraded.length > 0 ? `\tdegraded=${degraded.join(",")}` : ""
  if (!detail) {
    const rows = [
      ...payload.workers.map((row) => `${row.agent}/${row.worker}:${row.status}`),
      ...payload.senses
        .filter((row) => row.enabled)
        .map((row) => `${row.agent}/${row.sense}:${row.status}`),
    ]
    const items = rows.length > 0 ? `\titems=${rows.join(",")}` : ""
    return `daemon=${payload.overview.daemon}\tworkers=${payload.overview.workerCount}\tsenses=${payload.overview.senseCount}\thealth=${payload.overview.health}${items}`
  }
  return `daemon=${payload.overview.daemon}\tworkers=${payload.overview.workerCount}\tsenses=${payload.overview.senseCount}\thealth=${payload.overview.health}${detail}`
}

function parseIncomingCommand(raw: string): DaemonCommand {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Invalid daemon command payload: expected JSON object.")
  }

  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
    throw new Error("Invalid daemon command payload: missing kind.")
  }

  const kind = (parsed as { kind?: unknown }).kind
  if (typeof kind !== "string") {
    throw new Error("Invalid daemon command payload: kind must be a string.")
  }

  return parsed as DaemonCommand
}

function isValidSenseReviveCommand(command: Extract<DaemonCommand, { kind: "daemon.sense_revive" }>): boolean {
  return typeof command.agent === "string"
    && typeof command.sense === "string"
    && typeof command.reason === "string"
}

function isValidTaskPokeCommand(command: Extract<DaemonCommand, { kind: "task.poke" }>): boolean {
  return typeof command.agent === "string"
    && command.agent.trim().length > 0
    && typeof command.taskId === "string"
    && command.taskId.trim().length > 0
}

function isValidHabitPokeCommand(command: Extract<DaemonCommand, { kind: "habit.poke" }>): boolean {
  return typeof command.agent === "string"
    && command.agent.trim().length > 0
    && typeof command.habitName === "string"
    && command.habitName.trim().length > 0
}

function isValidHabitProbeCommand(command: Extract<DaemonCommand, { kind: "habit.probe" }>): boolean {
  return typeof command.agent === "string"
    && command.agent.trim().length > 0
    && typeof command.habitName === "string"
    && command.habitName.trim().length > 0
    && (command.noSend === undefined || command.noSend === true)
}

function taskIdFromTaskPokePrivateWakeCommand(
  command: Extract<DaemonCommand, { kind: "private.wake" | "inner.wake" }>,
): string | null {
  if (command.kind !== "private.wake" || command.triggerSource !== "task-poke") return null
  const taskRef = command.originRefs?.find((ref) => ref.kind === "task" && typeof ref.id === "string")
  if (!taskRef || typeof taskRef.id !== "string") return null
  const trimmed = taskRef.id.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Handle agent.senseTurn command: runs a full agent turn via the daemon process.
 * Dynamic import lazy-loads shared-turn. Hot-reload works because ouro dev
 * restarts the daemon process (fresh module cache).
 */
export async function handleAgentSenseTurn(
  command: Extract<DaemonCommand, { kind: "agent.senseTurn" }>,
  runtime?: { socketPath?: string },
): Promise<DaemonResponse> {
  try {
    const { setAgentName } = await import("../identity")
    setAgentName(command.agent)
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const result = await runSenseTurn({
      agentName: command.agent,
      channel: command.channel as import("@ouro.bot/friends").Channel,
      sessionKey: command.sessionKey,
      friendId: command.friendId,
      userMessage: command.message,
      ...(runtime?.socketPath ? { toolContext: { daemonSocketPath: runtime.socketPath } } : {}),
      // Per-turn, per-agent runtime MCP injection (e.g. Workbench's ouro_workbench).
      // Scoped to THIS turn only — never stored as module state, so a concurrent
      // turn for a different agent cannot inherit these servers.
      ...(command.runtimeMcp ? { runtimeMcpServers: command.runtimeMcp } : {}),
    })
    return {
      ok: true,
      message: result.response,
      data: { ponderDeferred: result.ponderDeferred },
    }
  } catch (error) {
    /* v8 ignore next -- branch: String(error) fallback only for non-Error throws @preserve */
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `sense turn failed: ${errorMessage}` }
  }
}

export async function handleAgentAskTurn(
  command: Extract<DaemonCommand, { kind: "agent.ask" }>,
  runtime?: { socketPath?: string },
): Promise<DaemonResponse> {
  /* v8 ignore start -- ask command parameter defaults are legacy MCP compatibility; send_message shares the primary path @preserve */
  const question = typeof command.question === "string" ? command.question : ""
  if (!question.trim()) return { ok: false, error: "Missing required parameter: question" }
  const channel = typeof command.channel === "string" && command.channel.trim() ? command.channel.trim() : "mcp"
  const sessionKey = typeof command.sessionKey === "string" && command.sessionKey.trim()
    ? command.sessionKey.trim()
    : `agent-ask:${command.friendId}`
  /* v8 ignore stop */
  return handleAgentSenseTurn({
    kind: "agent.senseTurn",
    agent: command.agent,
    friendId: command.friendId,
    channel,
    sessionKey,
    message: question,
  }, runtime)
}

export class OuroDaemon {
  private readonly socketPath: string
  private readonly processManager: DaemonProcessManagerLike
  private readonly scheduler: DaemonSchedulerLike
  private readonly healthMonitor: DaemonHealthMonitorLike
  private readonly router: DaemonRouterLike
  private readonly senseManager: DaemonSenseManagerLike | null
  private readonly bundlesRoot: string
  private readonly mode: "dev" | "production"
  private server: net.Server | null = null
  private mailboxServer: MailboxHttpServerHandle | null = null
  private socketIdentity: SocketIdentity | null = null
  private senseAutostartTimer: ReturnType<typeof setTimeout> | null = null
  private externalEventReconcileTimer: ReturnType<typeof setInterval> | null = null
  private externalEventReconcileRunning = false
  private readonly constructedAtMs = Date.now()
  private readonly mailboxServerFactory: () => Promise<MailboxHttpServerHandle>
  private readonly privateRuntimePolicyDeps: PrivateTurnPolicyDeps
  private readonly onStopCommandComplete: (() => void | Promise<void>) | null
  private readonly externalEventRoot: string | null
  private readonly privilegedEventSpoolRoot: string
  private readonly privilegedEventScanner: typeof scanPrivilegedEventSpool
  private readonly rsvpHabitRunner?: (input: RunNativeRsvpHabitInput) => Promise<RunNativeRsvpHabitResult>
  private readonly nativeHabitRunner?: OuroDaemonOptions["nativeHabitRunner"]
  private readonly nativeHabitMatch?: OuroDaemonOptions["nativeHabitMatch"]
  private readonly nativeHabitClaims = new Set<string>()
  private readonly authenticatedSchedulerPokes = new WeakMap<object, SanctuarySchedulerOrigin>()
  private readonly schedulerFireVerifier?: OuroDaemonOptions["schedulerFireVerifier"]
  private readonly schedulerFireConsumer?: OuroDaemonOptions["schedulerFireConsumer"]
  private readonly orphanStartupDrain: (socketPath: string) => Promise<void>

  constructor(options: OuroDaemonOptions) {
    this.socketPath = options.socketPath
    this.processManager = options.processManager
    this.scheduler = options.scheduler
    this.healthMonitor = options.healthMonitor
    this.router = options.router
    this.senseManager = options.senseManager ?? null
    this.bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
    this.mode = options.mode ?? "production"
    this.mailboxServerFactory = options.mailboxServerFactory ?? this.createDefaultMailboxServer.bind(this)
    this.privateRuntimePolicyDeps = options.privateRuntimePolicyDeps ?? {}
    this.onStopCommandComplete = options.onStopCommandComplete ?? null
    this.externalEventRoot = options.externalEventRoot ?? null
    this.privilegedEventSpoolRoot = options.privilegedEventSpoolRoot ?? "/run/ouro-events"
    this.privilegedEventScanner = options.privilegedEventScanner ?? scanPrivilegedEventSpool
    this.rsvpHabitRunner = options.rsvpHabitRunner
    this.nativeHabitRunner = options.nativeHabitRunner
    this.nativeHabitMatch = options.nativeHabitMatch
    this.schedulerFireVerifier = options.schedulerFireVerifier
    this.schedulerFireConsumer = options.schedulerFireConsumer
    this.orphanStartupDrain = options.orphanStartupDrain ?? drainOrphanProcessesBeforeStartup
  }

  /* v8 ignore start -- default mailbox server wiring: production-only path, tests inject mailboxServerFactory stub instead. startMailboxHttpServer itself has full coverage in mailbox-http.test.ts @preserve */
  private createDefaultMailboxServer(): Promise<MailboxHttpServerHandle> {
    return startMailboxHttpServer({
      host: "127.0.0.1",
      port: MAILBOX_DEFAULT_PORT,
      bundlesRoot: this.bundlesRoot,
      readMachineState: () => readMailboxMachineState({ bundlesRoot: this.bundlesRoot }),
      readMachineView: ({ machine }) => {
        const overview = this.buildStatusPayload().overview
        return buildMailboxMachineView({
          machine,
          daemon: {
            status: overview.daemon,
            health: overview.health,
            mode: overview.mode,
            socketPath: overview.socketPath,
            mailboxUrl: overview.mailboxUrl,
            entryPath: overview.entryPath,
            workerCount: overview.workerCount,
            senseCount: overview.senseCount,
          },
        })
      },
      readAgentState: (agentName) => readMailboxAgentState(agentName, { bundlesRoot: this.bundlesRoot }),
      readAgentView: (agentName) => {
        const agent = readMailboxAgentState(agentName, { bundlesRoot: this.bundlesRoot })
        return buildMailboxAgentView({
          agent,
          viewer: { kind: "human" },
        })
      },
    })
  }
  /* v8 ignore stop */

  private buildStatusPayload(): DaemonStatusPayload {
    const snapshots = this.processManager.listAgentSnapshots()
    const workers = buildWorkerRows(snapshots)
    const senses = this.senseManager?.listSenseRows() ?? []
    const healthChecks = this.overlaySchedulerHealth(this.healthMonitor.getLastResults?.() ?? [])
    const repoRoot = getRepoRoot()
    const sync = listBundleSyncRows({ bundlesRoot: this.bundlesRoot })
    const agents = listAllBundleAgents({ bundlesRoot: this.bundlesRoot })
    const providerAgents = listEnabledBundleAgents({ bundlesRoot: this.bundlesRoot })
    const providers = providerAgents.flatMap((agentName) =>
      providerVisibilityStatusRows(buildAgentProviderVisibility({
        agentName,
        agentRoot: path.join(this.bundlesRoot, `${agentName}.ouro`),
      })),
    )
    const externalEvents = listExternalEventStatus(this.externalEventRoot ?? getExternalEventRoot())

    const mailboxUrl = this.mailboxServer?.origin ?? "http://127.0.0.1:0"
    return {
      overview: {
        daemon: "running",
        health: overviewHealth(workers, senses, healthChecks),
        socketPath: this.socketPath,
        mailboxUrl,
        outlookUrl: mailboxUrl,
        ...getRuntimeMetadata(),
        workerCount: workers.length,
        senseCount: senses.length,
        entryPath: path.join(repoRoot, "dist", "heart", "daemon", "daemon-entry.js"),
        mode: detectRuntimeMode(repoRoot),
      },
      workers,
      senses,
      ...(healthChecks.length > 0 ? { healthChecks } : {}),
      sync,
      agents,
      ...(providers.length > 0 ? { providers } : {}),
      ...(externalEvents.length > 0 ? { externalEvents } : {}),
    }
  }

  private overlaySchedulerHealth(healthChecks: DaemonHealthResult[]): DaemonHealthResult[] {
    const degradedJobs = this.scheduler.listDegradedJobs?.() ?? []
    if (degradedJobs.length === 0) return healthChecks

    const cronHealth: DaemonHealthResult = {
      name: "cron-health",
      status: "warn",
      message: `cron jobs degraded; timer fallback active: ${degradedJobs
        .map((job) => `${job.id} (${job.reason})`)
        .join(", ")}`,
    }
    const next = healthChecks.map((check) => ({ ...check }))
    const existingIndex = next.findIndex((check) => check.name === "cron-health")
    if (existingIndex === -1) {
      next.push(cronHealth)
    } else {
      next[existingIndex] = cronHealth
    }
    return next
  }

  async start(): Promise<void> {
    if (this.server) return

    emitNervesEvent({
      component: "daemon",
      event: "daemon.server_start",
      message: "starting daemon server",
      meta: { socketPath: this.socketPath },
    })

    try {
      await this.startInner()
    } catch (err) {
      // Emit a paired terminating event (`_error`) so the nerves audit's
      // start_end_pairing rule is satisfied when startup throws mid-sequence
      // and `stop()` (which emits `server_end`) is never called.
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.server_error",
        message: "daemon start failed",
        meta: {
          error: err instanceof Error ? err.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(err),
        },
      })
      throw err
    }
  }

  private async startInner(): Promise<void> {
    const containerPolicy = readContainerRuntimePolicy()
    // Register update hooks and apply pending updates before starting agents
    registerUpdateHook(bundleMetaHook)
    registerUpdateHook(agentConfigV2Hook)
    const currentVersion = getPackageVersion()
    if (containerPolicy?.updates !== "disabled") await applyPendingUpdates(this.bundlesRoot, currentVersion)

    // Start periodic update checker (polls npm registry every 30 minutes)
    // Skip in dev mode — dev builds should not auto-update from npm
    if (this.mode === "dev" || containerPolicy?.updates === "disabled") {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.update_checker_skip",
        message: "skipping update checker in dev mode",
        meta: { reason: this.mode === "dev" ? "dev mode" : "container policy" },
      })
    } else {
      startUpdateChecker({
        currentVersion,
        deps: {
          distTag: CLI_UPDATE_DIST_TAG,
          /* v8 ignore start -- integration: real HTTP fetch @preserve */
          fetchRegistryJson: async () => {
            const res = await fetch("https://registry.npmjs.org/@ouro.bot/cli")
            return res.json()
          },
          /* v8 ignore stop */
        },
      })
    }

    // MCP connections are lazily initialized per-agent during senseTurn
    // (daemon manages multiple agents; agent identity must be set before loading MCP config)

    await this.orphanStartupDrain(this.socketPath)
    await this.openCommandSocket()
    await this.reconcileExternalEvents()
    this.externalEventReconcileTimer = setInterval(() => {
      void this.reconcileExternalEvents()
    }, 1_000)
    this.externalEventReconcileTimer.unref?.()
    this.triggerAutoStartAgents()
    this.triggerAutoStartSensesWhenAgentsSettled()

    // Write all managed PIDs to disk so the next daemon can clean up
    /* v8 ignore start -- pidfile write: collects PIDs from process managers @preserve */
    const agentPids = this.processManager.listAgentSnapshots().map((s) => s.pid).filter((p): p is number => p !== null)
    const sensePids = this.senseManager?.listManagedPids?.() ?? []
    writePidfile([...agentPids, ...sensePids], this.socketPath)
    /* v8 ignore stop */

    this.scheduler.start?.()
    await this.scheduler.reconcile?.()
    await this.drainPendingBundleMessages()
    await this.drainPendingSenseMessages()
    // startInner is only reachable when this.server is null (guarded in
    // start()), and stop() nulls out this.mailboxServer alongside this.server,
    // so mailboxServer is guaranteed unset here — no need for a guard.
    try {
      this.mailboxServer = await this.mailboxServerFactory()
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.mailbox_start_failed",
        message: `Mailbox server failed to start: ${String(error)}`,
        meta: { port: MAILBOX_DEFAULT_PORT },
      })
    }
  }

  private triggerAutoStartAgents(): void {
    if (this.processManager.triggerAutoStartAgents) {
      this.processManager.triggerAutoStartAgents()
      return
    }
    void this.processManager.startAutoStartAgents().catch((error) => {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.agent_autostart_error",
        message: "agent autostart failed after daemon socket opened",
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  private triggerAutoStartSenses(): void {
    /* v8 ignore next -- defensive: callers already check senseManager before delegating here @preserve */
    if (!this.senseManager) return
    if (this.senseManager.triggerAutoStartSenses) {
      this.senseManager.triggerAutoStartSenses()
      return
    }
    void this.senseManager.startAutoStartSenses().catch((error) => {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.sense_autostart_error",
        message: "sense autostart failed after daemon socket opened",
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  private triggerAutoStartSensesWhenAgentsSettled(): void {
    if (!this.senseManager) return
    const waitingOnAgents = this.processManager.listAgentSnapshots()
      .some((snapshot) => snapshot.status === "starting")
    if (!waitingOnAgents) {
      this.triggerAutoStartSenses()
      return
    }
    this.senseAutostartTimer = setTimeout(() => {
      this.senseAutostartTimer = null
      this.triggerAutoStartSensesWhenAgentsSettled()
    }, 250)
  }

  private async openCommandSocket(): Promise<void> {
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath)
    }

    // allowHalfOpen: true lets the server keep its writable side open after
    // the client sends FIN. Without this, when a client calls `client.end()`
    // after writing a command, node closes the server's writable side
    // automatically — so a long-running response (like an agent.senseTurn
    // LLM turn that takes 5+ seconds) never reaches the client. The
    // socket-client fix in #303/#334 also removed client.end() on the
    // sending side, but this option is defense in depth: even if a future
    // caller half-closes, the server still writes its response correctly.
    this.server = net.createServer({ allowHalfOpen: true }, (connection) => {
      let raw = ""
      let responded = false

      /* v8 ignore start — connection error handler requires real socket error @preserve */
      connection.on("error", (err) => {
        emitNervesEvent({
          level: "warn",
          component: "daemon",
          event: "daemon.connection_error",
          message: "socket connection error",
          meta: { error: err.message, code: (err as NodeJS.ErrnoException).code ?? null },
        })
      })
      /* v8 ignore stop */

      const flushResponse = async () => {
        if (responded) return
        responded = true
        const response = await this.handleRawPayload(raw)
        try {
          connection.end(response)
        /* v8 ignore start — EPIPE catch requires real socket disconnect @preserve */
        } catch (err) {
          emitNervesEvent({
            level: "warn",
            component: "daemon",
            event: "daemon.connection_end_error",
            message: "failed to send response to client (EPIPE)",
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        }
        /* v8 ignore stop */
      }

      connection.on("data", (chunk) => {
        raw += chunk.toString("utf-8")
        void flushResponse()
      })
      connection.on("end", () => {
        void flushResponse()
      })
    })

    const server = this.server
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(this.socketPath, () => {
        // Replace the one-time error listener with a persistent one after successful listen
        server.removeAllListeners("error")
        this.socketIdentity = readSocketIdentity(this.socketPath)
        /* v8 ignore start — server error after listen requires real socket race condition @preserve */
        server.on("error", (err) => {
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.server_error",
            message: "daemon server error after listen",
            meta: { error: err.message, code: (err as NodeJS.ErrnoException).code ?? null },
          })
        })
        /* v8 ignore stop */
        resolve()
      })
    })
  }

  private async drainPendingBundleMessages(): Promise<void> {
    if (!fs.existsSync(this.bundlesRoot)) return

    let bundleDirs: fs.Dirent[]
    try {
      bundleDirs = fs.readdirSync(this.bundlesRoot, { withFileTypes: true })
    } catch {
      return
    }

    for (const bundleDir of bundleDirs) {
      if (!bundleDir.isDirectory() || !bundleDir.name.endsWith(".ouro")) continue
      const pendingPath = path.join(this.bundlesRoot, bundleDir.name, "inbox", "pending.jsonl")
      if (!fs.existsSync(pendingPath)) continue

      const raw = fs.readFileSync(pendingPath, "utf-8")
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

      const retained: string[] = []
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            from?: unknown
            to?: unknown
            content?: unknown
            priority?: unknown
            sessionId?: unknown
            taskRef?: unknown
          }
          if (
            typeof parsed.from !== "string" ||
            typeof parsed.to !== "string" ||
            typeof parsed.content !== "string"
          ) {
            retained.push(line)
            continue
          }
          await this.router.send({
            from: parsed.from,
            to: parsed.to,
            content: parsed.content,
            priority: typeof parsed.priority === "string" ? parsed.priority : undefined,
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
            taskRef: typeof parsed.taskRef === "string" ? parsed.taskRef : undefined,
          })
        } catch {
          retained.push(line)
        }
      }

      const next = retained.length > 0 ? `${retained.join("\n")}\n` : ""
      fs.writeFileSync(pendingPath, next, "utf-8")
    }
  }

  /** Drains per-sense pending dirs for always-on senses across all agents. */
  private static readonly ALWAYS_ON_SENSES = new Set(getAlwaysOnSenseNames())

  private async drainPendingSenseMessages(): Promise<void> {
    if (!fs.existsSync(this.bundlesRoot)) return

    let bundleDirs: fs.Dirent[]
    try {
      bundleDirs = fs.readdirSync(this.bundlesRoot, { withFileTypes: true })
    } catch {
      return
    }

    for (const bundleDir of bundleDirs) {
      if (!bundleDir.isDirectory() || !bundleDir.name.endsWith(".ouro")) continue

      const agentName = bundleDir.name.replace(/\.ouro$/, "")
      const pendingRoot = path.join(this.bundlesRoot, bundleDir.name, "state", "pending")
      if (!fs.existsSync(pendingRoot)) continue

      let friendDirs: fs.Dirent[]
      try {
        friendDirs = fs.readdirSync(pendingRoot, { withFileTypes: true })
      } catch {
        continue
      }

      for (const friendDir of friendDirs) {
        if (!friendDir.isDirectory()) continue
        const friendPath = path.join(pendingRoot, friendDir.name)

        let channelDirs: fs.Dirent[]
        try {
          channelDirs = fs.readdirSync(friendPath, { withFileTypes: true })
        } catch {
          continue
        }

        for (const channelDir of channelDirs) {
          if (!channelDir.isDirectory()) continue
          if (!OuroDaemon.ALWAYS_ON_SENSES.has(channelDir.name)) continue

          const channelPath = path.join(friendPath, channelDir.name)

          let keyDirs: fs.Dirent[]
          try {
            keyDirs = fs.readdirSync(channelPath, { withFileTypes: true })
          } catch {
            continue
          }

          for (const keyDir of keyDirs) {
            if (!keyDir.isDirectory()) continue
            const leafDir = path.join(channelPath, keyDir.name)
            const messages = drainPending(leafDir)

            for (const msg of messages) {
              try {
                await this.router.send({
                  from: msg.from,
                  to: agentName,
                  content: msg.content,
                  priority: "normal",
                })
              } catch {
                // Best-effort delivery — log and continue
              }
            }

            if (messages.length > 0) {
              emitNervesEvent({
                component: "daemon",
                event: "daemon.startup_sense_drain",
                message: "drained pending sense messages on startup",
                meta: {
                  agent: agentName,
                  channel: channelDir.name,
                  friendId: friendDir.name,
                  key: keyDir.name,
                  count: messages.length,
                },
              })
            }
          }
        }
      }
    }
  }

  async stop(): Promise<void> {
    // Must be named `_end` (not `_stop`) to satisfy the nerves audit's
    // start/end pairing rule — see src/nerves/coverage/audit-rules.ts.
    // This is the counterpart to `daemon.server_start` emitted at line 480.
    emitNervesEvent({
      component: "daemon",
      event: "daemon.server_end",
      message: "stopping daemon server",
      meta: { socketPath: this.socketPath },
    })

    stopUpdateChecker()
    shutdownSharedMcpManager()
    this.scheduler.stop?.()
    this.healthMonitor.stopPeriodicChecks?.()
    if (this.senseAutostartTimer) {
      clearTimeout(this.senseAutostartTimer)
      this.senseAutostartTimer = null
    }
    if (this.externalEventReconcileTimer) {
      clearInterval(this.externalEventReconcileTimer)
      this.externalEventReconcileTimer = null
    }
    const workerStopTasks = [Promise.resolve().then(() => this.processManager.stopAll())]
    if (this.senseManager) {
      workerStopTasks.push(Promise.resolve().then(() => this.senseManager!.stopAll()))
    }
    const workerStopResults = await Promise.allSettled(workerStopTasks)
    const workerStopFailures = workerStopResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    )

    if (this.server) {
      // DO NOT `await` server.close() here. server.close() resolves only
      // after every open connection has closed. When stop() is invoked
      // from the daemon.stop command handler, the calling client's
      // connection is STILL open — its flushResponse() is currently
      // awaiting THIS function. Awaiting close() creates a deadlock:
      //
      //   client → flushResponse → handleRawPayload → daemon.stop case
      //   → stop() → await server.close() (waits for client's connection)
      //   → client's connection waits for flushResponse to call
      //     connection.end() → DEADLOCK
      //
      // Both processes sit in kevent forever. Verified live on
      // 2026-04-08: alpha.268 daemon hung at `daemon.server_end` log
      // line for 5+ minutes after a client sent daemon.stop, while the
      // client (alpha.270 ouro up) hung waiting for the response.
      //
      // This regressed when #303/#334/#339 stopped half-closing the
      // client socket and switched the server to allowHalfOpen: true.
      // Previously, the client called .end() after writing its command,
      // which (with allowHalfOpen: false) caused node to auto-tear-down
      // the server's writable side — incidentally unblocking
      // server.close() before the response was sent. The half-close
      // breakage masked this deadlock; the fix exposed it.
      //
      // Solution: fire close() and let it complete asynchronously. Once
      // stop() returns, the daemon.stop case returns its response,
      // flushResponse() calls connection.end(response), the connection
      // closes, and server.close()'s pending callback fires. The event
      // loop drains and the daemon exits cleanly.
      this.server.close()
      this.server = null
    }
    if (this.mailboxServer) {
      await this.mailboxServer.stop()
      this.mailboxServer = null
    }

    const socketPathExists = fs.existsSync(this.socketPath)
    const currentSocketIdentity = socketPathExists ? readSocketIdentity(this.socketPath) : null
    if (sameSocketIdentity(this.socketIdentity, currentSocketIdentity)) {
      fs.unlinkSync(this.socketPath)
    } else if (socketPathExists) {
      const expectedSocketIdentity = { dev: null, ino: null, ctimeMs: null, ...this.socketIdentity }
      const actualSocketIdentity = { dev: null, ino: null, ctimeMs: null, ...currentSocketIdentity }
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.socket_cleanup_skipped",
        message: "skipped daemon socket cleanup because the socket path no longer belongs to this daemon",
        meta: {
          socketPath: this.socketPath,
          expectedDev: expectedSocketIdentity.dev,
          expectedIno: expectedSocketIdentity.ino,
          expectedCtimeMs: expectedSocketIdentity.ctimeMs,
          actualDev: actualSocketIdentity.dev,
          actualIno: actualSocketIdentity.ino,
          actualCtimeMs: actualSocketIdentity.ctimeMs,
        },
      })
    }
    this.socketIdentity = null

    if (workerStopFailures.length > 0) {
      const errorReason = `daemon shutdown could not drain ${workerStopFailures.length} managed worker group(s)`
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.worker_shutdown_error",
        message: errorReason,
        meta: {
          failures: workerStopFailures.map((error) =>
            error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error rejection @preserve */ String(error),
          ),
        },
      })
      throw new AggregateError(workerStopFailures, errorReason)
    }
  }

  async handleRawPayload(raw: string): Promise<string> {
    try {
      const command = parseIncomingCommand(raw)
      const response = await this.handleCommand(command)
      return JSON.stringify(response)
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies DaemonResponse)
    }
  }

  async handleCommand(command: DaemonCommand): Promise<DaemonResponse> {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.command_received",
      message: "handling daemon command",
      meta: { kind: command.kind },
    })

    try {
      return await this.handleCommandInner(command)
    /* v8 ignore start — command error catch tested in daemon-command-error.test; instanceof branches defensive @preserve */
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.command_error",
        message: "unexpected error handling daemon command",
        meta: {
          kind: command.kind,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack ?? null : null,
        },
      })
      throw error
    }
    /* v8 ignore stop */
  }

  private hasManagedPrivateRuntime(agent: string): boolean {
    return this.processManager.listAgentSnapshots().some((snapshot) =>
      snapshot.name === agent && snapshot.channel === "private-runtime",
    )
  }

  private buildPrivateRuntimeWakeRequest(
    command: Extract<DaemonCommand, { kind: "private.wake" | "inner.wake" }>,
  ): PrivateTurnRequest {
    if (command.kind === "inner.wake") {
      return {
        agent: command.agent,
        origin: "daemon.private.wake",
        reason: "legacy inner.wake compatibility alias",
        providerLane: "inner",
        triggerSource: "legacy",
        budgetClass: "interactive",
        originRefs: [{ kind: "daemon-command", id: "inner.wake" }],
      }
    }

    const hasNoSendCapability = command.originRefs?.some(
      (ref) => ref.kind === "capability" && ref.id === "no-send",
    ) ?? false
    if ((command.noSend === true) !== hasNoSendCapability) {
      throw new Error("private-runtime no-send capability does not match its bound origin reference")
    }

    return {
      agent: command.agent,
      origin: "daemon.private.wake",
      reason: command.reason ?? "manual private-runtime wake",
      providerLane: "inner",
      triggerSource: command.triggerSource ?? "manual",
      budgetClass: command.budgetClass ?? "interactive",
      ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
      originRefs: command.originRefs ?? [{ kind: "daemon-command", id: "private.wake" }],
    }
  }

  private buildAwaitPrivateWakeCommand(command: Extract<DaemonCommand, { kind: "await.poke" }>): Extract<DaemonCommand, { kind: "private.wake" }> {
    return buildAwaitPrivateWakeCommand({
      agent: command.agent,
      awaitName: command.awaitName,
      triggerSource: "await-poke",
    })
  }

  private buildTaskPokePrivateWakeCommand(
    command: Extract<DaemonCommand, { kind: "task.poke" }>,
    receiptId: string,
  ): Extract<DaemonCommand, { kind: "private.wake" }> {
    return {
      kind: "private.wake",
      agent: command.agent,
      reason: `task poke ${command.taskId}`,
      triggerSource: "task-poke",
      budgetClass: "scheduled",
      idempotencyKey: `task-poke:${command.agent}:${command.taskId}:${receiptId}`,
      originRefs: [
        { kind: "task", id: command.taskId },
        { kind: "queue-receipt", id: receiptId },
        { kind: "daemon-command", id: "task.poke" },
      ],
    }
  }

  private buildExternalEventPrivateWakeCommand(
    command: Extract<DaemonCommand, { kind: "external.event.submit" }>,
    receiptId: string,
    generation: number,
    attemptCount: number,
  ): Extract<DaemonCommand, { kind: "private.wake" }> {
    return {
      kind: "private.wake",
      agent: command.agent,
      reason: `external event ${command.source}/${command.eventType}`,
      triggerSource: "external-event",
      budgetClass: "interactive",
      idempotencyKey: `external-event:${command.agent}:${command.source}:${command.eventId}:generation:${generation}:attempt:${attemptCount}`,
      originRefs: [
        { kind: "external-event", id: command.eventId, source: command.source, eventType: command.eventType },
        { kind: "queue-receipt", id: receiptId },
        { kind: "daemon-command", id: "external.event.submit" },
      ],
    }
  }

  private resolveHabitDispatch(options: {
    agent: string
    habitName: string
    trigger: HabitRunTrigger
    source: "habit-poke" | "habit-probe" | "private-wake"
    occurrenceId?: string
  }): HabitDispatchResolution {
    const agentRoot = path.join(this.bundlesRoot, `${options.agent}.ouro`)
    const habitPath = path.join(agentRoot, "habits", `${options.habitName}.md`)
    const isRsvp = isRsvpHabitName(options.habitName)
    let readFailure: "missing" | "read" | null = null
    let habit: HabitFile

    if (!fs.existsSync(habitPath)) {
      readFailure = "missing"
      habit = createDegradedHabitFile(habitPath, "read_error", "", "habit file not found")
    } else {
      try {
        habit = applyHabitRuntimeState(agentRoot, parseHabitFile(fs.readFileSync(habitPath, "utf-8"), habitPath))
      } catch (error) {
        readFailure = "read"
        habit = createDegradedHabitFile(habitPath, "read_error", "", messageFromHabitPokeError(error))
      }
    }

    if (habit.status !== "active") {
      let skipReason = `habit status ${habit.status} is non-executable`
      if (isRsvp && habit.status === "degraded") {
        if (readFailure === "missing") {
          skipReason = "RSVP habit file not found"
        } else {
          skipReason = `RSVP habit metadata invalid: ${habit.degradedDetail ?? habit.degradedReason}`
        }
      } else if (
        readFailure === "missing"
        && options.source === "habit-poke"
        && options.trigger !== "manual"
        && options.trigger !== "poke"
      ) {
        skipReason = "habit file not found"
      }
      return { kind: "skipped", habit, skipReason }
    }

    if (isRsvp && !habit.rsvp) {
      return {
        kind: "skipped",
        habit,
        skipReason: "RSVP habit metadata is required before private runtime wake",
      }
    }

    if (options.trigger === "poke" || options.trigger === "manual") {
      return { kind: "ready", habit }
    }
    if (typeof options.occurrenceId === "string" && options.occurrenceId.trim().length > 0) {
      return { kind: "ready", habit, occurrenceId: options.occurrenceId.trim() }
    }
    if (habit.cadence === null) {
      return { kind: "skipped", habit, skipReason: "habit has no cadence" }
    }
    if (habit.lastRun === null) {
      return { kind: "ready", habit, occurrenceId: `${options.trigger}:first-run:${habit.cadence}` }
    }
    return {
      kind: "ready",
      habit,
      occurrenceId: `${options.trigger}:last-run:${habit.lastRun}:cadence:${habit.cadence}`,
    }
  }

  private emitHabitDispatchSkipped(options: {
    agent: string
    habitName: string
    trigger: HabitRunTrigger
    resolution: Extract<HabitDispatchResolution, { kind: "skipped" }>
  }): void {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.habit_dispatch_skipped",
      message: "habit dispatch rejected by current lifecycle state",
      meta: {
        agent: options.agent,
        habitName: options.habitName,
        trigger: options.trigger,
        status: options.resolution.habit.status,
        degradedReason: options.resolution.habit.status === "degraded"
          ? options.resolution.habit.degradedReason
          : null,
        detail: options.resolution.habit.status === "degraded"
          ? options.resolution.habit.degradedDetail
          : null,
        reason: options.resolution.skipReason,
      },
    })
  }

  private emitHabitDispatchReady(options: {
    agent: string
    habitName: string
    trigger: HabitRunTrigger
    resolution: Extract<HabitDispatchResolution, { kind: "ready" }>
  }): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.habit_dispatch_ready",
      message: "habit dispatch accepted by current lifecycle state",
      meta: {
        agent: options.agent,
        habitName: options.habitName,
        trigger: options.trigger,
        status: options.resolution.habit.status,
        occurrenceId: options.resolution.occurrenceId ?? null,
      },
    })
  }

  private skippedHabitDispatchResponse(options: {
    agent: string
    habitName: string
    skipReason: string
  }): DaemonResponse {
    return {
      ok: true,
      message: `skipped scheduled habit ${options.habitName} for ${options.agent}: ${options.skipReason}`,
    }
  }

  private async runNativeRsvpHabit(
    command: Pick<Extract<DaemonCommand, { kind: "habit.poke" | "habit.probe" }>, "agent" | "habitName">,
    trigger: HabitRunTrigger,
    occurrenceId?: string,
    noSend = false,
  ): Promise<DaemonResponse> {
    const runner = this.rsvpHabitRunner ?? (async (input: RunNativeRsvpHabitInput): Promise<RunNativeRsvpHabitResult> => {
      const { runNativeRsvpHabit } = await import("../../rsvp/native-habit-runner")
      return runNativeRsvpHabit(input)
    })
    const result = await runner({
      agent: command.agent,
      bundlesRoot: this.bundlesRoot,
      habitName: command.habitName,
      trigger,
      ...(occurrenceId ? { occurrenceId } : {}),
      ...(noSend ? { noSend: true } : {}),
    })
    if (noSend) {
      const payload = result.payload
      const status = payload?.status
      const transportInvocationCount = payload?.transportInvocationCount
      const contractError = "native RSVP habit probe violated the immutable no-send result contract"
      if (!result.ok) {
        return {
          ok: false,
          error: result.message,
          data: {
            ok: false,
            noSend: true,
            status: typeof status === "string" ? status : "degraded",
            transportInvocationCount: null,
            error: result.message,
          },
        }
      }
      if (
        payload?.noSend !== true
        || typeof status !== "string"
        || typeof transportInvocationCount !== "number"
        || transportInvocationCount !== 0
      ) {
        return {
          ok: false,
          error: contractError,
          data: {
            ok: false,
            noSend: true,
            status: typeof status === "string" ? status : "degraded",
            transportInvocationCount: null,
            error: contractError,
          },
        }
      }
      return {
        ok: true,
        message: result.message,
        data: { noSend: true, status, transportInvocationCount: 0 },
      }
    }
    return {
      ok: result.ok,
      message: result.message,
      data: result,
    }
  }

  private buildPrivateRuntimeWorkerWakeMessage(
    command: Extract<DaemonCommand, { kind: "private.wake" | "inner.wake" }>,
    decision: PrivateTurnDecision,
    externalEvent?: ExternalEventLeaseContext,
  ): Record<string, unknown> {
    const awaitName = awaitNameFromPrivateWakeCommand(command)
    if (awaitName) {
      return {
        type: "await",
        awaitName,
        privateTurnDecision: decision,
      }
    }
    const taskId = taskIdFromTaskPokePrivateWakeCommand(command)
    if (taskId) {
      return {
        type: "poke",
        taskId,
        privateTurnDecision: decision,
      }
    }
    const habitMessage = habitMessageFromPrivateWakeCommand(command)
    if (habitMessage) {
      return {
        type: "habit",
        habitName: habitMessage.habitName,
        trigger: habitMessage.trigger,
        ...(habitMessage.noSend ? { noSend: true } : {}),
        privateTurnDecision: decision,
      }
    }
    return { type: "message", privateTurnDecision: decision, ...(externalEvent ? { externalEvent } : {}) }
  }

  private queueExternalEventForPrivateRuntime(record: ExternalEventRecord, quiet = false): void {
    const pendingDir = path.join(
      this.bundlesRoot,
      `${record.agent}.ouro`,
      "state",
      "pending",
      PRIVATE_RUNTIME_PENDING.friendId,
      PRIVATE_RUNTIME_PENDING.channel,
      PRIVATE_RUNTIME_PENDING.key,
    )
    const originKey = `${record.source}:${record.eventId}`
    const parsedReceivedAt = Date.parse(record.receivedAt)
    queuePendingMessageOnce(pendingDir, {
      from: "ouro-external-event",
      friendId: "ouro-external-event",
      channel: "external-event",
      key: originKey,
      content: buildExternalEventMessage(record),
      timestamp: Number.isFinite(parsedReceivedAt) ? parsedReceivedAt : Date.now(),
      delegatedFrom: {
        friendId: "ouro-external-event",
        channel: "external-event",
        key: originKey,
      },
      obligationStatus: "pending",
      mode: "relay",
      packetId: `external-event:${record.agent}:${record.source}:${record.eventId}:generation:${record.generation}:attempt:${record.attemptCount}`,
    })
    if (!quiet) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.external_event_private_runtime_queued",
        message: "queued external event for private-runtime attention",
        meta: {
          agent: record.agent,
          source: record.source,
          eventType: record.eventType,
          eventId: record.eventId,
          pendingDir,
        },
      })
    }
  }

  private externalEventRootPath(): string {
    return this.externalEventRoot ?? getExternalEventRoot()
  }

  private externalEventLease(record: ExternalEventRecord): ExternalEventLeaseMember {
    /* v8 ignore next -- dispatcher calls this only with the record returned by claimExternalEvent @preserve */
    if (!record.claimOwner) throw new Error("External event dispatch requires a claimed receipt")
    return {
      schemaVersion: 1,
      recordPath: record.recordPath,
      agent: record.agent,
      source: record.source,
      eventId: record.eventId,
      generation: record.generation,
      observationRevision: record.observationRevision,
      claimOwner: record.claimOwner,
    }
  }

  private async dispatchExternalEvents(records: ExternalEventRecord[]): Promise<{ events: ExternalEventRecord[]; event: ExternalEventRecord; receipt: { id: string; queuedAt: string }; wake: DaemonResponse }> {
    const claimed: ExternalEventRecord[] = []
    let failureClass: ExternalEventFailureClass | undefined
    try {
      for (const record of records) {
        const owner = `external-event:${record.agent}:${record.source}:${record.eventId}:generation:${record.generation}:attempt:${record.attemptCount + 1}`
        claimed.push(claimExternalEvent(record.recordPath, { owner, expectedVersion: record.version, expectedGeneration: record.generation }))
      }
      const primary = claimed[0]!
      const [primaryLease, ...relatedEvents] = claimed.map((record) => this.externalEventLease(record))
      const lease: ExternalEventLeaseContext = { ...primaryLease!, ...(relatedEvents.length > 0 ? { relatedEvents } : {}) }
      const receipt = {
        id: `external-event:${primary.agent}:${primary.source}:${primary.eventId}:generation:${primary.generation}:attempt:${primary.attemptCount}`,
        queuedAt: primary.updatedAt,
      }
      const wake = await this.handlePrivateRuntimeWake(
        this.buildExternalEventPrivateWakeCommand({
          kind: "external.event.submit",
          agent: primary.agent,
          source: primary.source,
          eventType: primary.eventType,
          eventId: primary.eventId,
        }, receipt.id, primary.generation, primary.attemptCount),
        () => {
          const batched = claimed.length > 1
          for (const record of claimed) this.queueExternalEventForPrivateRuntime(record, batched)
          if (batched) {
            emitNervesEvent({
              component: "daemon",
              event: "daemon.external_event_private_runtime_batch_queued",
              message: "queued an external-event batch for private-runtime attention",
              meta: { agent: primary.agent, source: primary.source, eventCount: claimed.length },
            })
          }
        },
        lease,
      )
      failureClass = wake.denialCode === "managed_runtime_unavailable"
        ? "managed_runtime_unavailable"
        : (wake.data as { decision?: { denialCode?: string } } | undefined)?.decision?.denialCode === "provider_lane_unavailable"
          ? "provider_lane_unavailable"
          : undefined
      const denied = !wake.ok || (wake.data as { decision?: { executable?: boolean } } | undefined)?.decision?.executable === false
      if (denied) throw new Error(wake.error ?? wake.message ?? /* v8 ignore next -- daemon wake responses always carry an error or message @preserve */ "external-event private turn was denied")
      return { events: claimed, event: primary, receipt, wake }
    } catch (error) {
      for (const record of claimed) {
        const latest = readExternalEventRecord(record.recordPath)
        if (latest.executionState === "running" && latest.claimOwner === record.claimOwner) {
          failExternalEventAttempt(latest.recordPath, {
            owner: record.claimOwner!, expectedVersion: latest.version, expectedGeneration: latest.generation,
            error: error instanceof Error ? error.message : String(error),
            ...(failureClass ? { failureClass } : {}),
          })
        }
      }
      throw error
    }
  }

  private dispatchExternalEvent(record: ExternalEventRecord): Promise<{ events: ExternalEventRecord[]; event: ExternalEventRecord; receipt: { id: string; queuedAt: string }; wake: DaemonResponse }> {
    return this.dispatchExternalEvents([record])
  }

  private async reconcileExternalEvents(): Promise<void> {
    /* v8 ignore next -- re-entrancy guard is exercised only by overlapping real timer callbacks @preserve */
    if (this.externalEventReconcileRunning) return
    this.externalEventReconcileRunning = true
    try {
      const now = new Date().toISOString()
      if (fs.existsSync(this.privilegedEventSpoolRoot)) {
        this.privilegedEventScanner({ spoolRoot: this.privilegedEventSpoolRoot, eventRoot: this.externalEventRootPath() })
      }
      const statuses = listExternalEventStatus(this.externalEventRootPath())
      const dueRecords: ExternalEventRecord[] = []
      const providerEvidenceByAgent = new Map<string, { observedAt: string } | null>()
      const runtimeEvidenceByAgent = new Map<string, { observedAt: string } | null>()
      const recoveredByClass = new Map<ExternalEventFailureClass, number>()
      for (const status of statuses) {
        if (status.corrupt) continue
        let record = readExternalEventRecord(status.recordPath)
        if (record.dispatchEnabled === false) continue
        if (record.executionState === "dead_letter") {
          const failure = externalEventRecoveryFailure(record)
          if (!failure || record.recoveryGrant?.generation === record.generation) continue
          let evidence: { class: ExternalEventFailureClass; observedAt: string } | null = null
          try {
            if (failure.class === "provider_lane_unavailable") {
              if (!providerEvidenceByAgent.has(record.agent)) {
                providerEvidenceByAgent.set(record.agent, null)
                const binding = resolveEffectiveProviderBinding({
                  agentName: record.agent,
                  agentRoot: path.join(this.bundlesRoot, `${record.agent}.ouro`),
                  lane: "inner",
                })
                providerEvidenceByAgent.set(record.agent, binding.ok && binding.binding.credential.status === "present"
                  && binding.binding.readiness.status === "ready" && binding.binding.readiness.checkedAt
                  ? { observedAt: binding.binding.readiness.checkedAt }
                  : null)
              }
              const current = providerEvidenceByAgent.get(record.agent)
              const readinessIsCurrentBoot = current && Date.parse(current.observedAt) >= this.constructedAtMs
              if (current && (isExactLegacyProviderRecoveryFailure(record)
                ? readinessIsCurrentBoot
                : Date.parse(current.observedAt) > Date.parse(failure.failedAt))) {
                evidence = { class: failure.class, observedAt: current.observedAt }
              }
            } else if (failure.class === "execution_lease_expired") {
              if (!runtimeEvidenceByAgent.has(record.agent)) {
                const snapshot = this.processManager.listAgentSnapshots().find((candidate) =>
                  candidate.name === record.agent && candidate.channel === "private-runtime"
                    && candidate.status === "running" && candidate.pid !== null && candidate.startedAt !== null,
                )
                runtimeEvidenceByAgent.set(record.agent, snapshot?.startedAt ? { observedAt: snapshot.startedAt } : null)
              }
              const current = runtimeEvidenceByAgent.get(record.agent)
              if (current && Date.parse(current.observedAt) > Date.parse(failure.failedAt)) {
                evidence = { class: failure.class, observedAt: current.observedAt }
              }
            } else if (this.hasManagedPrivateRuntime(record.agent) && Date.parse(now) > Date.parse(failure.failedAt)) {
              evidence = { class: failure.class, observedAt: now }
            }
            if (!evidence) continue
            const revival = reviveExternalEventAfterRecovery(record.recordPath, { expectedVersion: record.version, expectedGeneration: record.generation, evidence, now: () => now, quiet: true })
            record = revival.record
            recoveredByClass.set(failure.class, (recoveredByClass.get(failure.class) ?? 0) + 1)
          } catch (error) {
            emitNervesEvent({
              level: "warn",
              component: "daemon",
              event: "daemon.external_event_recovery_error",
              message: "external event dead-letter recovery check failed",
              meta: { agent: record.agent, source: record.source, eventId: record.eventId, generation: record.generation, error: error instanceof Error ? error.message : String(error) },
            })
            continue
          }
        }
        if (record.executionState === "running" && record.claimExpiresAt && Date.parse(record.claimExpiresAt) <= Date.parse(now)) {
          record = reconcileExternalEvent(record.recordPath)
        }
        const due = record.executionState === "received"
          || record.executionState === "queued"
          || (record.executionState === "retry_wait" && record.nextAttemptAt !== null && Date.parse(record.nextAttemptAt) <= Date.parse(now))
        if (due) dueRecords.push(record)
      }
      if (recoveredByClass.size > 0) {
        emitNervesEvent({
          component: "daemon",
          event: "daemon.external_event_recovery_batch",
          message: "requeued external events after cached infrastructure recovery evidence",
          meta: { recovered: Object.fromEntries(recoveredByClass) },
        })
      }
      const batches = new Map<string, ExternalEventRecord[]>()
      for (const record of dueRecords) {
        const key = `${record.agent}\0${record.source}`
        const batch = batches.get(key) ?? []
        batch.push(record)
        batches.set(key, batch)
      }
      for (const records of batches.values()) {
        for (let offset = 0; offset < records.length; offset += 32) {
          const batch = records.slice(offset, offset + 32)
          try {
            await this.dispatchExternalEvents(batch)
          } catch (error) {
            emitNervesEvent({
              level: "warn",
              component: "daemon",
              event: "daemon.external_event_dispatch_error",
              message: "external event dispatch failed",
              meta: { recordPath: batch[0]!.recordPath, batchSize: batch.length, error: error instanceof Error ? error.message : /* v8 ignore next -- dispatch failures are Error objects @preserve */ String(error) },
            })
          }
        }
      }
    } finally {
      this.externalEventReconcileRunning = false
    }
  }

  private async handlePrivateRuntimeWake(
    command: Extract<DaemonCommand, { kind: "private.wake" | "inner.wake" }>,
    beforeDispatch?: (decision: PrivateTurnDecision) => void | Promise<void>,
    externalEvent?: ExternalEventLeaseContext,
  ): Promise<DaemonResponse> {
    if (!this.hasManagedPrivateRuntime(command.agent)) {
      return {
        ok: false,
        error: `No managed agent '${command.agent}' is registered with daemon-managed private runtime.`,
        denialCode: "managed_runtime_unavailable",
      }
    }

    const decision = await requestPrivateTurnDecision(this.buildPrivateRuntimeWakeRequest(command), {
      bundlesRoot: this.bundlesRoot,
      ...this.privateRuntimePolicyDeps,
    })

    if (!decision.executable) {
      return {
        ok: true,
        message: `private-runtime wake denied for ${command.agent}: ${decision.deniedReason}`,
        ...(decision.denialCode ? { denialCode: decision.denialCode } : {}),
        data: { decision },
      }
    }

    await beforeDispatch?.(decision)
    await this.processManager.startAgent(command.agent)
    this.processManager.sendToAgent?.(command.agent, this.buildPrivateRuntimeWorkerWakeMessage(command, decision, externalEvent))
    return {
      ok: true,
      message: `woke private runtime for ${command.agent}`,
      data: { decision },
    }
  }

  private async handleCommandInner(command: DaemonCommand): Promise<DaemonResponse> {
    switch (command.kind) {
      case "daemon.start":
        await this.start()
        return { ok: true, message: "daemon started" }
      case "daemon.stop":
        try {
          await this.stop()
        } finally {
          await this.onStopCommandComplete?.()
        }
        return { ok: true, message: "daemon stopped" }
      case "daemon.restart": {
        // Restart is "stop + let launchctl respawn." Under launchctl's KeepAlive
        // policy the process is auto-restarted on exit, so daemon.restart and
        // daemon.stop differ only in intent + audit trail. In dev (no launchctl),
        // the process simply exits — same observable behavior as daemon.stop.
        emitNervesEvent({
          component: "daemon",
          event: "daemon.restart_requested",
          message: "daemon restart requested",
          meta: {
            reason: command.reason ?? null,
            requestedBy: command.requestedBy ?? null,
          },
        })
        try {
          await this.stop()
        } finally {
          await this.onStopCommandComplete?.()
        }
        return {
          ok: true,
          message: "daemon restarting — launchctl will respawn",
        }
      }
      case "daemon.status": {
        const data = this.buildStatusPayload()
        return {
          ok: true,
          summary: formatStatusSummary(data),
          data,
        }
      }
      case "daemon.health": {
        const checks = await this.healthMonitor.runChecks()
        const summary = checks.map((check) => `${check.name}:${check.status}:${check.message}`).join("\n")
        return { ok: true, summary, data: checks }
      }
      case "daemon.logs":
        return {
          ok: true,
          summary: "logs: use `ouro logs` to tail daemon and agent output",
          message: "log streaming available via ouro logs",
          data: { logDir: "~/AgentBundles/<agent>.ouro/state/daemon/logs" },
        }
      case "daemon.sense_revive": {
        if (!isValidSenseReviveCommand(command)) {
          return {
            ok: false,
            error: "Invalid daemon.sense_revive payload: expected string fields 'agent', 'sense', and 'reason'.",
          }
        }
        const revivedSenseRow = await this.senseManager?.reviveSense?.(command.agent, command.sense)
        if (revivedSenseRow) {
          return {
            ok: true,
            message: `revived ${command.agent}/${command.sense}`,
            data: revivedSenseRow,
          }
        }

        const managedSenseSnapshots = this.processManager.listAgentSnapshots()
          .filter((snapshot) => snapshot.name.startsWith(`${command.agent}:`))
        if (managedSenseSnapshots.length === 0) {
          return {
            ok: false,
            error: `No managed agent '${command.agent}' is registered with daemon-managed senses.`,
          }
        }

        const exactTargetName = `${command.agent}:${command.sense}`
        const target = managedSenseSnapshots.find((snapshot) => snapshot.name === exactTargetName)
          ?? managedSenseSnapshots.find((snapshot) => snapshot.channel === command.sense)
        if (!target) {
          return {
            ok: false,
            error: `No managed sense '${command.sense}' is registered for agent '${command.agent}'.`,
          }
        }

        this.processManager.resetAgentFailureState(target.name)
        await this.processManager.startAgent(target.name)
        const freshSnapshot = this.processManager.listAgentSnapshots()
          .find((snapshot) => snapshot.name === target.name) ?? target
        return {
          ok: true,
          message: `revived ${command.agent}/${command.sense}`,
          data: freshSnapshot,
        }
      }
      case "agent.start":
        await this.processManager.startAgent(command.agent)
        return { ok: true, message: `started ${command.agent}` }
      case "agent.stop":
        await this.processManager.stopAgent?.(command.agent)
        return { ok: true, message: `stopped ${command.agent}` }
      case "agent.restart": {
        if (!this.processManager.restartAgent) {
          return { ok: false, error: "Managed agent restart is not available." }
        }
        const managedSnapshot = this.processManager.listAgentSnapshots()
          .find((snapshot) => snapshot.name === command.agent)
        if (!managedSnapshot) {
          return { ok: false, error: `Unknown managed agent '${command.agent}'.` }
        }
        if (managedSnapshot.autoStart === false && managedSnapshot.status === "stopped") {
          return { ok: true, message: `restart skipped for parked non-autostart agent '${command.agent}'` }
        }
        const restartWork = command.skipConfigCheck === true
          ? this.processManager.restartAgent(command.agent, { skipConfigCheck: true })
          : this.processManager.restartAgent(command.agent)
        void restartWork.catch((error) => {
          emitNervesEvent({
            level: "error",
            component: "daemon",
            event: "daemon.agent_restart_request_error",
            message: "managed agent restart failed after request acknowledgement",
            meta: {
              agent: command.agent,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        })
        return { ok: true, message: `restart requested for ${command.agent}` }
      }
      case "agent.ask":
        return handleAgentAskTurn(command, { socketPath: this.socketPath })
      case "agent.status":
        return handleAgentStatus(command)
      case "agent.catchup":
        return handleAgentCatchup(command)
      case "agent.delegate":
        return handleAgentDelegate(command)
      case "agent.getContext":
        return handleAgentGetContext(command)
      case "agent.searchFacts":
        return handleAgentSearchFacts(command)
      case "agent.getTask":
        return handleAgentGetTask(command)
      case "agent.checkScope":
        return handleAgentCheckScope(command)
      case "agent.requestDecision":
        return handleAgentRequestDecision(command)
      case "agent.checkGuidance":
        return handleAgentCheckGuidance(command)
      case "agent.reportProgress":
        return handleAgentReportProgress(command)
      case "agent.reportBlocker":
        return handleAgentReportBlocker(command)
      case "agent.reportComplete":
        return handleAgentReportComplete(command)
      case "agent.senseTurn":
        return handleAgentSenseTurn(command, { socketPath: this.socketPath })
      /* v8 ignore stop */
      case "cron.list": {
        const jobs = this.scheduler.listJobs()
        const summary = jobs.length === 0
          ? "no cron jobs"
          : jobs.map((job) => `${job.id}\t${job.schedule}\tlast=${job.lastRun ?? "never"}`).join("\n")
        return { ok: true, summary, data: jobs }
      }
      case "cron.trigger": {
        const habitResult = await this.scheduler.triggerHabitJob?.(command.jobId)
        if (habitResult?.ok) {
          return { ok: true, message: habitResult.message }
        }
        const result = await this.scheduler.triggerJob(command.jobId)
        return { ok: result.ok, message: result.message }
      }
      case "message.send": {
        // Pure queue-only delivery. We DO NOT wake the recipient — that was
        // the 2026-05-11 $50 bleed. The Claude Code post-tool-use hook
        // (cli-exec.ts) intentionally sends only message.send for tool-use
        // events to avoid waking the agent on every tool call. The hook's
        // intent was completely defeated by this handler calling
        // `sendToAgent({type: "message"})`, which woke the private runtime
        // worker on EVERY message.send anyway. ~30 message.send/min × the
        // 3-turn instinct-loop cap = ~90 turns/min sustained for hours.
        //
        // Callers that want immediate processing must send `private.wake`
        // explicitly after message.send. The CLI `ouro msg` does so
        // (lifecycle-boundary delivery should wake); the hook does so
        // only on session-start / stop, not per tool-use; the API does
        // not (notifications go to the queue).
        const receipt = await this.router.send({
          from: command.from,
          to: command.to,
          content: command.content,
          priority: command.priority,
          sessionId: command.sessionId,
          taskRef: command.taskRef,
        })
        return { ok: true, message: `queued message ${receipt.id}`, data: receipt }
      }
      case "message.poll": {
        const messages = this.router.pollInbox(command.agent)
        return {
          ok: true,
          summary: `${messages.length} messages`,
          data: messages,
        }
      }
      case "external.event.submit": {
        const record = recordExternalEvent({
          agent: command.agent,
          source: command.source,
          eventType: command.eventType,
          eventId: command.eventId,
          summary: command.summary,
          evidence: command.evidence,
          payloadPath: command.payloadPath,
          priority: command.priority,
          observationRevision: command.observationRevision,
          transition: command.transition,
        }, {
          ...(this.externalEventRoot ? { root: this.externalEventRoot } : {}),
          dispatchEnabled: command.wake !== false,
        })
        if (!record.shouldWake || command.wake === false) {
          return {
            ok: true,
            message: `updated external event ${record.source}/${record.eventId} without wake`,
            data: { event: record, receipt: null, wake: null },
          }
        }
        const dispatched = await this.dispatchExternalEvent(record)
        return {
          ok: true,
          message: `queued external event ${record.source}/${record.eventId} as ${dispatched.receipt.id}; ${dispatched.wake.message ?? "wake skipped"}`,
          data: dispatched,
        }
      }
      case "private.decisions": {
        const requestedLimit = Number.isInteger(command.limit) && command.limit && command.limit > 0 ? command.limit : 20
        const limit = Math.min(requestedLimit, 1000)
        const ledgerPath = privateTurnLedgerPath(command.agent, { bundlesRoot: this.bundlesRoot })
        const ledgerExists = fs.existsSync(ledgerPath)
        let decisions
        try {
          decisions = ledgerExists ? readPrivateTurnLedger(ledgerPath) : []
        } catch {
          return {
            ok: false,
            error: `private-runtime decision ledger is malformed: ${ledgerPath}; repair or remove malformed JSONL rows before reading decisions`,
          }
        }
        const guidance = ledgerExists
          ? undefined
          : `No private-runtime decision ledger exists for ${command.agent}; run an explicit private-runtime trigger or check ${path.dirname(ledgerPath)}.`
        const payload = buildPrivateDecisionReadPayload({
          agent: command.agent,
          ledgerPath,
          decisions,
          limit,
          ...(guidance ? { guidance } : {}),
        })
        return {
          ok: true,
          summary: privateDecisionCountSummary(payload.decisions.length),
          ...(guidance ? { message: guidance } : {}),
          data: payload,
        }
      }
      case "inner.wake":
        return this.handlePrivateRuntimeWake(command)
      case "private.wake": {
        const scheduledHabit = habitMessageFromPrivateWakeCommand(command)
        if (!scheduledHabit || !this.hasManagedPrivateRuntime(command.agent)) {
          return this.handlePrivateRuntimeWake(command)
        }
        const occurrenceRef = command.originRefs?.find((ref) => ref.kind === "habit-occurrence")
        const occurrenceId = typeof occurrenceRef?.id === "string" && occurrenceRef.id.trim().length > 0
          ? occurrenceRef.id.trim()
          : undefined
        const resolution = this.resolveHabitDispatch({
          agent: command.agent,
          habitName: scheduledHabit.habitName,
          trigger: scheduledHabit.trigger,
          source: "private-wake",
          ...(occurrenceId ? { occurrenceId } : {}),
        })
        if (resolution.kind === "skipped") {
          this.emitHabitDispatchSkipped({
            agent: command.agent,
            habitName: scheduledHabit.habitName,
            trigger: scheduledHabit.trigger,
            resolution,
          })
          return this.skippedHabitDispatchResponse({
            agent: command.agent,
            habitName: scheduledHabit.habitName,
            skipReason: resolution.skipReason,
          })
        }
        this.emitHabitDispatchReady({
          agent: command.agent,
          habitName: scheduledHabit.habitName,
          trigger: scheduledHabit.trigger,
          resolution,
        })
        return this.handlePrivateRuntimeWake(command)
      }
      case "chat.connect":
        await this.processManager.startAgent(command.agent)
        return {
          ok: true,
          message: `connected to ${command.agent}`,
        }
      case "task.poke": {
        if (!isValidTaskPokeCommand(command)) {
          return {
            ok: false,
            error: "Invalid task.poke payload: expected non-empty string fields 'agent' and 'taskId'.",
          }
        }

        const receipt = await this.router.send({
          from: "ouro-poke",
          to: command.agent,
          content: `poke ${command.taskId}`,
          priority: "high",
          taskRef: command.taskId,
        })
        await this.scheduler.recordTaskRun?.(command.agent, command.taskId)
        await this.handlePrivateRuntimeWake(this.buildTaskPokePrivateWakeCommand(command, receipt.id))
        return {
          ok: true,
          message: `queued poke ${receipt.id}`,
          data: receipt,
        }
      }
      case "habit.scheduler-fire": {
        if (!this.schedulerFireVerifier || !this.schedulerFireConsumer) return { ok: false, error: "authenticated scheduler fire is unavailable" }
        let origin: SanctuarySchedulerOrigin & { occurrenceId: string }
        try {
          origin = this.schedulerFireVerifier(command)
          this.schedulerFireConsumer(origin)
        }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
        const poke = { kind: "habit.poke", agent: command.agent, habitName: command.habitName, trigger: "cron", occurrenceId: origin.occurrenceId } as const
        this.authenticatedSchedulerPokes.set(poke, origin)
        try { return await this.handleCommand(poke) } finally { this.authenticatedSchedulerPokes.delete(poke) }
      }
      case "habit.poke": {
        if (!isValidHabitPokeCommand(command)) {
          return {
            ok: false,
            error: "Invalid habit.poke payload: expected non-empty string fields 'agent' and 'habitName'.",
          }
        }

        const trigger = command.trigger ?? "poke"
        if (!isHabitRunTrigger(trigger)) {
          return { ok: false, error: `invalid habit trigger: ${String(trigger)}` }
        }
        const schedulerOrigin = this.authenticatedSchedulerPokes.get(command)
        if (command.agent === "sanctuary" && command.habitName === "sanctuary-health" && trigger === "cron" && !schedulerOrigin) {
          return { ok: false, error: "Sanctuary cron habit requires authenticated Supercronic provenance" }
        }
        if (!isRsvpHabitName(command.habitName) && !this.hasManagedPrivateRuntime(command.agent)) {
          return {
            ok: false,
            error: `No managed agent '${command.agent}' is registered with daemon-managed private runtime.`,
          }
        }
        const resolution = this.resolveHabitDispatch({
          agent: command.agent,
          habitName: command.habitName,
          trigger,
          source: "habit-poke",
          ...(command.occurrenceId ? { occurrenceId: command.occurrenceId } : {}),
        })
        if (resolution.kind === "skipped") {
          this.emitHabitDispatchSkipped({
            agent: command.agent,
            habitName: command.habitName,
            trigger,
            resolution,
          })
          return this.skippedHabitDispatchResponse({
            agent: command.agent,
            habitName: command.habitName,
            skipReason: resolution.skipReason,
          })
        }
        this.emitHabitDispatchReady({
          agent: command.agent,
          habitName: command.habitName,
          trigger,
          resolution,
        })
        if (this.nativeHabitRunner && this.nativeHabitMatch?.(command.agent, command.habitName)) {
          const occurrenceId = resolution.occurrenceId ?? `${trigger}:${command.agent}:${command.habitName}`
          const claimKey = `${command.agent}:${command.habitName}`
          if (this.nativeHabitClaims.has(claimKey)) {
            return { ok: true, message: `skipped overlapping native habit occurrence ${occurrenceId}` }
          }
          this.nativeHabitClaims.add(claimKey)
          const startedAt = new Date().toISOString()
          const runnerId = randomUUID()
          let nativeResult: DaemonResponse
          try {
            nativeResult = await this.nativeHabitRunner({
              agent: command.agent,
              habitName: command.habitName,
              trigger,
              occurrenceId,
              runnerId,
              ...(schedulerOrigin ? { schedulerOrigin } : {}),
            }) ?? { ok: false, error: "native habit runner declined a matched habit" }
          } catch (error) {
            nativeResult = { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
          const endedAt = new Date().toISOString()
          let completion
          try {
            completion = completeHabitRun({
              agentRoot: path.join(this.bundlesRoot, `${command.agent}.ouro`),
              habit: resolution.habit,
              runId: runnerId,
              trigger,
              startedAt,
              endedAt,
              operationId: occurrenceId,
              permissionEnvelope: { schemaVersion: 1, canMessageOutward: true, returnRoutes: [], deniedTools: [], warnings: [] },
              toolPolicy: { requestedTools: null, grantedTools: [], deniedTools: [], outwardMessagingAllowed: true },
              ...(nativeResult.ok ? {} : { errors: [nativeResult.error ?? nativeResult.message ?? "native habit failed"] }),
            })
          } finally {
            this.nativeHabitClaims.delete(claimKey)
          }
          if (!completion.receiptWritten || !completion.runtimeStateRecorded) {
            return { ok: false, error: "native habit completed but its durable receipt or cursor could not be recorded", data: nativeResult }
          }
          return nativeResult
        }
        if (isRsvpHabitName(command.habitName)) {
          return this.runNativeRsvpHabit(command, trigger, resolution.occurrenceId)
        }
        return this.handlePrivateRuntimeWake(buildHabitPrivateWakeCommand({
          agent: command.agent,
          habitName: command.habitName,
          trigger,
          sourceRef: { kind: "daemon-command", id: "habit.poke" },
          occurrenceId: resolution.occurrenceId,
        }))
      }
      case "habit.probe": {
        if (!isValidHabitProbeCommand(command)) {
          return {
            ok: false,
            error: "Invalid habit.probe payload: expected non-empty agent/habitName and noSend=true.",
          }
        }
        const trigger: HabitRunTrigger = "manual"
        if (!isRsvpHabitName(command.habitName) && !this.hasManagedPrivateRuntime(command.agent)) {
          return {
            ok: false,
            error: `No managed agent '${command.agent}' is registered with daemon-managed private runtime.`,
          }
        }
        const resolution = this.resolveHabitDispatch({
          agent: command.agent,
          habitName: command.habitName,
          trigger,
          source: "habit-probe",
        })
        if (resolution.kind === "skipped") {
          this.emitHabitDispatchSkipped({
            agent: command.agent,
            habitName: command.habitName,
            trigger,
            resolution,
          })
          return {
            ok: true,
            message: `habit probe rejected by lifecycle: status=${resolution.habit.status}`,
            data: {
              noSend: true,
              status: resolution.habit.status,
              transportInvocationCount: 0,
            },
          }
        }
        this.emitHabitDispatchReady({
          agent: command.agent,
          habitName: command.habitName,
          trigger,
          resolution,
        })
        if (isRsvpHabitName(command.habitName)) {
          return this.runNativeRsvpHabit(command, trigger, resolution.occurrenceId, true)
        }
        const wake = await this.handlePrivateRuntimeWake(buildHabitPrivateWakeCommand({
          agent: command.agent,
          habitName: command.habitName,
          trigger,
          sourceRef: { kind: "daemon-command", id: "habit.probe" },
          occurrenceId: resolution.occurrenceId,
          noSend: true,
        }))
        if (!wake.ok) return wake
        const denied = (wake.data as { decision?: { executable?: unknown } } | undefined)
          ?.decision?.executable === false
        const error = denied
          ? "non-RSVP habit probe was not executed because private-runtime policy denied execution"
          : "non-RSVP habit probe completion is asynchronous; zero-transport evidence is unverified"
        return {
          ok: false,
          error,
          data: {
            ok: false,
            noSend: true,
            status: resolution.habit.status,
            transportInvocationCount: null,
            error,
          },
        }
      }
      case "await.poke": {
        return this.handlePrivateRuntimeWake(this.buildAwaitPrivateWakeCommand(command))
      }
      case "mcp.list": {
        setAgentName(command.agent ?? "default")
        const mcpManager = await getSharedMcpManager()
        if (!mcpManager) {
          return { ok: true, data: [], message: "no MCP servers configured" }
        }
        return { ok: true, data: mcpManager.listAllTools() }
      }
      case "mcp.call": {
        setAgentName(command.agent ?? "default")
        const mcpCallManager = await getSharedMcpManager()
        if (!mcpCallManager) {
          return { ok: false, error: "no MCP servers configured" }
        }
        try {
          const parsedArgs = command.args ? JSON.parse(command.args) as Record<string, unknown> : {}
          const result = await mcpCallManager.callTool(command.server, command.tool, parsedArgs)
          return { ok: true, data: result }
        } catch (error) {
          /* v8 ignore next -- defensive: callTool errors are always Error instances @preserve */
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      case "hatch.start":
        return {
          ok: true,
          message: "hatch flow is stubbed; the interactive implementation lands in a later milestone",
        }
      default:
        return {
          ok: false,
          error: `Unknown daemon command kind '${(command as { kind: string }).kind}'.`,
        }
    }
  }
}
