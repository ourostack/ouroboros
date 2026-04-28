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
import { refreshMachineRuntimeCredentialConfig, refreshRuntimeCredentialConfig } from "../runtime-credentials"
import { loadOrCreateMachineIdentity } from "../machine-identity"

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

function hasStringRecordValue(value: unknown): boolean {
  const record = asRecord(value)
  return !!record && Object.values(record).some((entry) => typeof entry === "string" && entry.trim().length > 0)
}

function mailAutonomyDetail(mailroom: Record<string, unknown> | null): string {
  const policy = asRecord(mailroom?.autonomousSendPolicy)
  const autonomy = policy?.enabled === true ? "autonomy enabled" : "autonomy disabled"
  const killSwitch = policy?.killSwitch === true ? "kill switch on" : "kill switch off"
  return `${autonomy}; ${killSwitch}`
}

const SENSITIVE_CONFIG_KEYS = ["apiKey", "token", "secret", "password"]

function credentialKeyLeaks(raw: string): string[] {
  return SENSITIVE_CONFIG_KEYS.filter((key) => raw.includes(`"${key}"`))
}

function checkCredentialLeak(checks: DoctorCheck[], label: string, raw: string): void {
  const found = credentialKeyLeaks(raw)
  if (found.length > 0) {
    checks.push({ label, status: "warn", detail: `contains credential-looking keys: ${found.join(", ")}` })
  } else {
    checks.push({ label, status: "pass", detail: "no credential keys" })
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
    const senseNames = ["cli", "teams", "bluebubbles", "mail"]
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
        const machineId = loadOrCreateMachineIdentity({ homeDir: deps.homedir }).machineId
        const runtimeConfig = await refreshMachineRuntimeCredentialConfig(agentName, machineId, { preserveCachedOnFailure: true })
        if (!runtimeConfig.ok) {
          if (runtimeConfig.reason === "missing") {
            checks.push({
              label: `${agentDir} bluebubbles config`,
              status: "pass",
              detail: "not attached on this machine",
            })
            continue
          }
          checks.push({
            label: `${agentDir} bluebubbles config`,
            status: "fail",
            detail: `machine runtime config unavailable: ${runtimeConfig.error}`,
          })
          continue
        }

        const bluebubbles = asRecord(runtimeConfig.config.bluebubbles)
        const bluebubblesChannel = asRecord(runtimeConfig.config.bluebubblesChannel)
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

      if (sense === "mail" && senseObj.enabled === true) {
        const runtimeConfig = await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true })
        if (!runtimeConfig.ok) {
          checks.push({
            label: `${agentDir} mail config`,
            status: "fail",
            detail: `runtime config unavailable: ${runtimeConfig.error}`,
          })
          continue
        }

        const mailroom = asRecord(runtimeConfig.config.mailroom)
        const workSubstrate = asRecord(runtimeConfig.config.workSubstrate)
        const mailboxAddress = textField(mailroom, "mailboxAddress")
        const hosted = textField(workSubstrate, "mode") === "hosted"
        const azureAccountUrl = textField(mailroom, "azureAccountUrl")
        const azureContainer = textField(mailroom, "azureContainer") || "mailroom"
        const missing: string[] = []
        if (!mailboxAddress) missing.push("mailroom.mailboxAddress")
        if (!hasStringRecordValue(mailroom?.privateKeys)) missing.push("mailroom.privateKeys")
        if (hosted && !azureAccountUrl) missing.push("mailroom.azureAccountUrl for hosted Blob reader")

        if (missing.length > 0) {
          checks.push({
            label: `${agentDir} mail config`,
            status: "fail",
            detail: `missing ${missing.join("/")}`,
          })
          continue
        }

        checks.push({
          label: `${agentDir} mail config`,
          status: "pass",
          detail: [
            mailboxAddress,
            hosted ? `hosted azure-blob ${azureAccountUrl}/${azureContainer}` : "local file Mailroom",
            mailAutonomyDetail(mailroom),
          ].join("; "),
        })
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
    // Check agent.json for leaked credential keys
    const configPath = `${deps.bundlesRoot}/${agentDir}/agent.json`
    if (deps.existsSync(configPath)) {
      try {
        const raw = deps.readFileSync(configPath)
        const found = credentialKeyLeaks(raw)
        if (found.length > 0) {
          checks.push({ label: `${agentDir} credential leak`, status: "warn", detail: `agent.json contains keys: ${found.join(", ")}` })
        } else {
          checks.push({ label: `${agentDir} credential leak`, status: "pass", detail: "no credential keys in agent.json" })
        }
      } catch {
        checks.push({ label: `${agentDir} credential leak`, status: "fail", detail: "could not read agent.json" })
      }
    }

    const providerStatePath = `${deps.bundlesRoot}/${agentDir}/state/providers.json`
    if (deps.existsSync(providerStatePath)) {
      try {
        checkCredentialLeak(checks, `${agentDir} state/providers.json credential leak`, deps.readFileSync(providerStatePath))
      } catch {
        checks.push({ label: `${agentDir} state/providers.json credential leak`, status: "fail", detail: "could not read state/providers.json" })
      }
    }
  }

  if (checks.length === 0) {
    checks.push({ label: "security", status: "warn", detail: "no agents found" })
  }

  return { name: "Security", checks }
}

export function checkTrips(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []
  const agents = discoverAgents(deps)

  if (agents.length === 0) {
    checks.push({ label: "trip ledger", status: "warn", detail: "no agent bundles found" })
    return { name: "Trips", checks }
  }

  for (const agentDir of agents) {
    const tripsRootPath = `${deps.bundlesRoot}/${agentDir}/state/trips`
    if (!deps.existsSync(tripsRootPath)) {
      // Trip ledger is optional; absence is fine. Pass with a hint.
      checks.push({ label: `${agentDir} trip ledger`, status: "pass", detail: "no ledger directory (no trips ensured yet)" })
      continue
    }
    const ledgerPath = `${tripsRootPath}/ledger.json`
    if (!deps.existsSync(ledgerPath)) {
      checks.push({ label: `${agentDir} trip ledger`, status: "warn", detail: "state/trips/ exists but ledger.json missing — run trip_ensure_ledger" })
      continue
    }
    let raw: string
    /* v8 ignore start -- defensive: readFileSync failure after existsSync passes is a race-condition fallback @preserve */
    try {
      raw = deps.readFileSync(ledgerPath)
    } catch {
      checks.push({ label: `${agentDir} trip ledger`, status: "fail", detail: "ledger.json could not be read" })
      continue
    }
    /* v8 ignore stop */
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      checks.push({ label: `${agentDir} trip ledger`, status: "fail", detail: "ledger.json is not valid JSON" })
      continue
    }
    const ledgerId = typeof parsed.ledgerId === "string" ? parsed.ledgerId : null
    const hasPrivateKey = typeof parsed.privateKeyPem === "string" && parsed.privateKeyPem.includes("BEGIN")
    if (!ledgerId) {
      checks.push({ label: `${agentDir} trip ledger`, status: "warn", detail: "ledger.json missing ledgerId field" })
      continue
    }
    if (!hasPrivateKey) {
      checks.push({ label: `${agentDir} trip ledger`, status: "fail", detail: `${ledgerId}: privateKeyPem missing — encrypted trip records cannot be read` })
      continue
    }
    let recordCount = 0
    const recordsDir = `${tripsRootPath}/records`
    /* v8 ignore start -- defensive: records dir presence and readdir error are filesystem-state branches not all exercised by tests; pluralization branch likewise depends on record count fixtures @preserve */
    if (deps.existsSync(recordsDir)) {
      try {
        recordCount = deps.readdirSync(recordsDir).filter((name) => name.endsWith(".json")).length
      } catch {
        // ignore — the warn detail will still report 0 records
      }
    }
    checks.push({
      label: `${agentDir} trip ledger`,
      status: "pass",
      detail: `${ledgerId} (${recordCount} record${recordCount === 1 ? "" : "s"})`,
    })
    /* v8 ignore stop */
  }

  return { name: "Trips", checks }
}

export function checkMailroom(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []
  const agents = discoverAgents(deps)

  if (agents.length === 0) {
    checks.push({ label: "mailroom", status: "warn", detail: "no agent bundles found" })
    return { name: "Mailroom", checks }
  }

  for (const agentDir of agents) {
    const mailroomRoot = `${deps.bundlesRoot}/${agentDir}/state/mailroom`
    if (!deps.existsSync(mailroomRoot)) {
      checks.push({ label: `${agentDir} mailroom`, status: "pass", detail: "no mailroom directory (mail not connected)" })
      continue
    }
    const registryPath = `${mailroomRoot}/registry.json`
    if (!deps.existsSync(registryPath)) {
      checks.push({ label: `${agentDir} mailroom`, status: "warn", detail: "state/mailroom/ exists but registry.json missing" })
      continue
    }
    let raw: string
    /* v8 ignore start -- defensive: readFileSync failure after existsSync passes is a race-condition fallback @preserve */
    try {
      raw = deps.readFileSync(registryPath)
    } catch {
      checks.push({ label: `${agentDir} mailroom`, status: "fail", detail: "registry.json could not be read" })
      continue
    }
    /* v8 ignore stop */
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      checks.push({ label: `${agentDir} mailroom`, status: "fail", detail: "registry.json is not valid JSON" })
      continue
    }
    /* v8 ignore start -- defensive: registry shape is validated by mailroom code; non-array fallbacks are belt-and-suspenders @preserve */
    const mailboxes = Array.isArray(parsed.mailboxes) ? parsed.mailboxes : null
    const sourceGrants = Array.isArray(parsed.sourceGrants) ? parsed.sourceGrants : []
    /* v8 ignore stop */
    if (!mailboxes || mailboxes.length === 0) {
      checks.push({ label: `${agentDir} mailroom`, status: "warn", detail: "registry.json has no mailboxes — provision via `ouro connect mail`" })
      continue
    }
    let messagesCount = 0
    const messagesDir = `${mailroomRoot}/messages`
    /* v8 ignore start -- defensive: messages-dir presence + readdir error + pluralization branches depend on filesystem-state fixtures not exhaustively covered @preserve */
    if (deps.existsSync(messagesDir)) {
      try {
        messagesCount = deps.readdirSync(messagesDir).filter((name) => name.endsWith(".json")).length
      } catch {
        // ignore — pass detail just won't include the message count
      }
    }
    checks.push({
      label: `${agentDir} mailroom`,
      status: "pass",
      detail: `${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"}, ${sourceGrants.length} source grant${sourceGrants.length === 1 ? "" : "s"}, ${messagesCount} message${messagesCount === 1 ? "" : "s"}`,
    })
    /* v8 ignore stop */
  }

  return { name: "Mailroom", checks }
}

export function checkDisk(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []

  const addLogSizeCheck = (labelPrefix: string, logsDir: string): void => {
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
      checks.push({ label: `${labelPrefix} daemon log size`, status: "fail", detail: `${sizeMB.toFixed(1)}MB — exceeds 500MB limit` })
    } else if (sizeMB > 100) {
      checks.push({ label: `${labelPrefix} daemon log size`, status: "warn", detail: `${sizeMB.toFixed(1)}MB — consider pruning with \`ouro logs prune\`` })
    } else {
      checks.push({ label: `${labelPrefix} daemon log size`, status: "pass", detail: `${sizeMB.toFixed(1)}MB` })
    }
  }

  const agents = discoverAgents(deps)
  if (agents.length === 0) {
    checks.push({ label: "daemon logs dir", status: "warn", detail: "no agent bundles found for bundle-local logs" })
  }

  for (const agentDir of agents) {
    const logsDir = `${deps.bundlesRoot}/${agentDir}/state/daemon/logs`
    if (!deps.existsSync(logsDir)) {
      checks.push({ label: `${agentDir} daemon logs dir`, status: "warn", detail: `${logsDir} not found` })
    } else {
      addLogSizeCheck(agentDir, logsDir)
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

/**
 * Recent daemon lifecycle: surfaces last activity timestamp, recent restarts,
 * version-install events, and process errors from the last hour. Designed
 * to answer the operator's question after the daemon has gone silent: "did
 * it crash? when did it last do anything? did it just upgrade?"
 *
 * Reads daemon.ndjson from the first available agent bundle (one daemon
 * serves all agents, so any agent's bundle has the shared log).
 */
export function checkLifecycle(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []
  const HOUR_MS = 60 * 60 * 1000
  const STALE_THRESHOLD_MS = 5 * 60 * 1000
  const cutoff = Date.now() - HOUR_MS

  const agents = discoverAgents(deps)
  let logPath: string | null = null
  for (const agentDir of agents) {
    const candidate = `${deps.bundlesRoot}/${agentDir}/state/daemon/logs/daemon.ndjson`
    if (deps.existsSync(candidate)) {
      logPath = candidate
      break
    }
  }

  if (!logPath) {
    checks.push({ label: "daemon log readable", status: "warn", detail: "no daemon.ndjson found in any agent bundle" })
    return { name: "Lifecycle", checks }
  }

  let lastTs: string | null = null
  let lastEvent: string | null = null
  let startCount = 0
  let installCount = 0
  let installVersions: string[] = []
  let processErrors: string[] = []
  let lastEntryAgeMs = Number.POSITIVE_INFINITY

  try {
    // Read the whole log via deps.readFileSync, then take the tail. For a
    // chatty daemon this can be a few MB; we only inspect the last 5000
    // lines which is enough for the last hour of activity. If the file is
    // small (typical case), reading it all is cheap.
    const raw = deps.readFileSync(logPath)
    const allLines = raw.split("\n").filter((l) => l.trim())
    const usable = allLines.length > 5000 ? allLines.slice(-5000) : allLines
    for (const line of usable) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const ts = typeof parsed.ts === "string" ? parsed.ts : null
      const event = typeof parsed.event === "string" ? parsed.event : null
      if (!ts || !event) continue
      const tsMs = Date.parse(ts)
      if (Number.isNaN(tsMs)) continue
      lastTs = ts
      lastEvent = event
      lastEntryAgeMs = Math.min(lastEntryAgeMs, Date.now() - tsMs)
      if (tsMs < cutoff) continue
      if (event === "daemon.daemon_started") startCount++
      if (event === "daemon.cli_version_install_end") {
        installCount++
        const meta = parsed.meta as Record<string, unknown> | undefined
        const ver = typeof meta?.version === "string" ? meta.version : null
        if (ver) installVersions.push(ver)
      }
      if (event === "daemon.agent_process_error") {
        const meta = parsed.meta as Record<string, unknown> | undefined
        const reason = typeof meta?.reason === "string" ? meta.reason : "unknown"
        const agent = typeof meta?.agent === "string" ? meta.agent : "unknown"
        processErrors.push(`${agent}: ${reason}`)
      }
    }
  } catch (error) {
    checks.push({ label: "daemon log readable", status: "fail", detail: `read failed: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from deps.readFileSync (always Error) @preserve */ String(error)}` })
    return { name: "Lifecycle", checks }
  }

  if (lastTs === null) {
    checks.push({ label: "recent daemon activity", status: "warn", detail: "no parseable events in tail of daemon.ndjson" })
  } else {
    const ageSec = Math.round(lastEntryAgeMs / 1000)
    const ageDetail = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`
    if (lastEntryAgeMs > STALE_THRESHOLD_MS) {
      checks.push({
        label: "recent daemon activity",
        status: "warn",
        detail: `last event ${ageDetail} (${lastEvent}) — daemon may be silent or stopped`,
      })
    } else {
      checks.push({
        label: "recent daemon activity",
        status: "pass",
        detail: `last event ${ageDetail} (${lastEvent})`,
      })
    }
  }

  if (startCount > 0) {
    checks.push({
      label: "daemon restarts (last hour)",
      status: startCount > 3 ? "warn" : "pass",
      detail: `${startCount} restart${startCount === 1 ? "" : "s"}${startCount > 3 ? " — high churn, investigate" : ""}`,
    })
  }

  if (installCount > 0) {
    checks.push({
      label: "version installs (last hour)",
      status: "pass",
      detail: `installed: ${installVersions.join(", ")}`,
    })
  }

  if (processErrors.length > 0) {
    checks.push({
      label: "agent process errors (last hour)",
      status: "warn",
      detail: `${processErrors.length} error${processErrors.length === 1 ? "" : "s"}: ${processErrors.slice(0, 3).join("; ")}${processErrors.length > 3 ? "..." : ""}`,
    })
  }

  return { name: "Lifecycle", checks }
}

type CategoryChecker = (deps: DoctorDeps) => DoctorCategory | Promise<DoctorCategory>

const CATEGORY_CHECKERS: Array<{ name: string; fn: CategoryChecker }> = [
  { name: "CLI", fn: checkCliPath },
  { name: "Daemon", fn: checkDaemon },
  { name: "Lifecycle", fn: checkLifecycle },
  { name: "Agents", fn: checkAgents },
  { name: "Senses", fn: checkSenses },
  { name: "Habits", fn: checkHabits },
  { name: "Security", fn: checkSecurity },
  { name: "Trips", fn: checkTrips },
  { name: "Mailroom", fn: checkMailroom },
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
