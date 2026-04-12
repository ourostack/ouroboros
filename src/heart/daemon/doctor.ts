/**
 * System health check ("ouro doctor") — runs all diagnostic categories
 * and aggregates results into a structured DoctorResult.
 *
 * Each category checker is isolated: if one throws, it produces a single
 * "fail" check and the remaining categories still run.
 */

import type {
  DoctorCategory,
  DoctorCheck,
  DoctorDeps,
  DoctorResult,
  DoctorSummary,
} from "./doctor-types"
import { emitNervesEvent } from "../../nerves/runtime"
import { probeBlueBubblesHealth } from "./bluebubbles-health-diagnostics"
import { diagnoseOuroPath } from "../versioning/ouro-path-installer"

const DEFAULT_BLUEBUBBLES_REQUEST_TIMEOUT_MS = 30_000

// ── Category checkers ──

export function checkCliPath(deps: DoctorDeps): DoctorCategory {
  const resolution = diagnoseOuroPath({
    homeDir: deps.homedir,
    envPath: deps.envPath ?? "",
    existsSync: deps.existsSync,
    readFileSync: (p) => deps.readFileSync(p),
  })

  const status = resolution.status === "ok"
    ? "pass"
    : resolution.status === "shadowed"
      ? "fail"
      : "warn"

  return {
    name: "CLI",
    checks: [{
      label: "ouro PATH resolution",
      status,
      detail: resolution.remediation
        ? `${resolution.detail}; fix: ${resolution.remediation}`
        : resolution.detail,
    }],
  }
}

export async function checkDaemon(deps: DoctorDeps): Promise<DoctorCategory> {
  const checks: DoctorCheck[] = []

  const socketExists = deps.existsSync(deps.socketPath)
  checks.push({
    label: "daemon socket exists",
    status: socketExists ? "pass" : "fail",
    detail: socketExists ? deps.socketPath : `not found at ${deps.socketPath}`,
  })

  if (socketExists) {
    const alive = await deps.checkSocketAlive(deps.socketPath)
    checks.push({
      label: "daemon is responsive",
      status: alive ? "pass" : "fail",
      detail: alive ? "socket responded" : "socket exists but daemon unresponsive",
    })
  } else {
    checks.push({
      label: "daemon is responsive",
      status: "fail",
      detail: "skipped — socket missing",
    })
  }

  return { name: "Daemon", checks }
}

/** Discover all *.ouro directories under bundlesRoot. */
function discoverAgents(deps: DoctorDeps): string[] {
  if (!deps.existsSync(deps.bundlesRoot)) return []
  return deps.readdirSync(deps.bundlesRoot).filter((name) => name.endsWith(".ouro"))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function textField(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function numberField(record: Record<string, unknown> | null | undefined, key: string, fallback: number): number {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function readJsonObject(deps: DoctorDeps, filePath: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(deps.readFileSync(filePath)) as unknown)
  } catch {
    return null
  }
}

export function checkAgents(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []

  if (!deps.existsSync(deps.bundlesRoot)) {
    checks.push({ label: "bundles directory", status: "fail", detail: `${deps.bundlesRoot} not found` })
    return { name: "Agents", checks }
  }

  const agents = discoverAgents(deps)
  if (agents.length === 0) {
    checks.push({ label: "agent bundles", status: "warn", detail: "no *.ouro bundles found" })
    return { name: "Agents", checks }
  }

  for (const agentDir of agents) {
    const agentPath = `${deps.bundlesRoot}/${agentDir}`
    const configPath = `${agentPath}/agent.json`

    if (!deps.existsSync(configPath)) {
      checks.push({ label: `${agentDir}/agent.json`, status: "fail", detail: "missing" })
      continue
    }

    let config: Record<string, unknown>
    try {
      config = JSON.parse(deps.readFileSync(configPath)) as Record<string, unknown>
    } catch {
      checks.push({ label: `${agentDir}/agent.json`, status: "fail", detail: "unparseable JSON" })
      continue
    }

    const missing: string[] = []
    if (!config.version) missing.push("version")
    if (!config.humanFacing || typeof config.humanFacing !== "object") {
      missing.push("humanFacing")
    } else {
      const hf = config.humanFacing as Record<string, unknown>
      if (!hf.provider) missing.push("humanFacing.provider")
      if (!hf.model) missing.push("humanFacing.model")
    }
    if (!config.agentFacing || typeof config.agentFacing !== "object") {
      missing.push("agentFacing")
    } else {
      const af = config.agentFacing as Record<string, unknown>
      if (!af.provider) missing.push("agentFacing.provider")
      if (!af.model) missing.push("agentFacing.model")
    }

    if (missing.length > 0) {
      checks.push({ label: `${agentDir}/agent.json`, status: "warn", detail: `missing fields: ${missing.join(", ")}` })
    } else {
      checks.push({ label: `${agentDir}/agent.json`, status: "pass", detail: "valid" })
    }
  }

  return { name: "Agents", checks }
}

export async function checkSenses(deps: DoctorDeps): Promise<DoctorCategory> {
  const checks: DoctorCheck[] = []
  const agents = discoverAgents(deps)

  for (const agentDir of agents) {
    const agentName = agentDir.replace(/\.ouro$/, "")
    const configPath = `${deps.bundlesRoot}/${agentDir}/agent.json`
    if (!deps.existsSync(configPath)) continue

    let config: Record<string, unknown>
    try {
      config = JSON.parse(deps.readFileSync(configPath)) as Record<string, unknown>
    } catch {
      checks.push({ label: `${agentDir} senses`, status: "fail", detail: "agent.json unparseable" })
      continue
    }

    if (!config.senses || typeof config.senses !== "object") {
      checks.push({ label: `${agentDir} senses`, status: "warn", detail: "no senses config block" })
      continue
    }

    const senses = config.senses as Record<string, unknown>
    const senseNames = ["cli", "teams", "bluebubbles"]
    for (const sense of senseNames) {
      if (!(sense in senses)) continue
      const entry = senses[sense]
      if (!entry || typeof entry !== "object") {
        checks.push({ label: `${agentDir} ${sense}`, status: "fail", detail: "malformed sense entry" })
        continue
      }
      const senseObj = entry as Record<string, unknown>
      if (typeof senseObj.enabled !== "boolean") {
        checks.push({ label: `${agentDir} ${sense}`, status: "warn", detail: "missing enabled boolean" })
      } else {
        checks.push({
          label: `${agentDir} ${sense}`,
          status: "pass",
          detail: senseObj.enabled ? "enabled" : "disabled",
        })
      }

      if (sense === "bluebubbles" && senseObj.enabled === true) {
        const secretsPath = `${deps.secretsRoot}/${agentName}/secrets.json`
        if (!deps.existsSync(secretsPath)) {
          checks.push({
            label: `${agentDir} bluebubbles config`,
            status: "fail",
            detail: "missing secrets.json",
          })
          continue
        }

        const secrets = readJsonObject(deps, secretsPath)
        if (!secrets) {
          checks.push({
            label: `${agentDir} bluebubbles config`,
            status: "fail",
            detail: "secrets.json unparseable",
          })
          continue
        }

        const bluebubbles = asRecord(secrets.bluebubbles)
        const bluebubblesChannel = asRecord(secrets.bluebubblesChannel)
        const serverUrl = textField(bluebubbles, "serverUrl")
        const password = textField(bluebubbles, "password")
        const missing: string[] = []
        if (!serverUrl) missing.push("bluebubbles.serverUrl")
        if (!password) missing.push("bluebubbles.password")

        if (missing.length > 0) {
          checks.push({
            label: `${agentDir} bluebubbles config`,
            status: "fail",
            detail: `missing ${missing.join("/")}`,
          })
          continue
        }

        checks.push({
          label: `${agentDir} bluebubbles config`,
          status: "pass",
          detail: serverUrl,
        })

        if (deps.fetchImpl) {
          const probe = await probeBlueBubblesHealth({
            serverUrl,
            password,
            requestTimeoutMs: numberField(bluebubblesChannel, "requestTimeoutMs", DEFAULT_BLUEBUBBLES_REQUEST_TIMEOUT_MS),
            fetchImpl: deps.fetchImpl,
          })
          checks.push({
            label: `${agentDir} bluebubbles upstream`,
            status: probe.ok ? "pass" : "fail",
            detail: probe.detail,
          })
        }
      }
    }
  }

  if (checks.length === 0) {
    checks.push({ label: "senses", status: "warn", detail: "no agents with senses config found" })
  }

  return { name: "Senses", checks }
}

export function checkHabits(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []
  const agents = discoverAgents(deps)

  for (const agentDir of agents) {
    const agentName = agentDir.replace(/\.ouro$/, "")
    const habitsDir = `${deps.bundlesRoot}/${agentDir}/habits`

    if (!deps.existsSync(habitsDir)) {
      checks.push({ label: `${agentDir} habits dir`, status: "warn", detail: "no habits directory" })
      continue
    }

    checks.push({ label: `${agentDir} habits dir`, status: "pass", detail: habitsDir })

    // Check for launchd plists on macOS
    const launchAgentsDir = `${deps.homedir}/Library/LaunchAgents`
    if (deps.existsSync(launchAgentsDir)) {
      const plists = deps.readdirSync(launchAgentsDir).filter(
        (f) => f.startsWith(`bot.ouro.${agentName}.`) && f.endsWith(".plist"),
      )
      if (plists.length > 0) {
        checks.push({ label: `${agentDir} launchd plists`, status: "pass", detail: `${plists.length} plist(s)` })
      } else {
        checks.push({ label: `${agentDir} launchd plists`, status: "fail", detail: "no matching plists in LaunchAgents" })
      }
    }
  }

  if (checks.length === 0) {
    checks.push({ label: "habits", status: "warn", detail: "no agents found" })
  }

  return { name: "Habits", checks }
}

export function checkSecurity(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []
  const agents = discoverAgents(deps)

  for (const agentDir of agents) {
    const agentName = agentDir.replace(/\.ouro$/, "")
    const secretsPath = `${deps.secretsRoot}/${agentName}/secrets.json`

    if (!deps.existsSync(secretsPath)) {
      checks.push({ label: `${agentDir} secrets.json`, status: "fail", detail: "missing" })
      continue
    }

    // Check file permissions
    const stat = deps.statSync(secretsPath)
    const worldReadable = (stat.mode & 0o004) !== 0
    if (worldReadable) {
      checks.push({ label: `${agentDir} secrets.json perms`, status: "warn", detail: "world-readable — consider chmod 600" })
    } else {
      checks.push({ label: `${agentDir} secrets.json perms`, status: "pass", detail: "not world-readable" })
    }

    // Check agent.json for leaked credential keys
    const configPath = `${deps.bundlesRoot}/${agentDir}/agent.json`
    if (deps.existsSync(configPath)) {
      try {
        const raw = deps.readFileSync(configPath)
        const sensitiveKeys = ["apiKey", "token", "secret", "password"]
        const found = sensitiveKeys.filter((key) => raw.includes(`"${key}"`))
        if (found.length > 0) {
          checks.push({ label: `${agentDir} credential leak`, status: "warn", detail: `agent.json contains keys: ${found.join(", ")}` })
        } else {
          checks.push({ label: `${agentDir} credential leak`, status: "pass", detail: "no credential keys in agent.json" })
        }
      } catch {
        checks.push({ label: `${agentDir} credential leak`, status: "fail", detail: "could not read agent.json" })
      }
    }
  }

  if (checks.length === 0) {
    checks.push({ label: "security", status: "warn", detail: "no agents found" })
  }

  return { name: "Security", checks }
}

export function checkDisk(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []

  // Check daemon logs directory
  const logsDir = `${deps.homedir}/.ouro-cli/logs`
  if (!deps.existsSync(logsDir)) {
    checks.push({ label: "daemon logs dir", status: "warn", detail: `${logsDir} not found` })
  } else {
    let totalSize = 0
    try {
      const files = deps.readdirSync(logsDir)
      for (const file of files) {
        try {
          const stat = deps.statSync(`${logsDir}/${file}`)
          totalSize += stat.size
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // readdirSync failure handled below
    }

    const sizeMB = totalSize / (1024 * 1024)
    if (sizeMB > 500) {
      checks.push({ label: "daemon log size", status: "fail", detail: `${sizeMB.toFixed(1)}MB — exceeds 500MB limit` })
    } else if (sizeMB > 100) {
      checks.push({ label: "daemon log size", status: "warn", detail: `${sizeMB.toFixed(1)}MB — consider pruning with \`ouro logs prune\`` })
    } else {
      checks.push({ label: "daemon log size", status: "pass", detail: `${sizeMB.toFixed(1)}MB` })
    }
  }

  // Check AgentBundles root
  if (deps.existsSync(deps.bundlesRoot)) {
    checks.push({ label: "bundles root", status: "pass", detail: deps.bundlesRoot })
  } else {
    checks.push({ label: "bundles root", status: "warn", detail: `${deps.bundlesRoot} not found` })
  }

  return { name: "Disk", checks }
}

// ── Orchestrator ──

function computeSummary(categories: DoctorCategory[]): DoctorSummary {
  let passed = 0
  let warnings = 0
  let failed = 0
  for (const cat of categories) {
    for (const check of cat.checks) {
      /* v8 ignore next 3 -- all three branches tested; v8 misreports compound if/else-if chain @preserve */
      if (check.status === "pass") passed++
      else if (check.status === "warn") warnings++
      else failed++
    }
  }
  return { passed, warnings, failed }
}

type CategoryChecker = (deps: DoctorDeps) => DoctorCategory | Promise<DoctorCategory>

const CATEGORY_CHECKERS: Array<{ name: string; fn: CategoryChecker }> = [
  { name: "CLI", fn: checkCliPath },
  { name: "Daemon", fn: checkDaemon },
  { name: "Agents", fn: checkAgents },
  { name: "Senses", fn: checkSenses },
  { name: "Habits", fn: checkHabits },
  { name: "Security", fn: checkSecurity },
  { name: "Disk", fn: checkDisk },
]

export async function runDoctorChecks(deps: DoctorDeps): Promise<DoctorResult> {
  const categories: DoctorCategory[] = []

  for (const checker of CATEGORY_CHECKERS) {
    try {
      const category = await Promise.resolve(checker.fn(deps))
      categories.push(category)
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.doctor_check_error",
        message: `doctor check ${checker.name} failed`,
        meta: { category: checker.name, error: error instanceof Error ? error.message : String(error) },
      })
      categories.push({
        name: checker.name,
        checks: [{
          label: checker.name.toLowerCase(),
          status: "fail",
          detail: `check crashed: ${error instanceof Error ? error.message : String(error)}`,
        }],
      })
    }
  }

  return { categories, summary: computeSummary(categories) }
}
