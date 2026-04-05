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
import { getAgentBundlesRoot, getAgentDaemonLogsDir, getAgentName, getAgentRoot, getRepoRoot, PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { installOuroCommand as defaultInstallOuroCommand } from "./ouro-path-installer"
import { registerOuroBundleUti as defaultRegisterOuroBundleUti } from "./ouro-uti"
import { getCurrentVersion, getPreviousVersion, listInstalledVersions, installVersion, activateVersion, ensureLayout, getOuroCliHome } from "./ouro-version-manager"
import { ensureSkillManagement as defaultEnsureSkillManagement } from "./skill-management-installer"
import {
  runHatchFlow as defaultRunHatchFlow,
  type HatchCredentialsInput,
} from "./hatch-flow"
import {
  listExistingBundles,
  loadSoulText,
  pickRandomIdentity,
} from "./specialist-orchestrator"
import { buildSpecialistSystemPrompt } from "./specialist-prompt"
import { getSpecialistTools, createSpecialistExecTool } from "./specialist-tools"
import { detectRuntimeMode } from "./runtime-mode"
import { listEnabledBundleAgents } from "./agent-discovery"
import { getPackageVersion } from "../../mind/bundle-manifest"
import { syncGlobalOuroBotWrapper as defaultSyncGlobalOuroBotWrapper } from "./ouro-bot-global-installer"
import { writeLaunchAgentPlist } from "./launchd"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand, checkDaemonSocketAlive } from "./socket-client"
import { listSessionActivity } from "../session-activity"
import {
  runRuntimeAuthFlow as defaultRunRuntimeAuthFlow,
  collectRuntimeAuthCredentials,
} from "./auth-flow"
import { isAgentProvider } from "./cli-parse"
import type { OuroCliDeps, DiscoveredCredential } from "./cli-types"

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
  // eslint-disable-next-line no-console -- terminal UX: CLI command output
  console.log(text)
}

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

export function defaultListDiscoveredAgents(): string[] {
  return listEnabledBundleAgents({
    bundlesRoot: getAgentBundlesRoot(),
    readdirSync: fs.readdirSync,
    readFileSync: fs.readFileSync,
  })
}

// ── Credential discovery ──

export function discoverExistingCredentials(secretsRoot: string): DiscoveredCredential[] {
  const found: DiscoveredCredential[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(secretsRoot, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const secretsPath = path.join(secretsRoot, entry.name, "secrets.json")
    let raw: string
    try {
      raw = fs.readFileSync(secretsPath, "utf-8")
    } catch {
      continue
    }
    let parsed: { providers?: Record<string, Record<string, string>> }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch {
      continue
    }
    if (!parsed.providers) continue

    for (const [provName, provConfig] of Object.entries(parsed.providers)) {
      const desc = PROVIDER_CREDENTIALS[provName as AgentProvider]
      /* v8 ignore next -- guard: unknown provider names in stored secrets @preserve */
      if (!desc) continue
      const hasRequired = desc.required.every((key) => !!provConfig[key])
      if (hasRequired) {
        const credentials: Record<string, string> = {}
        for (const key of Object.keys(provConfig)) credentials[key] = provConfig[key]
        found.push({ agentName: entry.name, provider: provName as AgentProvider, credentials, providerConfig: { ...provConfig } })
      }
    }
  }

  // Deduplicate by provider+credential value (keep first seen)
  const seen = new Set<string>()
  return found.filter((cred) => {
    const key = `${cred.provider}:${JSON.stringify(cred.credentials)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── Serpent guide (interactive hatch) ──

/* v8 ignore start -- integration: interactive terminal specialist session @preserve */
export async function defaultRunSerpentGuide(): Promise<string | null> {
  const { runCliSession } = await import("../../senses/cli")
  const { patchRuntimeConfig } = await import("../config")
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

  const tempDir = path.join(os.tmpdir(), `ouro-hatch-${crypto.randomUUID()}`)

  try {
    const secretsRoot = path.join(os.homedir(), ".agentsecrets")
    const discovered = discoverExistingCredentials(secretsRoot)
    const existingBundleCount = listExistingBundles(getAgentBundlesRoot()).length
    const hatchVerb = existingBundleCount > 0 ? "let's hatch a new agent." : "let's hatch your first agent."

    // Default models per provider (used when entering new credentials)
    const defaultModels: Record<AgentProvider, string> = {
      anthropic: "claude-opus-4-6",
      minimax: "MiniMax-M2.7",
      "openai-codex": "gpt-5.4",
      "github-copilot": "claude-sonnet-4.6",
      azure: "",
    }

    // Scan environment variables for API keys using the canonical descriptor
    const envDiscovered: Array<DiscoveredCredential & { envVar: string }> = []
    for (const [provider, desc] of Object.entries(PROVIDER_CREDENTIALS) as Array<[AgentProvider, typeof PROVIDER_CREDENTIALS[AgentProvider]]>) {
      const envCred: HatchCredentialsInput = {}
      let firstEnvVar: string | undefined
      for (const [envVar, credKey] of Object.entries(desc.envVars)) {
        const value = process.env[envVar]
        if (value) {
          ;(envCred as Record<string, string>)[credKey] = value
          if (!firstEnvVar) firstEnvVar = envVar
        }
      }
      // Only register if at least one required field was found
      const hasRequired = desc.required.some((key) => !!(envCred as Record<string, string>)[key])
      if (hasRequired && firstEnvVar) {
        const provCfg: Record<string, string> = { model: defaultModels[provider] }
        if (provider === "azure" && envCred.deployment) provCfg.deployment = envCred.deployment
        envDiscovered.push({ provider, agentName: "env", credentials: envCred, providerConfig: provCfg, envVar: firstEnvVar })
        discovered.push({ provider, agentName: "env", credentials: envCred, providerConfig: provCfg })
      }
    }

    if (discovered.length > 0) {
      process.stdout.write(`\n\ud83d\udc0d welcome to ouroboros! ${hatchVerb}\n`)
      process.stdout.write("i found existing API credentials:\n\n")
      const unique = [...new Map(discovered.map((d) => [`${d.provider}`, d])).values()]
      for (let i = 0; i < unique.length; i++) {
        const model = unique[i].providerConfig.model || unique[i].providerConfig.deployment || ""
        const modelLabel = model ? `, ${model}` : ""
        const envMatch = envDiscovered.find((e) => e.provider === unique[i].provider && unique[i].agentName === "env")
        const sourceLabel = envMatch ? `from env: $${envMatch.envVar}` : `from ${unique[i].agentName}`
        process.stdout.write(`  ${i + 1}. ${unique[i].provider}${modelLabel} (${sourceLabel})\n`)
      }
      process.stdout.write("\n")
      const choice = await coldPrompt("use one of these? enter number, or 'new' for a different key: ")

      const idx = parseInt(choice, 10) - 1
      if (idx >= 0 && idx < unique.length) {
        providerRaw = unique[idx].provider
        credentials = unique[idx].credentials
        providerConfig = unique[idx].providerConfig
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
      process.stdout.write(`\n\ud83d\udc0d welcome to ouroboros! ${hatchVerb}\n`)
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

    coldRl.close()
    process.stdout.write("\n")

    // Phase 2: configure runtime for serpent guide
    const bundleSourceDir = path.resolve(__dirname, "..", "..", "..", "SerpentGuide.ouro")
    const bundlesRoot = getAgentBundlesRoot()
    const secretsRoot2 = path.join(os.homedir(), ".agentsecrets")

    // Suppress non-critical log noise during hatch (no secrets.json, etc.)
    const { setRuntimeLogger } = await import("../../nerves/runtime")
    const { createLogger } = await import("../../nerves")
    setRuntimeLogger(createLogger({ level: "error" }))

    // Configure runtime: set agent identity + config override so runAgent
    // doesn't try to read from ~/AgentBundles/SerpentGuide.ouro/
    setAgentName("SerpentGuide")
    // Build specialist system prompt
    const soulText = loadSoulText(bundleSourceDir)
    const identitiesDir = path.join(bundleSourceDir, "psyche", "identities")
    const identity = pickRandomIdentity(identitiesDir)

    // Load identity-specific spinner phrases (falls back to DEFAULT_AGENT_PHRASES)
    const { loadIdentityPhrases } = await import("./specialist-orchestrator")
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
    patchRuntimeConfig({
      providers: {
        [providerRaw]: { ...providerConfig, ...credentials },
      },
    })

    // Ping-verify credentials before entering the serpent guide session
    const { pingProvider } = await import("../provider-ping")
    const pingResult = await pingProvider(
      providerRaw,
      { ...providerConfig, ...credentials } as Parameters<typeof pingProvider>[1],
    )
    if (!pingResult.ok) {
      process.stdout.write(`credentials didn't work (${pingResult.message}). run 'ouro hatch' to try again.\n`)
      return null
    }

    const existingBundles = listExistingBundles(bundlesRoot)
    const systemPrompt = buildSpecialistSystemPrompt(soulText, identity.content, existingBundles, {
      tempDir,
      provider: providerRaw,
      model: providerConfig.model ?? "",
    })

    // Build specialist tools
    const specialistTools = getSpecialistTools()
    const specialistExecTool = createSpecialistExecTool({
      tempDir,
      credentials,
      provider: providerRaw,
      bundlesRoot,
      secretsRoot: secretsRoot2,
      animationWriter: (text: string) => process.stdout.write(text),
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
    checkSocketAlive: checkDaemonSocketAlive,
    cleanupStaleSocket: defaultCleanupStaleSocket,
    fallbackPendingMessage: defaultFallbackPendingMessage,
    listDiscoveredAgents: defaultListDiscoveredAgents,
    runHatchFlow: defaultRunHatchFlow,
    promptInput: defaultPromptInput,
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
    },
    /* v8 ignore stop */
    /* v8 ignore start -- CLI version management defaults: integration code @preserve */
    checkForCliUpdate: async () => {
      const { checkForUpdate } = await import("./update-checker")
      return checkForUpdate(getPackageVersion(), {
        fetchRegistryJson: async () => {
          const res = await fetch("https://registry.npmjs.org/@ouro.bot/cli")
          return res.json()
        },
        distTag: "alpha",
      })
    },
    installCliVersion: async (version: string) => { installVersion(version, {}) },
    activateCliVersion: (version: string) => { activateVersion(version, {}) },
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
    scanSessions: async () => {
      const agentName = getAgentName()
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
