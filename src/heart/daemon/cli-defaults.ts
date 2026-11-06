/**
 * CLI default dependency wiring.
 *
 * Creates the production OuroCliDeps with real filesystem, socket, and
 * process bindings. Tests inject mocks for all of these.
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { getAgentBundlesRoot, getAgentDaemonLogsDir, getAgentRoot, getRepoRoot, PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { installOuroCommand as defaultInstallOuroCommand } from "../versioning/ouro-path-installer"
import { registerOuroBundleUti as defaultRegisterOuroBundleUti } from "../versioning/ouro-uti"
import { getCurrentVersion, getPreviousVersion, listInstalledVersions, installVersion, activateVersion, ensureLayout, getOuroCliHome, pruneOldVersions } from "../versioning/ouro-version-manager"
import { CLI_UPDATE_CHECK_TIMEOUT_MS } from "../versioning/update-checker"
import { ensureSkillManagement as defaultEnsureSkillManagement } from "./skill-management-installer"
import {
  runHatchFlow as defaultRunHatchFlow,
  type HatchCredentialsInput,
} from "../hatch/hatch-flow"
import {
  listExistingBundles,
  loadSoulText,
  pickRandomIdentity,
} from "../hatch/specialist-orchestrator"
import { buildSpecialistSystemPrompt } from "../hatch/specialist-prompt"
import { getSpecialistTools, createSpecialistExecTool } from "../hatch/specialist-tools"
import { detectRuntimeMode } from "./runtime-mode"
import { listEnabledBundleAgents } from "./agent-discovery"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { syncGlobalOuroBotWrapper as defaultSyncGlobalOuroBotWrapper } from "../versioning/ouro-bot-global-installer"
import { pruneDaemonLogs as defaultPruneDaemonLogs } from "./logs-prune"
import { readHealth, getDefaultHealthPath } from "./daemon-health"
import { discoverLogFiles, formatLogLine, readLastLines, tailLogs as defaultTailLogs } from "./log-tailer"
import { writeLaunchAgentPlist } from "./launchd"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand, checkDaemonSocketAlive } from "./socket-client"
import { listSessionActivity } from "../session-activity"
import {
  runRuntimeAuthFlow as defaultRunRuntimeAuthFlow,
  collectRuntimeAuthCredentials,
} from "../auth/auth-flow"
import { DEFAULT_PROVIDER_MODELS } from "../provider-models"
import { isAgentProvider } from "./cli-parse"
import type { OuroCliDeps, DiscoveredCredential } from "./cli-types"
import { describeDiscoveredCredentialSource, discoverInstalledAgentCredentials, scanEnvVarCredentials } from "./provider-discovery"
import {
  cacheProviderCredentialRecords,
  createProviderCredentialRecord,
  splitProviderCredentialFields,
} from "../provider-credentials"

// ── Default implementations ──

export function defaultStartDaemonProcess(socketPath: string): Promise<{ pid: number | null }> {
  const entry = path.join(getRepoRoot(), "dist", "heart", "daemon", "daemon-entry.js")
  // Redirect stdio to /dev/null via file descriptors — using 'ignore' causes EPIPE
  // when the daemon's logging system writes to stderr after the parent exits.
  const outFd = fs.openSync(os.devNull, "w")
  const errFd = fs.openSync(os.devNull, "w")
  const child = spawn("node", [entry, "--socket", socketPath], {
    detached: true,
    stdio: ["ignore", outFd, errFd],
  })
  child.unref()
  // Don't close fds — the child process needs them. They'll be cleaned up when the parent exits.
  return Promise.resolve({ pid: child.pid ?? null })
}

function defaultWriteStdout(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`)
}

/* v8 ignore start -- thin terminal adapter around process stdout @preserve */
function defaultWriteRaw(text: string): void {
  process.stdout.write(text)
}
/* v8 ignore stop */

/**
 * Read the runtimeVersion from the first .ouro bundle's bundle-meta.json.
 * Returns undefined if none found or unreadable.
 */
export function readFirstBundleMetaVersion(bundlesRoot: string): string | undefined {
  try {
    if (!fs.existsSync(bundlesRoot)) return undefined
    const entries = fs.readdirSync(bundlesRoot, { withFileTypes: true })
    for (const entry of entries) {
      /* v8 ignore next -- skip non-.ouro dirs: tested via version-detect tests @preserve */
      if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue
      const metaPath = path.join(bundlesRoot, entry.name, "bundle-meta.json")
      if (!fs.existsSync(metaPath)) continue
      const raw = fs.readFileSync(metaPath, "utf-8")
      const meta = JSON.parse(raw) as { runtimeVersion?: string }
      if (meta.runtimeVersion) return meta.runtimeVersion
    }
  } catch {
    // Best effort — return undefined on any error
  }
  return undefined
}

function defaultCleanupStaleSocket(socketPath: string): void {
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath)
  }
}

function defaultReadHealthUpdatedAt(healthPath: string): number | null {
  try {
    return fs.statSync(healthPath).mtimeMs
  } catch {
    return null
  }
}

function defaultReadRecentDaemonLogLines(lines = 10): string[] {
  const files = discoverLogFiles({})
  const recentLines: string[] = []
  for (const file of files) {
    recentLines.push(...readLastLines(file, lines, fs.readFileSync))
  }
  return recentLines.slice(-lines).map((line) => formatLogLine(line))
}

/* v8 ignore start -- CLI npm registry fetch wrapper: integration code @preserve */
async function defaultFetchCliRegistryJson(timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    const res = await fetch("https://registry.npmjs.org/@ouro.bot/cli", {
      signal: controller.signal,
    })
    return res.json()
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`update check timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}
/* v8 ignore stop */

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultSpawnBackgroundCli(argv: string[]): Promise<{ pid: number | null }> {
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  return Promise.resolve({ pid: child.pid ?? null })
}

function defaultFallbackPendingMessage(command: Extract<import("./daemon").DaemonCommand, { kind: "message.send" }>): string {
  const inboxDir = path.join(getAgentBundlesRoot(), `${command.to}.ouro`, "inbox")
  const pendingPath = path.join(inboxDir, "pending.jsonl")
  const queuedAt = new Date().toISOString()
  const payload = {
    from: command.from,
    to: command.to,
    content: command.content,
    priority: command.priority ?? "normal",
    sessionId: command.sessionId,
    taskRef: command.taskRef,
    queuedAt,
  }
  fs.mkdirSync(inboxDir, { recursive: true })
  fs.appendFileSync(pendingPath, `${JSON.stringify(payload)}\n`, "utf-8")
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.message_fallback_queued",
    message: "queued message to pending fallback file",
    meta: {
      to: command.to,
      path: pendingPath,
      sessionId: command.sessionId ?? null,
      taskRef: command.taskRef ?? null,
    },
  })
  return pendingPath
}

function defaultEnsureDaemonBootPersistence(socketPath: string): void {
  if (process.platform !== "darwin") {
    return
  }

  const homeDir = os.homedir()
  const writeDeps = {
    writeFile: (filePath: string, content: string) => fs.writeFileSync(filePath, content, "utf-8"),
    mkdirp: (dir: string) => fs.mkdirSync(dir, { recursive: true }),
    homeDir,
  }

  const entryPath = path.join(getRepoRoot(), "dist", "heart", "daemon", "daemon-entry.js")

  /* v8 ignore next -- covered via mock in daemon-cli-defaults.test.ts; v8 on CI attributes the real fs.existsSync branch to the non-mock load @preserve */
  if (!fs.existsSync(entryPath)) {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.entry_path_missing",
      message: "entryPath does not exist on disk — plist may point to a stale location. Run 'ouro daemon install' from the correct location.",
      meta: { entryPath },
    })
  }

  const logDir = getAgentDaemonLogsDir()

  // Write plist only — do NOT launchctl bootstrap.
  // The daemon is already running (started by ouro up). Bootstrapping would
  // start a SECOND daemon via launchd's RunAtLoad, causing a race where
  // killOrphanProcesses kills the first daemon and both end up dead.
  // The plist on disk is sufficient: launchd picks it up on login.
  writeLaunchAgentPlist(writeDeps, {
    nodePath: process.execPath,
    entryPath,
    socketPath,
    logDir,
    envPath: process.env.PATH,
  })
}

async function defaultPromptInput(question: string): Promise<string> {
  const readline = await import("readline/promises")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const response = await rl.question(question)
    return response.trim()
  } finally {
    rl.close()
  }
}

async function defaultPromptSecret(question: string): Promise<string> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("vault unlock secret entry requires an interactive terminal so the secret can be hidden. Re-run this command in a terminal and enter the human-chosen secret when prompted.")
  }
  const readline = await import("readline")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  type MutedReadline = import("readline").Interface & {
    _writeToOutput?: (stringToWrite: string) => void
  }
  const mutableRl = rl as MutedReadline
  const originalWriteToOutput = mutableRl._writeToOutput
  let muted = false
  if (originalWriteToOutput) {
    mutableRl._writeToOutput = (stringToWrite: string) => {
      if (!muted) {
        originalWriteToOutput.call(rl, stringToWrite)
      }
    }
  }
  try {
    const response = await new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        process.stdout.write("\n")
        resolve(answer)
      })
      muted = true
    })
    return response.trim()
  } finally {
    if (originalWriteToOutput) {
      mutableRl._writeToOutput = originalWriteToOutput
    }
    rl.close()
  }
}

export function defaultListDiscoveredAgents(): string[] {
  return listEnabledBundleAgents({
    bundlesRoot: getAgentBundlesRoot(),
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
  })
}

// ── Serpent guide (interactive hatch) ──

/* v8 ignore start -- integration: interactive terminal specialist session @preserve */
export async function defaultRunSerpentGuide(): Promise<string | null> {
  const { runCliSession } = await import("../../senses/cli")
  const { setAgentName, setAgentConfigOverride } = await import("../identity")
  const readlinePromises = await import("readline/promises")
  const crypto = await import("crypto")

  // Phase 1: cold CLI — collect provider/credentials with a simple readline
  const coldRl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout })
  const coldPrompt = async (q: string) => {
    const answer = await coldRl.question(q)
    return answer.trim()
  }

  let providerRaw: AgentProvider
  let credentials: HatchCredentialsInput = {}
  let providerConfig: Record<string, string> = {}
  let selectedCredentialPayload: HatchCredentialsInput = {}

  const tempDir = path.join(os.tmpdir(), `ouro-hatch-${crypto.randomUUID()}`)

  try {
    const discovered: DiscoveredCredential[] = []
    const existingBundles = listExistingBundles(getAgentBundlesRoot())
    const existingBundleCount = existingBundles.length
    const hatchVerb = existingBundleCount > 0 ? "let's hatch a new agent." : "let's hatch your first agent."

    // Default models per provider (used when entering new credentials)
    const defaultModels = DEFAULT_PROVIDER_MODELS

    const { pingProvider } = await import("../provider-ping")

    const installedAgentCreds = await discoverInstalledAgentCredentials(existingBundles)
    for (const cred of installedAgentCreds) {
      discovered.push({
        ...cred,
        providerConfig: { model: defaultModels[cred.provider], ...cred.providerConfig },
      })
    }

    // Scan environment variables for API keys using the shared helper
    const envCreds = scanEnvVarCredentials(process.env)
    const envDiscovered: Array<DiscoveredCredential & { envVar: string }> = []
    for (const cred of envCreds) {
      // Enrich with default model and first matching env var name (for display)
      const desc = PROVIDER_CREDENTIALS[cred.provider]
      const firstEnvVar = Object.entries(desc.envVars).find(([envVar]) => process.env[envVar])?.[0] ?? ""
      const provCfg: Record<string, string> = { model: defaultModels[cred.provider], ...cred.providerConfig }
      if (cred.provider === "azure" && (cred.credentials as Record<string, string>).deployment) provCfg.deployment = (cred.credentials as Record<string, string>).deployment
      const enriched = { ...cred, providerConfig: provCfg }
      envDiscovered.push({ ...enriched, envVar: firstEnvVar })
      discovered.push(enriched)
    }

    let welcomed = false
    while (true) {
      if (!welcomed) {
        process.stdout.write(`\n\ud83d\udc0d welcome to ouroboros! ${hatchVerb}\n`)
        welcomed = true
      }

      if (discovered.length > 0) {
        process.stdout.write("i found existing API credentials:\n\n")
        const credentialOptions = discovered
        for (let i = 0; i < credentialOptions.length; i++) {
          const model = credentialOptions[i].providerConfig.model || credentialOptions[i].providerConfig.deployment || ""
          const modelLabel = model ? `, ${model}` : ""
          const envMatch = envDiscovered.find((e) => e.provider === credentialOptions[i].provider && credentialOptions[i].agentName === "env")
          const sourceLabel = describeDiscoveredCredentialSource(credentialOptions[i], envMatch?.envVar)
          process.stdout.write(`  ${i + 1}. ${credentialOptions[i].provider}${modelLabel} (${sourceLabel})\n`)
        }
        process.stdout.write("\n")
        const choice = await coldPrompt("use one of these? enter number, or 'new' for a different key, or 'q' to cancel: ")
        if (["q", "quit", "cancel"].includes(choice.toLowerCase())) {
          coldRl.close()
          return null
        }

        const idx = parseInt(choice, 10) - 1
        if (idx >= 0 && idx < credentialOptions.length) {
          providerRaw = credentialOptions[idx].provider
          credentials = credentialOptions[idx].credentials
          providerConfig = credentialOptions[idx].providerConfig
        } else {
          const pRaw = await coldPrompt("provider (anthropic/azure/minimax/openai-codex/github-copilot): ")
          if (!isAgentProvider(pRaw)) {
            process.stdout.write("unknown provider. run `ouro hatch` to try again.\n")
            coldRl.close()
            return null
          }
          providerRaw = pRaw
          providerConfig = { model: defaultModels[providerRaw] }
          credentials = await collectRuntimeAuthCredentials(
            { agentName: "SerpentGuide", provider: providerRaw, promptInput: coldPrompt },
            {},
          )
        }
      } else {
        process.stdout.write("i need an API key to power our conversation.\n\n")
        const pRaw = await coldPrompt("provider (anthropic/azure/minimax/openai-codex/github-copilot): ")
        if (!isAgentProvider(pRaw)) {
          process.stdout.write("unknown provider. run `ouro hatch` to try again.\n")
          coldRl.close()
          return null
        }
        providerRaw = pRaw
        providerConfig = { model: defaultModels[providerRaw] }
        credentials = await collectRuntimeAuthCredentials(
          { agentName: "SerpentGuide", provider: providerRaw, promptInput: coldPrompt },
          {},
        )
      }

      selectedCredentialPayload = { ...providerConfig, ...credentials } as HatchCredentialsInput
      const pingResult = await pingProvider(
        providerRaw,
        selectedCredentialPayload as Parameters<typeof pingProvider>[1],
      )
      if (pingResult.ok) {
        break
      }

      process.stdout.write(`credentials didn't work (${pingResult.message}). `)
      if (discovered.length > 0) {
        process.stdout.write("choose another saved credential or enter 'new'.\n\n")
      } else {
        process.stdout.write("let's try again.\n\n")
      }
    }

    coldRl.close()
    process.stdout.write("\n")

    const split = splitProviderCredentialFields(providerRaw, selectedCredentialPayload as Record<string, unknown>)
    cacheProviderCredentialRecords("SerpentGuide", [
      createProviderCredentialRecord({
        provider: providerRaw,
        credentials: split.credentials,
        config: split.config,
        provenance: { source: "manual" },
      }),
    ])

    // Phase 2: configure runtime for serpent guide
    const bundleSourceDir = path.resolve(__dirname, "..", "..", "..", "SerpentGuide.ouro")
    const bundlesRoot = getAgentBundlesRoot()

    // Suppress non-critical log noise during hatch.
    const { setRuntimeLogger } = await import("../../nerves/runtime")
    const { createLogger } = await import("../../nerves")
    setRuntimeLogger(createLogger({ level: "error" }))

    // Configure runtime: set agent identity + config override so runAgent
    // doesn't try to read from ~/AgentBundles/SerpentGuide.ouro/. (As of
    // Layer 3, SerpentGuide identities live in-repo only — the
    // `~/AgentBundles/SerpentGuide.ouro/psyche/identities` override path
    // was removed. The override path is no longer read or honored.)
    setAgentName("SerpentGuide")
    // Build specialist system prompt
    const soulText = loadSoulText(bundleSourceDir)
    const identitiesDir = path.join(bundleSourceDir, "psyche", "identities")
    const identity = pickRandomIdentity(identitiesDir)

    // Load identity-specific spinner phrases (falls back to DEFAULT_AGENT_PHRASES)
    const { loadIdentityPhrases } = await import("../hatch/specialist-orchestrator")
    const phrases = loadIdentityPhrases(bundleSourceDir, identity.fileName)

    const resolvedModel = providerConfig.model || providerConfig.deployment || ""
    setAgentConfigOverride({
      version: 2,
      enabled: true,
      provider: providerRaw,
      humanFacing: { provider: providerRaw, model: resolvedModel },
      agentFacing: { provider: providerRaw, model: resolvedModel },
      phrases,
    })
    const systemPrompt = buildSpecialistSystemPrompt(soulText, identity.content, existingBundles, {
      tempDir,
      provider: providerRaw,
      model: providerConfig.model ?? "",
    })

    // Build specialist tools
    const specialistTools = getSpecialistTools()
    const specialistExecTool = createSpecialistExecTool({
      tempDir,
      credentials: selectedCredentialPayload,
      provider: providerRaw,
      bundlesRoot,
      animationWriter: (text: string) => process.stdout.write(text),
      promptSecret: defaultPromptSecret,
    })

    // Run the serpent guide session via runCliSession
    const result = await runCliSession({
      agentName: "SerpentGuide",
      tools: specialistTools,
      execTool: specialistExecTool,
      exitOnToolCall: "complete_adoption",
      autoFirstTurn: true,
      banner: false,
      disableCommands: true,
      skipSystemPromptRefresh: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "hi" },
      ],
    })

    if (result.exitReason === "tool_exit" && result.toolResult) {
      const parsed = typeof result.toolResult === "string" ? JSON.parse(result.toolResult) : result.toolResult
      if (parsed.success && parsed.agentName) {
        return parsed.agentName as string
      }
    }

    return null
  } catch (err) {
    process.stderr.write(`\nouro hatch error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    coldRl.close()
    return null
  } finally {
    // Clear specialist config/identity so the hatched agent gets its own
    setAgentConfigOverride(null)
    const { resetProviderRuntime } = await import("../core")
    resetProviderRuntime()
    const { resetConfigCache } = await import("../config")
    resetConfigCache()
    // Restore default logging
    const { setRuntimeLogger: restoreLogger } = await import("../../nerves/runtime")
    restoreLogger(null)

    // Clean up temp dir if it still exists
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch {
      // Best effort cleanup
    }
  }
}
/* v8 ignore stop */

// ── Factory ──

export function createDefaultOuroCliDeps(socketPath = DEFAULT_DAEMON_SOCKET_PATH): OuroCliDeps {
  return {
    socketPath,
    sendCommand: sendDaemonCommand,
    startDaemonProcess: defaultStartDaemonProcess,
    writeStdout: defaultWriteStdout,
    setExitCode: (code: number) => {
      const current = typeof process.exitCode === "number" ? process.exitCode : 0
      process.exitCode = Math.max(current, code)
    },
    writeRaw: defaultWriteRaw,
    isTTY: process.stdout.isTTY === true,
    checkSocketAlive: checkDaemonSocketAlive,
    cleanupStaleSocket: defaultCleanupStaleSocket,
    fallbackPendingMessage: defaultFallbackPendingMessage,
    tailLogs: (options) => defaultTailLogs(options),
    healthFilePath: getDefaultHealthPath(),
    readHealthState: readHealth,
    readHealthUpdatedAt: defaultReadHealthUpdatedAt,
    readRecentDaemonLogLines: defaultReadRecentDaemonLogLines,
    sleep: defaultSleep,
    spawnBackgroundCli: defaultSpawnBackgroundCli,
    now: () => Date.now(),
    updateCheckTimeoutMs: CLI_UPDATE_CHECK_TIMEOUT_MS,
    startupPollIntervalMs: 250,
    startupStabilityWindowMs: 1_500,
    startupTimeoutMs: 60_000,
    startupRetryLimit: 1,
    listDiscoveredAgents: defaultListDiscoveredAgents,
    runHatchFlow: defaultRunHatchFlow,
    promptInput: defaultPromptInput,
    promptSecret: defaultPromptSecret,
    runSerpentGuide: defaultRunSerpentGuide,
    runAuthFlow: defaultRunRuntimeAuthFlow,
    registerOuroBundleType: defaultRegisterOuroBundleUti,
    installOuroCommand: defaultInstallOuroCommand,
    /* v8 ignore start -- self-healing: ensures active symlink matches running runtime version @preserve */
    ensureCurrentVersionInstalled: () => {
      const linkedVersion = getCurrentVersion({})
      const version = getPackageVersion()
      if (linkedVersion === version) return
      ensureLayout({})
      const cliHome = getOuroCliHome()
      const versionEntry = path.join(cliHome, "versions", version, "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon", "ouro-entry.js")
      if (!fs.existsSync(versionEntry)) {
        installVersion(version, {})
      }
      activateVersion(version, {})
      // Self-prune: every successful version activation cleans up old
      // versions outside the retention window. Without this, every CLI
      // version ever installed accumulates indefinitely under
      // ~/.ouro-cli/versions/ — the user observed installs going back to
      // alpha.85 from March 20 (~100MB of dead node_modules trees).
      // pruneOldVersions keeps the 5 most recent + the active + the
      // previous version, so rollback stays one command away.
      pruneOldVersions(undefined, {})
    },
    /* v8 ignore stop */
    /* v8 ignore start -- CLI version management defaults: integration code @preserve */
    checkForCliUpdate: async () => {
      const { checkForUpdate } = await import("../versioning/update-checker")
      return checkForUpdate(getPackageVersion(), {
        fetchRegistryJson: () => defaultFetchCliRegistryJson(CLI_UPDATE_CHECK_TIMEOUT_MS),
        distTag: "latest",
      })
    },
    installCliVersion: async (version: string) => { installVersion(version, {}) },
    activateCliVersion: (version: string) => {
      activateVersion(version, {})
      // Same self-prune as ensureCurrentVersionInstalled — fires from the
      // checkForCliUpdate path 1 (in-process update detected → activate
      // → re-exec). Without this, the path 1 code path never triggers
      // a prune.
      pruneOldVersions(undefined, {})
    },
    getCurrentCliVersion: () => getCurrentVersion({}),
    getPreviousCliVersion: () => getPreviousVersion({}),
    listCliVersions: () => listInstalledVersions({}),
    reExecFromNewVersion: (reArgs: string[]) => {
      const entry = path.join(getOuroCliHome(), "CurrentVersion", "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon", "ouro-entry.js")
      require("child_process").execFileSync("node", [entry, ...reArgs], { stdio: "inherit" })
      process.exit(0)
    },
    /* v8 ignore stop */
    syncGlobalOuroBotWrapper: defaultSyncGlobalOuroBotWrapper,
    pruneDaemonLogs: defaultPruneDaemonLogs,
    ensureSkillManagement: defaultEnsureSkillManagement,
    ensureDaemonBootPersistence: defaultEnsureDaemonBootPersistence,
    /* v8 ignore start -- dev-mode defaults: tests inject mocks for mode detection and binary resolution @preserve */
    detectMode: () => detectRuntimeMode(getRepoRoot()),
    getInstalledBinaryPath: () => {
      const cliHome = getOuroCliHome()
      const binaryPath = path.join(cliHome, "bin", "ouro")
      return fs.existsSync(binaryPath) ? binaryPath : null
    },
    execInstalledBinary: (binaryPath: string, binArgs: string[]) => {
      const { execFileSync } = require("child_process") as typeof import("child_process")
      execFileSync(binaryPath, binArgs, { stdio: "inherit" })
      process.exit(0)
    },
    /* v8 ignore stop */
    /* v8 ignore next 3 -- integration: launches interactive CLI session @preserve */
    startChat: async (agentName: string) => {
      const { main } = await import("../../senses/cli")
      await main(agentName)
    },
    scanSessions: async (agentName: string) => {
      const agentRoot = getAgentRoot(agentName)
      return listSessionActivity({
        sessionsDir: path.join(agentRoot, "state", "sessions"),
        friendsDir: path.join(agentRoot, "friends"),
        agentName,
      }).map((entry) => ({
        friendId: entry.friendId,
        friendName: entry.friendName,
        channel: entry.channel,
        lastActivity: entry.lastActivityAt,
      }))
    },
  }
}
