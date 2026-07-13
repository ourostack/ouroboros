import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

import { loadOrCreateMachineIdentity } from "../heart/machine-identity"
import { readMachineRuntimeCredentialConfig, refreshMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"

export type RsvpCutoverAction = "check" | "quarantine-launchd" | "retire-legacy-send-config"

export interface RsvpCutoverChecks {
  launchAgentInactive: boolean
  legacyProcessInactive: boolean
  legacyConfigSendInactive: boolean
  legacyLiveSendInactive: boolean
  nativeBlueBubblesCredentialHealthy: boolean
}

export interface RsvpCutoverRollback {
  configBackupPath: string
  launchAgentBackupPath: string
  manifestPath: string
}

export interface RsvpCutoverReport {
  ok: boolean
  action: RsvpCutoverAction
  sideEffect: boolean
  agent?: string
  legacyRoot: string
  checks: RsvpCutoverChecks
  sendAllowed: boolean
  denialReasons: string[]
  message: string
  requires?: "--yes"
  rollback: RsvpCutoverRollback
}

export interface RsvpCutoverLaunchAgentState {
  label: string
  loaded: boolean
  plistPath?: string
  source: "launchctl" | "injected" | "unavailable"
}

export interface RsvpCutoverProcessState {
  running: boolean
  count: number
  source: "ps" | "injected" | "unavailable"
}

export interface RsvpCutoverCredentialHealth {
  ok: boolean
  detail: string
}

export interface RsvpCutoverDeps {
  existsSync?: (filePath: string) => boolean
  readFileSync?: (filePath: string) => string
  writeFileSync?: (filePath: string, contents: string) => void
  mkdirSync?: (dirPath: string) => void
  renameSync?: (oldPath: string, newPath: string) => void
  copyFileSync?: (sourcePath: string, targetPath: string) => void
  now?: () => Date
  spawnSync?: SpawnSyncLike
  platform?: NodeJS.Platform
  getUid?: () => number | null
  homeDir?: () => string
  fetchImpl?: typeof fetch
  getLaunchAgentState?: (input: { label: string; legacyRoot: string }) => Promise<RsvpCutoverLaunchAgentState>
  getLegacyProcessState?: (input: { legacyRoot: string }) => Promise<RsvpCutoverProcessState>
  checkNativeBlueBubblesCredential?: (input: { agent?: string }) => Promise<RsvpCutoverCredentialHealth>
  unloadLaunchAgent?: (input: { label: string; legacyRoot: string; plistPath?: string }) => Promise<{ ok: boolean; detail?: string }>
}

export interface CheckRsvpCutoverInput {
  agent?: string
  legacyRoot: string
  deps?: RsvpCutoverDeps
}

export interface RunRsvpCutoverInput extends CheckRsvpCutoverInput {
  action: RsvpCutoverAction
  yes?: boolean
}

type JsonRecord = Record<string, unknown>
type SpawnSyncLike = (
  command: string,
  args: string[],
  options: { encoding: "utf-8"; timeout: number },
) => { status: number | null; stdout?: string }

interface NormalizedRsvpCutoverDeps {
  existsSync: (filePath: string) => boolean
  readFileSync: (filePath: string) => string
  writeFileSync: (filePath: string, contents: string) => void
  mkdirSync: (dirPath: string) => void
  renameSync: (oldPath: string, newPath: string) => void
  copyFileSync: (sourcePath: string, targetPath: string) => void
  now: () => Date
  spawnSync: SpawnSyncLike
  platform: NodeJS.Platform
  getUid: () => number | null
  homeDir: () => string
  fetchImpl: typeof fetch
  getLaunchAgentState?: RsvpCutoverDeps["getLaunchAgentState"]
  getLegacyProcessState?: RsvpCutoverDeps["getLegacyProcessState"]
  checkNativeBlueBubblesCredential?: RsvpCutoverDeps["checkNativeBlueBubblesCredential"]
  unloadLaunchAgent?: RsvpCutoverDeps["unloadLaunchAgent"]
}

const LEGACY_LAUNCH_AGENT_LABEL = "com.arimendelow.rsvp-tracker"
const EMPTY_ROLLBACK: RsvpCutoverRollback = {
  configBackupPath: "",
  launchAgentBackupPath: "",
  manifestPath: "",
}

function normalizeDeps(deps: RsvpCutoverDeps = {}): NormalizedRsvpCutoverDeps {
  return {
    existsSync: deps.existsSync ?? fs.existsSync,
    readFileSync: deps.readFileSync ?? ((filePath) => fs.readFileSync(filePath, "utf-8")),
    writeFileSync: deps.writeFileSync ?? ((filePath, contents) => fs.writeFileSync(filePath, contents, "utf-8")),
    mkdirSync: deps.mkdirSync ?? ((dirPath) => fs.mkdirSync(dirPath, { recursive: true })),
    renameSync: deps.renameSync ?? fs.renameSync,
    copyFileSync: deps.copyFileSync ?? fs.copyFileSync,
    now: deps.now ?? (() => new Date()),
    spawnSync: deps.spawnSync ?? spawnSync,
    platform: deps.platform ?? process.platform,
    getUid: deps.getUid ?? (() => process.getuid!()),
    homeDir: deps.homeDir ?? os.homedir,
    fetchImpl: deps.fetchImpl ?? fetch,
    getLaunchAgentState: deps.getLaunchAgentState,
    getLegacyProcessState: deps.getLegacyProcessState,
    checkNativeBlueBubblesCredential: deps.checkNativeBlueBubblesCredential,
    unloadLaunchAgent: deps.unloadLaunchAgent,
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function safeStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-")
}

function rollbackDir(legacyRoot: string, now: Date): string {
  return path.join(legacyRoot, ".ouro-cutover", safeStamp(now))
}

function buildBlueBubblesHealthUrl(baseUrl: string, password: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const url = new URL("api/v1/message/count", root)
  url.searchParams.set("password", password)
  return url.toString()
}

function readLegacyConfig(legacyRoot: string, deps: NormalizedRsvpCutoverDeps): { status: "missing" | "malformed" | "ok"; config?: JsonRecord } {
  const configPath = path.join(legacyRoot, "config.json")
  if (!deps.existsSync(configPath)) return { status: "missing" }
  try {
    const parsed = JSON.parse(deps.readFileSync(configPath)) as unknown
    const config = asRecord(parsed)
    return config ? { status: "ok", config } : { status: "malformed" }
  } catch {
    return { status: "malformed" }
  }
}

function legacyConfigSendInactive(legacyRoot: string, deps: NormalizedRsvpCutoverDeps): boolean {
  const legacy = readLegacyConfig(legacyRoot, deps)
  if (legacy.status === "missing") return true
  if (legacy.status !== "ok") return false
  const bluebubbles = asRecord(legacy.config?.bluebubbles)
  if (!bluebubbles) return true
  if (bluebubbles.disabled === true || bluebubbles.enabled === false || bluebubbles.send_enabled === false || bluebubbles.sendEnabled === false) return true
  const hasLiveCoordinates = !!text(bluebubbles.server_url ?? bluebubbles.serverUrl)
    && !!text(bluebubbles.chat_guid ?? bluebubbles.chatGuid)
    && !!text(bluebubbles.secrets_path ?? bluebubbles.secretsPath)
  return !hasLiveCoordinates
}

async function defaultLaunchAgentState(input: { label: string; legacyRoot: string }, deps: NormalizedRsvpCutoverDeps): Promise<RsvpCutoverLaunchAgentState> {
  if (deps.platform !== "darwin") {
    return { label: input.label, loaded: false, source: "unavailable" }
  }
  const uid = deps.getUid()
  if (uid === null) return { label: input.label, loaded: false, source: "unavailable" }
  const result = deps.spawnSync("launchctl", ["print", `gui/${uid}/${input.label}`], {
    encoding: "utf-8",
    timeout: 5_000,
  })
  return {
    label: input.label,
    loaded: result.status === 0,
    plistPath: firstExistingPath([
      path.join(input.legacyRoot, `${input.label}.plist`),
      path.join(deps.homeDir(), "Library", "LaunchAgents", `${input.label}.plist`),
    ], deps),
    source: "launchctl",
  }
}

async function defaultLegacyProcessState(input: { legacyRoot: string }, deps: NormalizedRsvpCutoverDeps): Promise<RsvpCutoverProcessState> {
  const result = deps.spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf-8",
    timeout: 5_000,
  })
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { running: false, count: 0, source: "unavailable" }
  }
  const legacyRoot = input.legacyRoot
  const count = result.stdout
    .split("\n")
    .filter((line) => line.includes("rsvp_tracker.py") || line.includes(legacyRoot))
    .filter((line) => !line.includes("vitest") && !line.includes("node "))
    .length
  return { running: count > 0, count, source: "ps" }
}

async function defaultNativeBlueBubblesCredentialHealth(input: { agent?: string }, deps: NormalizedRsvpCutoverDeps): Promise<RsvpCutoverCredentialHealth> {
  if (!input.agent) {
    return { ok: false, detail: "native BlueBubbles credential check requires an agent" }
  }
  const cachedRuntimeConfig = readMachineRuntimeCredentialConfig(input.agent)
  const runtimeConfig = cachedRuntimeConfig.ok
    ? cachedRuntimeConfig
    : await refreshMachineRuntimeCredentialConfig(input.agent, loadOrCreateMachineIdentity({ homeDir: deps.homeDir() }).machineId, { preserveCachedOnFailure: true })
  if (!runtimeConfig.ok) {
    return { ok: false, detail: "machine runtime/config unavailable" }
  }
  const bluebubbles = asRecord(runtimeConfig.config.bluebubbles)
  const bluebubblesSense = asRecord(runtimeConfig.config.bluebubblesChannel)
  const serverUrl = text(bluebubbles?.serverUrl)
  const password = text(bluebubbles?.password)
  if (!serverUrl || !password) {
    return { ok: false, detail: "machine runtime/config missing bluebubbles serverUrl/password" }
  }
  const requestTimeoutMs = typeof bluebubblesSense?.requestTimeoutMs === "number" && Number.isFinite(bluebubblesSense.requestTimeoutMs)
    ? bluebubblesSense.requestTimeoutMs
    : 30_000
  try {
    const response = await deps.fetchImpl(buildBlueBubblesHealthUrl(serverUrl, password), {
      method: "GET",
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    return response.ok
      ? { ok: true, detail: "native BlueBubbles credential healthy" }
      : { ok: false, detail: `native BlueBubbles health probe returned HTTP ${response.status}` }
  } catch {
    return { ok: false, detail: "native BlueBubbles health probe failed" }
  }
}

async function defaultUnloadLaunchAgent(input: { label: string; plistPath?: string }, deps: NormalizedRsvpCutoverDeps): Promise<{ ok: boolean; detail?: string }> {
  if (deps.platform !== "darwin") return { ok: true, detail: "launchd not applicable on this platform" }
  const uid = deps.getUid()
  if (uid === null) return { ok: false, detail: "current uid unavailable" }
  const bootout = deps.spawnSync("launchctl", ["bootout", `gui/${uid}/${input.label}`], {
    encoding: "utf-8",
    timeout: 5_000,
  })
  if (bootout.status === 0) return { ok: true }
  if (input.plistPath) {
    const unload = deps.spawnSync("launchctl", ["unload", "-w", input.plistPath], {
      encoding: "utf-8",
      timeout: 5_000,
    })
    if (unload.status === 0) return { ok: true }
  }
  return { ok: true, detail: "legacy LaunchAgent was not loaded or launchctl did not report it as loaded" }
}

function firstExistingPath(candidates: Array<string | undefined>, deps: Pick<NormalizedRsvpCutoverDeps, "existsSync">): string | undefined {
  return candidates.find((candidate): candidate is string => !!candidate && deps.existsSync(candidate))
}

function launchAgentPlistCandidates(legacyRoot: string, state: RsvpCutoverLaunchAgentState, deps: NormalizedRsvpCutoverDeps): string[] {
  const candidates = [
    state.plistPath,
    path.join(legacyRoot, `${LEGACY_LAUNCH_AGENT_LABEL}.plist`),
    path.join(deps.homeDir(), "Library", "LaunchAgents", `${LEGACY_LAUNCH_AGENT_LABEL}.plist`),
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => !!candidate && deps.existsSync(candidate)))]
}

function denialReasons(checks: RsvpCutoverChecks): string[] {
  const reasons: string[] = []
  if (!checks.launchAgentInactive) reasons.push("legacy LaunchAgent is still loaded")
  if (!checks.legacyProcessInactive) reasons.push("legacy RSVP process is still running")
  if (!checks.legacyConfigSendInactive) reasons.push("legacy RSVP config can still send BlueBubbles messages")
  if (!checks.legacyLiveSendInactive) reasons.push("legacy live-send path is still active")
  if (!checks.nativeBlueBubblesCredentialHealthy) reasons.push("native BlueBubbles credential is not healthy")
  return reasons
}

function report(input: {
  action: RsvpCutoverAction
  sideEffect: boolean
  agent?: string
  legacyRoot: string
  checks: RsvpCutoverChecks
  ok?: boolean
  requires?: "--yes"
  rollback?: Partial<RsvpCutoverRollback>
}): RsvpCutoverReport {
  const reasons = denialReasons(input.checks)
  const sendAllowed = reasons.length === 0
  return {
    ok: input.ok ?? true,
    action: input.action,
    sideEffect: input.sideEffect,
    ...(input.agent ? { agent: input.agent } : {}),
    legacyRoot: input.legacyRoot,
    checks: input.checks,
    sendAllowed,
    denialReasons: reasons,
    message: sendAllowed
      ? "native RSVP live send is allowed"
      : "native RSVP live send is blocked until cutover gates pass",
    ...(input.requires ? { requires: input.requires } : {}),
    rollback: {
      ...EMPTY_ROLLBACK,
      ...input.rollback,
    },
  }
}

async function buildChecks(input: CheckRsvpCutoverInput, deps: NormalizedRsvpCutoverDeps): Promise<RsvpCutoverChecks> {
  if (!deps.existsSync(input.legacyRoot)) {
    return {
      launchAgentInactive: true,
      legacyProcessInactive: true,
      legacyConfigSendInactive: true,
      legacyLiveSendInactive: true,
      nativeBlueBubblesCredentialHealthy: false,
    }
  }

  const launchAgentState = deps.getLaunchAgentState
    ? await deps.getLaunchAgentState({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      legacyRoot: input.legacyRoot,
    })
    : await defaultLaunchAgentState({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      legacyRoot: input.legacyRoot,
    }, deps)
  const processState = deps.getLegacyProcessState
    ? await deps.getLegacyProcessState({ legacyRoot: input.legacyRoot })
    : await defaultLegacyProcessState({ legacyRoot: input.legacyRoot }, deps)
  const configInactive = legacyConfigSendInactive(input.legacyRoot, deps)
  const liveInactive = !launchAgentState.loaded && !processState.running && configInactive
  const nativeCredential = deps.checkNativeBlueBubblesCredential
    ? await deps.checkNativeBlueBubblesCredential({ agent: input.agent })
    : await defaultNativeBlueBubblesCredentialHealth({ agent: input.agent }, deps)
  return {
    launchAgentInactive: !launchAgentState.loaded,
    legacyProcessInactive: !processState.running,
    legacyConfigSendInactive: configInactive,
    legacyLiveSendInactive: liveInactive,
    nativeBlueBubblesCredentialHealthy: nativeCredential.ok,
  }
}

export async function checkRsvpCutover(input: CheckRsvpCutoverInput): Promise<RsvpCutoverReport> {
  const deps = normalizeDeps(input.deps)
  const checks = await buildChecks(input, deps)
  const result = report({
    action: "check",
    sideEffect: false,
    agent: input.agent,
    legacyRoot: input.legacyRoot,
    checks,
  })
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.cutover_checked",
    message: "checked RSVP legacy cutover gates",
    meta: {
      agent: input.agent,
      sendAllowed: result.sendAllowed,
      denialCount: result.denialReasons.length,
    },
  })
  return result
}

function writeRollbackManifest(input: {
  legacyRoot: string
  action: RsvpCutoverAction
  deps: NormalizedRsvpCutoverDeps
  rollback: Partial<RsvpCutoverRollback>
}): RsvpCutoverRollback {
  const manifestPath = path.join(rollbackDir(input.legacyRoot, input.deps.now()), `${input.action}-rollback.json`)
  input.deps.mkdirSync(path.dirname(manifestPath))
  const rollback = {
    ...EMPTY_ROLLBACK,
    ...input.rollback,
    manifestPath,
  }
  input.deps.writeFileSync(manifestPath, `${JSON.stringify({
    action: input.action,
    createdAt: input.deps.now().toISOString(),
    label: LEGACY_LAUNCH_AGENT_LABEL,
    rollback,
  }, null, 2)}\n`)
  return rollback
}

async function retireLegacySendConfig(input: RunRsvpCutoverInput, deps: NormalizedRsvpCutoverDeps): Promise<RsvpCutoverRollback> {
  const configPath = path.join(input.legacyRoot, "config.json")
  const backupPath = path.join(rollbackDir(input.legacyRoot, deps.now()), "config.json")
  deps.mkdirSync(path.dirname(backupPath))
  deps.copyFileSync(configPath, backupPath)
  const legacy = readLegacyConfig(input.legacyRoot, deps)
  const config = legacy.status === "ok" ? { ...legacy.config } : {}
  config.bluebubbles = {
    send_enabled: false,
    enabled: false,
    disabled: true,
    disabled_by: "ouro rsvp cutover",
    disabled_at: deps.now().toISOString(),
  }
  deps.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return writeRollbackManifest({
    legacyRoot: input.legacyRoot,
    action: "retire-legacy-send-config",
    deps,
    rollback: { configBackupPath: backupPath },
  })
}

async function quarantineLaunchAgent(input: RunRsvpCutoverInput, deps: NormalizedRsvpCutoverDeps): Promise<RsvpCutoverRollback> {
  const state = deps.getLaunchAgentState
    ? await deps.getLaunchAgentState({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      legacyRoot: input.legacyRoot,
    })
    : await defaultLaunchAgentState({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      legacyRoot: input.legacyRoot,
    }, deps)
  const candidates = launchAgentPlistCandidates(input.legacyRoot, state, deps)
  const plistPath = candidates[0]
  if (deps.unloadLaunchAgent) {
    await deps.unloadLaunchAgent({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      legacyRoot: input.legacyRoot,
      ...(plistPath ? { plistPath } : {}),
    })
  } else {
    await defaultUnloadLaunchAgent({
      label: LEGACY_LAUNCH_AGENT_LABEL,
      ...(plistPath ? { plistPath } : {}),
    }, deps)
  }
  let backupPath = ""
  if (plistPath) {
    backupPath = path.join(rollbackDir(input.legacyRoot, deps.now()), path.basename(plistPath))
    deps.mkdirSync(path.dirname(backupPath))
    deps.renameSync(plistPath, backupPath)
  }
  return writeRollbackManifest({
    legacyRoot: input.legacyRoot,
    action: "quarantine-launchd",
    deps,
    rollback: { launchAgentBackupPath: backupPath },
  })
}

export async function runRsvpCutover(input: RunRsvpCutoverInput): Promise<RsvpCutoverReport> {
  const deps = normalizeDeps(input.deps)
  if (input.action !== "check" && !input.yes) {
    const checks = await buildChecks(input, deps)
    return report({
      action: input.action,
      sideEffect: false,
      agent: input.agent,
      legacyRoot: input.legacyRoot,
      checks,
      ok: false,
      requires: "--yes",
    })
  }

  if (input.action === "check") {
    return checkRsvpCutover(input)
  }

  const rollback = input.action === "retire-legacy-send-config"
    ? await retireLegacySendConfig(input, deps)
    : await quarantineLaunchAgent(input, deps)
  const checks = await buildChecks(input, deps)
  const result = report({
    action: input.action,
    sideEffect: true,
    agent: input.agent,
    legacyRoot: input.legacyRoot,
    checks,
    rollback,
  })
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.cutover_action_executed",
    message: "executed RSVP cutover action",
    meta: {
      agent: input.agent,
      action: input.action,
      sendAllowed: result.sendAllowed,
    },
  })
  return result
}
