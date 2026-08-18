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
import { inspectBlueBubblesWebhookRegistration } from "../../senses/bluebubbles/webhook-registration"
import {
  evaluateFreshness,
  observeAppendPerEventStore,
  observeCreatePerEventStore,
  observeMirroredStore,
  resolveFreshnessThresholds,
  FRESHNESS_DAY_MS,
  FRESHNESS_HOUR_MS,
  type FreshnessProbe,
  type FreshnessResult,
  type FreshnessThresholds,
} from "./freshness"
import type { BlueBubblesHealthProbeResult } from "./bluebubbles-health-diagnostics"
import type { BlueBubblesWebhookRegistrationState } from "../../senses/bluebubbles/webhook-registration"
import { diagnoseOuroPath } from "../versioning/ouro-path-installer"
import { refreshMachineRuntimeCredentialConfig, refreshRuntimeCredentialConfig } from "../runtime-credentials"
import { loadOrCreateMachineIdentity } from "../machine-identity"
import { createDegradedHabitFile, parseHabitFile, type HabitFile } from "../habits/habit-parser"
import { parseCadenceToCron } from "./cadence"
import { DEFAULT_MAX_LOG_SIZE_BYTES } from "../../nerves"
import { readRsvpConfig, validateRsvpReadiness, type RsvpNativeConfig, type RsvpReadinessCheck } from "../../rsvp/config"
import { checkRsvpCutover, type RsvpCutoverChecks } from "../../rsvp/cutover"
import { collectRsvpDiagnostics, type RsvpDiagnosticStatus } from "../../rsvp/diagnostics"

const DEFAULT_BLUEBUBBLES_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_BLUEBUBBLES_PORT = 18_790
const DEFAULT_BLUEBUBBLES_WEBHOOK_PATH = "/bluebubbles-webhook"

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

/** Discover doctor candidates: *.ouro directories with a present agent.json. */
function discoverAgents(deps: DoctorDeps): string[] {
  if (!deps.existsSync(deps.bundlesRoot)) return []
  return deps.readdirSync(deps.bundlesRoot).filter((name) =>
    name.endsWith(".ouro") && deps.existsSync(`${deps.bundlesRoot}/${name}/agent.json`),
  )
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

function stringArrayField(record: Record<string, unknown> | null | undefined, key: string): string[] {
  const value = record?.[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
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

// ── Pipeline liveness (dead-pipe detection) ──
//
// Configuration checks answer "is this wired up?". These answer "is anything
// actually flowing?". Both are needed: the 77-day mail outage and the
// multi-day BlueBubbles inbound outage were both invisible to configuration
// and connection checks that stayed green throughout.

/**
 * Mail ingest thresholds.
 *
 * A delegated mailbox forwards a human's real inbox, so a full calendar day
 * with zero inbound mail is already anomalous — that is the warn line. Fail
 * waits until 72h so a genuinely quiet weekend on a low-traffic mailbox does
 * not hard-fail doctor; the 2026-05-10 outage would have failed on day four
 * instead of going unnoticed for seventy-seven. Override per agent with
 * `senses.mail.freshness.{warnAfterHours,failAfterHours}` in `agent.json`.
 */
export const DEFAULT_MAIL_INGEST_THRESHOLDS: FreshnessThresholds = {
  warnAfterMs: 24 * FRESHNESS_HOUR_MS,
  failAfterMs: 72 * FRESHNESS_HOUR_MS,
}

/**
 * Inbound sense-delivery thresholds.
 *
 * Human-driven chat surfaces are bursty — nobody texts an agent every day —
 * so the warn line sits at 72h and failure waits a full week. Seven days
 * without a single inbound message on an attached chat sense is not plausible
 * quiet; it is a dead pipe. Override per agent with
 * `senses.<sense>.freshness.{warnAfterHours,failAfterHours}` in `agent.json`.
 */
export const DEFAULT_SENSE_DELIVERY_THRESHOLDS: FreshnessThresholds = {
  warnAfterMs: 72 * FRESHNESS_HOUR_MS,
  failAfterMs: 7 * FRESHNESS_DAY_MS,
}

/** Hard bound on how many per-conversation inbound logs a sense probe stats. */
const SENSE_DELIVERY_MAX_LOG_SCAN = 500

interface PipelineLivenessInput {
  id: string
  label: string
  /** Verb phrase for the flow, e.g. "mail ingested". */
  activity: string
  /** Noun for one unit of flow, e.g. "message". */
  unit: string
  probe: FreshnessProbe
  thresholds: FreshnessThresholds
  remediation: string
  nowMs: number
  configuredSinceMs?: number | null
  context?: string
}

function pipelineLivenessCheck(input: PipelineLivenessInput): DoctorCheck {
  const result = evaluateFreshness({
    activity: input.activity,
    unit: input.unit,
    observation: input.probe.observation,
    provenance: input.probe.provenance,
    nowMs: input.nowMs,
    thresholds: input.thresholds,
    remediation: input.remediation,
    configuredSinceMs: input.configuredSinceMs,
    context: input.context,
  })
  return { id: input.id, label: input.label, status: result.status, detail: result.detail }
}

/** Best-effort mtime used as a "this pipe has been wired up since" floor. */
function pathMtimeMs(deps: DoctorDeps, filePath: string): number | null {
  if (!deps.existsSync(filePath)) return null
  try {
    return deps.statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

/** Read `senses.<sense>.freshness` from `agent.json`, if present. */
function senseFreshnessOverride(deps: DoctorDeps, agentDir: string, sense: string): unknown {
  const configPath = `${deps.bundlesRoot}/${agentDir}/agent.json`
  if (!deps.existsSync(configPath)) return null
  try {
    const config = JSON.parse(deps.readFileSync(configPath)) as Record<string, unknown>
    return asRecord(asRecord(config.senses)?.[sense])?.freshness ?? null
  } catch {
    return null
  }
}

export interface SenseInboundDeliveryInput {
  deps: DoctorDeps
  /** Bundle directory name, e.g. `slugger.ouro`. */
  agentDir: string
  /** Sense key as it appears under `senses` in `agent.json`. */
  sense: string
  /** Directory of append-per-event inbound logs, one file per conversation. */
  inboundDir: string
  /** Suffix identifying an inbound log file. */
  logSuffix?: string
  /** Path whose mtime bounds "this sense has been attached since". */
  configuredSincePath?: string
  /** Sense-specific, actionable fix. */
  remediation: string
  /** Contrast line — typically the state of the sense's upstream probe. */
  context?: string
  nowMs: number
}

/**
 * Inbound-delivery liveness for a sense that records what it received.
 *
 * This asserts on the *inbound* log, deliberately not on the upstream health
 * probe: BlueBubbles reported `upstreamStatus: ok` for days while inbound
 * delivery was dead because the server was POSTing to a stale webhook port.
 * A sense opts in by calling this with its inbound log directory.
 */
export function senseInboundDeliveryCheck(input: SenseInboundDeliveryInput): DoctorCheck {
  const result = senseInboundDeliveryResult(input)
  return { id: `senses.${input.sense}.inbound_liveness`, label: `${input.agentDir} ${input.sense} inbound delivery`, status: result.status, detail: result.detail }
}

function senseInboundDeliveryResult(input: SenseInboundDeliveryInput): FreshnessResult {
  const suffix = input.logSuffix ?? ".ndjson"
  const probe = observeAppendPerEventStore(input.inboundDir, input.deps, { suffix, maxEntries: SENSE_DELIVERY_MAX_LOG_SCAN })
  return evaluateFreshness({
    activity: `${input.sense} inbound delivery`,
    unit: "inbound message",
    observation: probe.observation,
    provenance: probe.provenance,
    thresholds: resolveFreshnessThresholds(
      DEFAULT_SENSE_DELIVERY_THRESHOLDS,
      senseFreshnessOverride(input.deps, input.agentDir, input.sense),
    ),
    remediation: input.remediation,
    configuredSinceMs: input.configuredSincePath ? pathMtimeMs(input.deps, input.configuredSincePath) : null,
    context: input.context,
    nowMs: input.nowMs,
  })
}

type BlueBubblesInfrastructureEvidence = {
  upstream: "healthy" | "definitive-fault" | "unavailable" | "not-run"
  webhook: BlueBubblesWebhookRegistrationState | null
}

function blueBubblesUpstreamEvidence(probe: BlueBubblesHealthProbeResult): BlueBubblesInfrastructureEvidence["upstream"] {
  if (probe.ok) return "healthy"
  if (probe.classification === "auth-failure" || probe.classification === "rate-limit" || probe.classification === "server-error" || probe.classification === "usage-limit") {
    return "definitive-fault"
  }
  return "unavailable"
}

function blueBubblesInboundDeliveryCheck(
  input: SenseInboundDeliveryInput,
  evidence: BlueBubblesInfrastructureEvidence,
): DoctorCheck {
  const result = senseInboundDeliveryResult(input)
  const base = {
    id: "senses.bluebubbles.inbound_liveness",
    label: `${input.agentDir} bluebubbles inbound delivery`,
  }
  if (result.state !== "stale" && result.state !== "never") {
    return { ...base, status: result.status, detail: result.detail }
  }

  const webhookDefinitive = evidence.webhook === "missing"
    || evidence.webhook === "drifted"
    || evidence.webhook === "auth-failed"
    || evidence.webhook === "malformed"
    || evidence.webhook === "listener-not-ready"
  if (evidence.upstream === "definitive-fault" || webhookDefinitive) {
    const corroboration = evidence.webhook === "missing"
      ? "missing owned webhook corroborates the silence"
      : evidence.webhook && webhookDefinitive
        ? `${evidence.webhook} owned-webhook evidence corroborates the silence`
        : "a definitive upstream fault corroborates the silence"
    return { ...base, status: "fail", detail: `${corroboration}; ${result.detail}` }
  }

  const orientation = evidence.upstream === "healthy" && evidence.webhook === "exact"
    ? "no recent inbound was observed; upstream and exact owned webhook are healthy"
    : evidence.upstream === "not-run"
      ? "no recent inbound was observed; infrastructure probes were not run, so delivery is unverified"
      : "no recent inbound was observed; infrastructure probes were unavailable, so delivery is unverified"
  const observed = result.detail.replace(/; fix: .*$/u, "")
  return {
    ...base,
    status: "warn",
    detail: `${orientation}; quiet and delivery failure are indistinguishable without a new message; doctor did not send a test message; ${observed}`,
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
    checks.push({ label: "agent bundles", status: "warn", detail: "no agent bundles found" })
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

/**
 * Mail key coverage, as recorded by the mail sense.
 *
 * Doctor reads the sense's own per-cycle verdict rather than re-deriving it:
 * a health check must need neither network access nor Azure credentials, and
 * the registry that declares the key ids lives in a Blob container in hosted
 * mode. The mail sense already fetches it every cycle, so its record is both
 * the cheapest and the only honest source here.
 *
 * Absent is a `fail` because mail encrypted to a key with no private half is
 * permanently unreadable — unlike an API key, ciphertext cannot be reissued.
 * Anything the sense could not verify is a `warn`, never a `fail`: a locked or
 * unavailable vault must not read as key loss.
 */
function mailKeyCoverageCheck(deps: DoctorDeps, agentDir: string): DoctorCheck {
  const id = "mail.key_coverage"
  const label = `${agentDir} mail key coverage`
  const statePath = `${deps.bundlesRoot}/${agentDir}/state/senses/mail/runtime.json`
  const unverified = (detail: string): DoctorCheck => ({ id, label, status: "warn", detail })

  if (!deps.existsSync(statePath)) {
    return unverified(`no mail sense runtime state at ${statePath} — coverage is unverified until the mail sense runs a scan`)
  }
  let coverage: Record<string, unknown>
  try {
    coverage = asRecord((JSON.parse(deps.readFileSync(statePath)) as Record<string, unknown>).keyCoverage) ?? {}
  } catch {
    return unverified(`mail sense runtime state at ${statePath} could not be read`)
  }

  const declaredKeyIds = stringArrayField(coverage, "declaredKeyIds")
  const absentKeyIds = stringArrayField(coverage, "absentKeyIds")
  const checkedAt = textField(coverage, "checkedAt")
  const provenance = checkedAt ? ` (recorded ${checkedAt})` : ""

  if (coverage.status === "covered") {
    return {
      id,
      label,
      status: "pass",
      detail: declaredKeyIds.length === 1
        ? `the 1 registry-declared mail key has a private half in the vault${provenance}`
        : `all ${declaredKeyIds.length} registry-declared mail keys have a private half in the vault${provenance}`,
    }
  }
  if (coverage.status === "absent") {
    return {
      id,
      label,
      status: "fail",
      detail: `the mailroom registry declares mail key${absentKeyIds.length === 1 ? "" : "s"} with no private half in this agent's vault — mail encrypted to ${absentKeyIds.join(", ")} cannot be decrypted and cannot be recovered${provenance}; run \`ouro connect mail --agent ${agentDir.replace(/\.ouro$/, "")}\` and, if Mail Control no longer holds the one-time key, rerun it with --rotate-missing-mail-keys to mint a replacement for future mail`,
    }
  }
  return unverified(`mail sense could not verify key coverage${provenance}: ${textField(coverage, "reason") || "no reason recorded"}`)
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

        let upstreamContext = "upstream probe not run in this pass"
        let infrastructure: BlueBubblesInfrastructureEvidence = { upstream: "not-run", webhook: null }
        if (deps.fetchImpl) {
          const requestTimeoutMs = numberField(bluebubblesChannel, "requestTimeoutMs", DEFAULT_BLUEBUBBLES_REQUEST_TIMEOUT_MS)
          const probe = await probeBlueBubblesHealth({
            serverUrl,
            password,
            requestTimeoutMs,
            fetchImpl: deps.fetchImpl,
          })
          checks.push({
            label: `${agentDir} bluebubbles upstream`,
            status: probe.ok ? "pass" : "fail",
            detail: probe.detail,
          })
          upstreamContext = probe.ok
            ? "upstream probe reachable — which does not prove inbound delivery"
            : "upstream probe failing"
          infrastructure = { ...infrastructure, upstream: blueBubblesUpstreamEvidence(probe) }

          const webhook = await inspectBlueBubblesWebhookRegistration({
            serverUrl,
            password,
            callbackPort: numberField(bluebubblesChannel, "port", DEFAULT_BLUEBUBBLES_PORT),
            callbackPath: textField(bluebubblesChannel, "webhookPath") || DEFAULT_BLUEBUBBLES_WEBHOOK_PATH,
            agentName,
            machineId,
            requestTimeoutMs,
            listenerReady: true,
          }, { fetchImpl: deps.fetchImpl })
          checks.push({
            id: "senses.bluebubbles.webhook",
            label: `${agentDir} bluebubbles webhook`,
            status: webhook.ok ? "pass" : "fail",
            detail: webhook.detail,
          })
          infrastructure = { ...infrastructure, webhook: webhook.state }
        }

        const bluebubblesStateRoot = `${deps.bundlesRoot}/${agentDir}/state/senses/bluebubbles`
        checks.push(blueBubblesInboundDeliveryCheck({
          deps,
          agentDir,
          sense: "bluebubbles",
          inboundDir: `${bluebubblesStateRoot}/inbound`,
          configuredSincePath: bluebubblesStateRoot,
          context: upstreamContext,
          remediation: "no iMessage is reaching this agent — confirm the BlueBubbles server's configured webhook URL/port matches the port this daemon is listening on (a stale webhook port is the known cause), then re-attach with `ouro connect bluebubbles --agent <agent>`",
          nowMs: Date.now(),
        }, infrastructure))
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

        // Config being well-formed says nothing about whether the vault can
        // still decrypt what the registry points mail at — the 2026-07-24 gap
        // sat behind a passing mail config check for 23 hours.
        checks.push(mailKeyCoverageCheck(deps, agentDir))
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

    const activeScheduledHabits: string[] = []
    const habitLifecycleRows: HabitFile[] = []
    let unreadableHabits = 0
    for (const file of deps.readdirSync(habitsDir).filter((entry) => entry.endsWith(".md") && entry !== "README.md").sort()) {
      const filePath = `${habitsDir}/${file}`
      let habit: HabitFile
      try {
        habit = parseHabitFile(deps.readFileSync(filePath), filePath)
      } catch (error) {
        unreadableHabits += 1
        habit = createDegradedHabitFile(
          filePath,
          "read_error",
          "",
          error instanceof Error ? error.message : String(error),
        )
      }
      habitLifecycleRows.push(habit)
      if (habit.status === "active" && habit.cadence && parseCadenceToCron(habit.cadence) !== null) {
        activeScheduledHabits.push(habit.name)
      }
    }

    if (habitLifecycleRows.length > 0) {
      const hasDegradedHabit = habitLifecycleRows.some((habit) => habit.status === "degraded")
      checks.push({
        id: "habits.lifecycle",
        label: `${agentDir} habit lifecycle`,
        status: hasDegradedHabit ? "fail" : "pass",
        detail: habitLifecycleRows.map((habit) => habit.status === "degraded"
          ? `${habit.name}=degraded(${habit.degradedReason})`
          : `${habit.name}=${habit.status}`).join(", "),
      })
    }

    if (unreadableHabits > 0) {
      checks.push({
        label: `${agentDir} habit files`,
        status: "warn",
        detail: `${unreadableHabits} unreadable habit file(s)`,
      })
    }

    if (activeScheduledHabits.length === 0) {
      checks.push({
        label: `${agentDir} launchd plists`,
        status: "pass",
        detail: "no active scheduled habits require launchd",
      })
      continue
    }

    // Check for launchd plists on macOS
    const platform = deps.platform
    if (platform !== "darwin") {
      checks.push({
        label: `${agentDir} launchd plists`,
        status: "pass",
        detail: `launchd not applicable on ${platform}; scheduled habits use the platform cron manager`,
      })
      continue
    }

    const launchAgentsDir = `${deps.homedir}/Library/LaunchAgents`
    if (deps.existsSync(launchAgentsDir)) {
      const plists = new Set(deps.readdirSync(launchAgentsDir))
      const missing = activeScheduledHabits
        .map((habitName) => `bot.ouro.${agentName}.${habitName}.plist`)
        .filter((plistName) => !plists.has(plistName))
      if (missing.length === 0) {
        checks.push({
          label: `${agentDir} launchd plists`,
          status: "pass",
          detail: `${activeScheduledHabits.length} active scheduled habit(s) registered`,
        })
      } else {
        checks.push({
          label: `${agentDir} launchd plists`,
          status: "fail",
          detail: `missing ${missing.join(", ")}`,
        })
      }
    } else {
      checks.push({
        label: `${agentDir} launchd plists`,
        status: "fail",
        detail: `${launchAgentsDir} not found for ${activeScheduledHabits.length} active scheduled habit(s)`,
      })
    }
  }

  if (checks.length === 0) {
    checks.push({ label: "habits", status: "warn", detail: "no agents found" })
  }

  return { name: "Habits", checks }
}

function hasRsvpHabitSignal(deps: DoctorDeps, agentPath: string): boolean {
  const habitsDir = `${agentPath}/habits`
  if (!deps.existsSync(habitsDir)) return false
  try {
    return deps.readdirSync(habitsDir).some((name) => name.toLowerCase().includes("rsvp") && name.endsWith(".md"))
  } catch {
    return false
  }
}

function rsvpDoctorLabel(agentDir: string, checkId: RsvpReadinessCheck["id"]): string {
  const suffix: Record<RsvpReadinessCheck["id"], string> = {
    "rsvp.native_config": "RSVP native config",
    "rsvp.aisleplanner_source": "RSVP AislePlanner source",
    "rsvp.aisleplanner_credentials": "RSVP AislePlanner credentials",
    "rsvp.bluebubbles_route": "RSVP BlueBubbles route",
    "rsvp.bluebubbles_attachment": "RSVP BlueBubbles attachment",
  }
  return `${agentDir} ${suffix[checkId]}`
}

function rsvpDoctorId(checkId: RsvpReadinessCheck["id"]): string {
  const ids: Record<RsvpReadinessCheck["id"], string> = {
    "rsvp.native_config": "rsvp.native_config",
    "rsvp.aisleplanner_source": "rsvp.aisleplanner.source",
    "rsvp.aisleplanner_credentials": "rsvp.aisleplanner.credentials",
    "rsvp.bluebubbles_route": "rsvp.bluebubbles.route",
    "rsvp.bluebubbles_attachment": "rsvp.bluebubbles.attachment",
  }
  return ids[checkId]
}

function rsvpDoctorDetail(readinessCheck: RsvpReadinessCheck): string {
  return readinessCheck.id === "rsvp.bluebubbles_route" && readinessCheck.status === "pass"
    ? "configured"
    : readinessCheck.detail
}

function doctorStatus(status: RsvpDiagnosticStatus): DoctorCheck["status"] {
  return status
}

function discoverRsvpCutoverLegacyRoot(deps: DoctorDeps, config?: RsvpNativeConfig): string | null {
  const configured = typeof config?.cutover?.legacyRoot === "string" ? config.cutover.legacyRoot.trim() : ""
  if (configured) return configured
  if (deps.rsvpCutoverLegacyRoot) return deps.rsvpCutoverLegacyRoot
  const candidate = `${deps.homedir}/Projects/rsvp-tracker`
  return deps.existsSync(`${candidate}/config.json`) ? candidate : null
}

function rsvpCutoverDetail(checks: RsvpCutoverChecks, sendAllowed: boolean, denialCount: number): string {
  return [
    `sendAllowed=${sendAllowed}`,
    `launchAgentInactive=${checks.launchAgentInactive}`,
    `legacyProcessInactive=${checks.legacyProcessInactive}`,
    `legacyConfigSendInactive=${checks.legacyConfigSendInactive}`,
    `legacyLiveSendInactive=${checks.legacyLiveSendInactive}`,
    `nativeBlueBubblesCredentialHealthy=${checks.nativeBlueBubblesCredentialHealthy}`,
    `denialCount=${denialCount}`,
  ].join("; ")
}

export async function checkRsvp(deps: DoctorDeps): Promise<DoctorCategory> {
  const checks: DoctorCheck[] = []
  const agents = discoverAgents(deps)

  if (agents.length === 0) {
    checks.push({ label: "RSVP", status: "warn", detail: "no agent bundles found" })
    return { name: "RSVP", checks }
  }

  for (const agentDir of agents) {
    const agentName = agentDir.replace(/\.ouro$/, "")
    const agentPath = `${deps.bundlesRoot}/${agentDir}`
    const config = readRsvpConfig(agentPath)
    const hasRsvpSignal = config.ok || hasRsvpHabitSignal(deps, agentPath)
    if (!hasRsvpSignal) {
      checks.push({ label: `${agentDir} RSVP`, status: "pass", detail: "not configured" })
      continue
    }

    const machineId = loadOrCreateMachineIdentity({ homeDir: deps.homedir }).machineId
    const runtimeConfig = await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true })
    const machineRuntimeConfig = await refreshMachineRuntimeCredentialConfig(agentName, machineId, { preserveCachedOnFailure: true })
    const readiness = validateRsvpReadiness({
      agent: agentName,
      agentRoot: agentPath,
      runtimeConfig,
      machineRuntimeConfig,
      config,
    })

    for (const readinessCheck of readiness.checks) {
      checks.push({
        id: rsvpDoctorId(readinessCheck.id),
        label: rsvpDoctorLabel(agentDir, readinessCheck.id),
        status: readinessCheck.status === "pass" ? "pass" : "fail",
        detail: rsvpDoctorDetail(readinessCheck),
      })
    }

    const attachment = readiness.checks.find((check) => check.id === "rsvp.bluebubbles_attachment")
    if (attachment) {
      checks.push({
        id: "rsvp.bluebubbles.attachment_identity",
        label: `${agentDir} RSVP BlueBubbles attachment identity`,
        status: attachment.status === "pass" ? "pass" : "fail",
        detail: attachment.status === "pass" ? "machine attachment credential present" : attachment.detail,
      })
    }

    const diagnostics = collectRsvpDiagnostics(agentPath, deps)
    checks.push(
      {
        id: "rsvp.context_packet_ledger",
        label: `${agentDir} RSVP context packet ledger`,
        status: doctorStatus(diagnostics.contextPacketLedger.status),
        detail: diagnostics.contextPacketLedger.detail,
      },
      {
        id: "rsvp.habit.schedule",
        label: `${agentDir} RSVP habit schedule`,
        status: doctorStatus(diagnostics.habitSchedule.status),
        detail: diagnostics.habitSchedule.detail,
      },
      {
        id: "rsvp.latest_fetch",
        label: `${agentDir} RSVP latest fetch`,
        status: doctorStatus(diagnostics.latestFetch.status),
        detail: diagnostics.latestFetch.detail,
      },
      {
        id: "rsvp.delivery.reconciliation",
        label: `${agentDir} RSVP delivery reconciliation`,
        status: doctorStatus(diagnostics.deliveryReconciliation.status),
        detail: diagnostics.deliveryReconciliation.detail,
      },
      {
        id: "rsvp.spend_timeline",
        label: `${agentDir} RSVP spend timeline`,
        status: doctorStatus(diagnostics.spendTimeline.status),
        detail: diagnostics.spendTimeline.detail,
      },
    )

    const legacyRoot = discoverRsvpCutoverLegacyRoot(deps, config.ok ? config.config : undefined)
    if (config.ok && legacyRoot) {
      const cutover = await checkRsvpCutover({
        agent: agentName,
        legacyRoot,
        ...(deps.rsvpCutoverDeps ? { deps: deps.rsvpCutoverDeps } : {}),
      })
      checks.push({
        id: "rsvp.cutover.live_send_preflight",
        label: `${agentDir} RSVP legacy live-send preflight`,
        status: cutover.sendAllowed ? "pass" : "fail",
        detail: rsvpCutoverDetail(cutover.checks, cutover.sendAllowed, cutover.denialReasons.length),
      })
    }
  }

  return { name: "RSVP", checks }
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
    const durableTripsRoot = `${deps.bundlesRoot}/${agentDir}/trips`
    const legacyTripsRoot = `${deps.bundlesRoot}/${agentDir}/state/trips`
    const hasDurableTrips = deps.existsSync(durableTripsRoot)
    const hasLegacyTrips = deps.existsSync(legacyTripsRoot)
    if (!hasDurableTrips) {
      if (hasLegacyTrips) {
        checks.push({
          label: `${agentDir} trip ledger`,
          status: "warn",
          detail: "legacy state/trips exists but durable trips/ missing — run any trip tool to copy legacy storage into trips/",
        })
      } else {
        // Trip ledger is optional; absence is fine. Pass with a hint.
        checks.push({ label: `${agentDir} trip ledger`, status: "pass", detail: "no ledger directory (no trips ensured yet)" })
      }
      continue
    }
    const ledgerPath = `${durableTripsRoot}/ledger.json`
    if (!deps.existsSync(ledgerPath)) {
      checks.push({ label: `${agentDir} trip ledger`, status: "warn", detail: "trips/ exists but ledger.json missing — run trip_ensure_ledger" })
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
    const nestedLedger = parsed.ledger && typeof parsed.ledger === "object"
      ? parsed.ledger as Record<string, unknown>
      : null
    const ledgerId = typeof parsed.ledgerId === "string"
      ? parsed.ledgerId
      : typeof nestedLedger?.ledgerId === "string"
        ? nestedLedger.ledgerId
        : null
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
    const recordsDir = `${durableTripsRoot}/records`
    /* v8 ignore start -- defensive: records dir presence and readdir error are filesystem-state branches not all exercised by tests; pluralization branch likewise depends on record count fixtures @preserve */
    if (deps.existsSync(recordsDir)) {
      try {
        recordCount = deps.readdirSync(recordsDir).filter((name) => name.endsWith(".json")).length
      } catch {
        // ignore — the warn detail will still report 0 records
      }
    }
    const legacyDiverges = hasLegacyTrips && tripStoresDiffer(deps, durableTripsRoot, legacyTripsRoot)
    checks.push({
      label: `${agentDir} trip ledger`,
      status: legacyDiverges ? "warn" : "pass",
      detail: `${ledgerId} (${recordCount} record${recordCount === 1 ? "" : "s"})${legacyDiverges ? "; legacy state/trips differs from durable trips/ — durable trips/ is authoritative" : ""}`,
    })
    /* v8 ignore stop */
  }

  return { name: "Trips", checks }
}

function listTripStoreFiles(deps: DoctorDeps, root: string): string[] {
  const files: string[] = []
  if (deps.existsSync(`${root}/ledger.json`)) {
    files.push("ledger.json")
  }
  const recordsDir = `${root}/records`
  if (deps.existsSync(recordsDir)) {
    for (const name of deps.readdirSync(recordsDir)) {
      if (name.endsWith(".json")) {
        files.push(`records/${name}`)
      }
    }
  }
  return files.sort()
}

function tripStoresDiffer(deps: DoctorDeps, durableRoot: string, legacyRoot: string): boolean {
  const relativePaths = new Set([
    ...listTripStoreFiles(deps, durableRoot),
    ...listTripStoreFiles(deps, legacyRoot),
  ])
  for (const relativePath of relativePaths) {
    const durablePath = `${durableRoot}/${relativePath}`
    const legacyPath = `${legacyRoot}/${relativePath}`
    const durableExists = deps.existsSync(durablePath)
    const legacyExists = deps.existsSync(legacyPath)
    if (durableExists !== legacyExists) {
      return true
    }
    if (durableExists && deps.readFileSync(durablePath) !== deps.readFileSync(legacyPath)) {
      return true
    }
  }
  return false
}

export async function checkMailroom(deps: DoctorDeps): Promise<DoctorCategory> {
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
    const messagesDir = `${mailroomRoot}/messages`
    const listing = listJsonDocuments(deps, messagesDir)
    /* v8 ignore start -- defensive: pluralization branches depend on filesystem-state fixtures not exhaustively covered @preserve */
    checks.push({
      label: `${agentDir} mailroom`,
      status: "pass",
      detail: `${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"}, ${sourceGrants.length} source grant${sourceGrants.length === 1 ? "" : "s"}, ${listing.count} message${listing.count === 1 ? "" : "s"} stored (cumulative — not a liveness signal)`,
    })
    /* v8 ignore stop */
    checks.push(mailIngestLivenessCheck(deps, agentDir, mailroomRoot, messagesDir, listing, await resolveMailStore(agentDir)))
  }

  return { name: "Mailroom", checks }
}

interface JsonDocumentListing {
  count: number
  /** False when the directory exists but could not be listed. */
  readable: boolean
}

function listJsonDocuments(deps: DoctorDeps, dir: string): JsonDocumentListing {
  if (!deps.existsSync(dir)) return { count: 0, readable: true }
  try {
    return { count: deps.readdirSync(dir).filter((name) => name.endsWith(".json")).length, readable: true }
  } catch {
    return { count: 0, readable: false }
  }
}

/**
 * Which Mailroom store this agent's mail actually lands in.
 *
 * Mirrors `mailroom/reader.ts#createMailroomStore`, which switches on
 * `mailroom.azureAccountUrl`: set ⇒ hosted Azure Blob, absent ⇒ local files.
 * `workSubstrate.mode === "hosted"` is the operator-facing name for the same
 * cutover and is what the mail-config check reports, but the reader's own
 * switch is what decides whether anything still writes to the local
 * `state/mailroom/messages` directory — the only question liveness needs
 * answered. A hosted substrate with no `azureAccountUrl` still reads local
 * files, and the mail-config check already fails that config loudly.
 */
type MailStoreResolution =
  | { hosted: false }
  | { hosted: true; label: string }

async function resolveMailStore(agentDir: string): Promise<MailStoreResolution> {
  const agentName = agentDir.replace(/\.ouro$/, "")
  // An unreadable vault means the mode is unknown, so this falls back to the
  // reader's own default — the local file store. `mail config` in checkSenses
  // is where an unavailable runtime config is reported, and it fails hard.
  const runtimeConfig = await refreshRuntimeCredentialConfig(agentName, { preserveCachedOnFailure: true })
  if (!runtimeConfig.ok) return { hosted: false }
  const mailroom = asRecord(runtimeConfig.config.mailroom)
  const azureAccountUrl = textField(mailroom, "azureAccountUrl")
  if (!azureAccountUrl) return { hosted: false }
  const azureContainer = textField(mailroom, "azureContainer") || "mailroom"
  return { hosted: true, label: `hosted azure-blob ${azureAccountUrl}/${azureContainer}` }
}

/**
 * Local-file Mailroom liveness signal.
 *
 * The `messages/` directory mtime is both the cheapest and the most correct
 * option. Cheapest: one stat regardless of store size, and the production store
 * holds ~45k message files. Most correct: a message's `receivedAt` is when the
 * mail was *sent* (an mbox backfill writes month-old values today), so parsing
 * message bodies would answer a different question than "did this machine
 * ingest anything recently?".
 */
function localMailStoreProbe(deps: DoctorDeps, messagesDir: string, listing: JsonDocumentListing): FreshnessProbe {
  if (!listing.readable) {
    return {
      observation: { kind: "unknown", reason: `${messagesDir} exists but could not be listed` },
      provenance: `attempted directory listing of ${messagesDir}`,
    }
  }
  return observeCreatePerEventStore(messagesDir, deps, { hasEntries: listing.count > 0 })
}

/**
 * Hosted Mailroom liveness signal.
 *
 * Once an agent is cut over to the hosted store, messages live in the Blob
 * container and nothing writes to `state/mailroom/messages` any more, so its
 * mtime freezes at the cutover. Reading it in hosted mode is how this check
 * reported "no mail ingested in 77 days" on 2026-07-27 while the container was
 * taking mail that same morning — a false failure, which trains operators to
 * ignore the check and so undoes the reason it exists.
 *
 * The local artifact that does still move is the hosted reader's search cache:
 * `AzureBlobMailroomStore` writes `state/mail-search/<messageId>.json` for
 * every message it decrypts (see `mailroom/reader.ts`, which hands the hosted
 * store that cache directory). Message ids are content hashes, so a *new* file
 * appears exactly when this machine sees a message it has never seen before;
 * re-reading old mail rewrites existing files and leaves the directory mtime
 * untouched. Same create-per-event shape as the local store, same O(1) stat.
 *
 * It is deliberately one step downstream of ingest: it proves hosted mail
 * reached this machine, which is the strongest claim available without network
 * access or Azure credentials — a health check must need neither. The activity
 * wording, provenance and remediation all say so rather than implying doctor
 * measured the container itself, and an empty mirror reports `unknown` rather
 * than the hosted store being empty.
 */
function hostedMailMirrorProbe(deps: DoctorDeps, agentDir: string, storeLabel: string): FreshnessProbe {
  const mirrorDir = `${deps.bundlesRoot}/${agentDir}/state/mail-search`
  const listing = listJsonDocuments(deps, mirrorDir)
  if (!listing.readable) {
    return {
      observation: { kind: "unknown", reason: `${mirrorDir} exists but could not be listed` },
      provenance: `attempted directory listing of ${mirrorDir}`,
    }
  }
  return observeMirroredStore(mirrorDir, deps, { hasEntries: listing.count > 0, remote: storeLabel })
}

/**
 * Mail-ingest liveness — "is mail still arriving?", as opposed to the check
 * above, which only says "is a mailbox configured?".
 *
 * This is the check that would have caught the 2026-05-10 outage: the mailbox,
 * its config, and a cumulative count of 45,479 messages all reported ✔ for 77
 * days while zero mail was ingested.
 *
 * Which signal is honest depends on where the store lives, so the probe, the
 * activity wording and the remediation are all chosen per store kind. Reusing
 * the local path in hosted mode measures a directory nothing writes to.
 */
function mailIngestLivenessCheck(
  deps: DoctorDeps,
  agentDir: string,
  mailroomRoot: string,
  messagesDir: string,
  listing: JsonDocumentListing,
  store: MailStoreResolution,
): DoctorCheck {
  const hosted = store.hosted ? store : null
  const probe = hosted
    ? hostedMailMirrorProbe(deps, agentDir, hosted.label)
    : localMailStoreProbe(deps, messagesDir, listing)

  return pipelineLivenessCheck({
    id: "mail.ingest_liveness",
    label: `${agentDir} mail ingest liveness`,
    activity: hosted ? "hosted mail observed locally" : "mail ingested",
    unit: "message",
    probe,
    thresholds: resolveFreshnessThresholds(
      DEFAULT_MAIL_INGEST_THRESHOLDS,
      senseFreshnessOverride(deps, agentDir, "mail"),
    ),
    remediation: hosted
      ? `doctor measures hosted mail only through this machine's local mirror and makes no network calls — confirm the container itself by listing \`messages/\` blobs in ${hosted.label} by Last-Modified, or read the mailbox directly (\`ouro mailbox\`, or the agent's \`mail_recent\` tool); if the mirror is empty or stale while the container is current, the hosted reader on this machine is not running`
      : "mail is configured but nothing is arriving — re-check the mailbox grant and keyIds against the vault (a server-side key rotation silently orphans ingestion), run `ouro connect mail --agent <agent>`, and inspect the mailroom ingress logs",
    configuredSinceMs: pathMtimeMs(deps, `${mailroomRoot}/registry.json`),
    context: hosted ? `mailbox configured; ${hosted.label}` : "mailbox configured",
    nowMs: Date.now(),
  })
}

export function checkFriends(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []
  const agents = discoverAgents(deps)

  if (agents.length === 0) {
    checks.push({ label: "friends", status: "warn", detail: "no agent bundles found" })
    return { name: "Friends", checks }
  }

  for (const agentDir of agents) {
    const friendsDir = `${deps.bundlesRoot}/${agentDir}/friends`
    if (!deps.existsSync(friendsDir)) {
      checks.push({ label: `${agentDir} friends`, status: "pass", detail: "no friends directory (no friends recorded yet)" })
      continue
    }
    let entries: string[]
    /* v8 ignore start -- defensive: readdirSync failure after existsSync passes is a race-condition fallback @preserve */
    try {
      entries = deps.readdirSync(friendsDir).filter((name) => name.endsWith(".json"))
    } catch {
      checks.push({ label: `${agentDir} friends`, status: "fail", detail: "friends directory could not be read" })
      continue
    }
    /* v8 ignore stop */
    if (entries.length === 0) {
      checks.push({ label: `${agentDir} friends`, status: "pass", detail: "0 friends recorded" })
      continue
    }
    let parseFailures = 0
    let trustFamily = 0
    let trustFriend = 0
    let trustStranger = 0
    let trustOther = 0
    /* v8 ignore start -- per-record trust-level tally branches: tests don't exhaustively combine all four trust buckets in one fixture @preserve */
    for (const name of entries) {
      const filePath = `${friendsDir}/${name}`
      let raw: string
      try {
        raw = deps.readFileSync(filePath)
      } catch {
        parseFailures += 1
        continue
      }
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        parseFailures += 1
        continue
      }
      const trustLevel = typeof parsed.trustLevel === "string" ? parsed.trustLevel : "friend"
      if (trustLevel === "family") trustFamily += 1
      else if (trustLevel === "friend") trustFriend += 1
      else if (trustLevel === "stranger") trustStranger += 1
      else trustOther += 1
    }
    if (parseFailures > 0) {
      checks.push({ label: `${agentDir} friends`, status: "warn", detail: `${entries.length} record${entries.length === 1 ? "" : "s"}, ${parseFailures} unparseable` })
      continue
    }
    const parts = [
      `${entries.length} friend${entries.length === 1 ? "" : "s"}`,
      `${trustFamily} family`,
      `${trustFriend} friend`,
      `${trustStranger} stranger`,
    ]
    if (trustOther > 0) parts.push(`${trustOther} other`)
    checks.push({ label: `${agentDir} friends`, status: "pass", detail: parts.join(", ") })
    /* v8 ignore stop */
  }

  return { name: "Friends", checks }
}

export function checkDisk(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []

  const isActiveLogStream = (name: string): boolean => {
    if (name.endsWith(".ndjson")) return !/\.\d+\.ndjson$/.test(name)
    if (name.endsWith(".log")) return !/\.\d+\.log$/.test(name)
    return false
  }

  const addLogSizeCheck = (labelPrefix: string, logsDir: string): void => {
    let totalSize = 0
    let activeSize = 0
    const oversizedActive: string[] = []
    try {
      const files = deps.readdirSync(logsDir)
      for (const file of files) {
        try {
          const stat = deps.statSync(`${logsDir}/${file}`)
          totalSize += stat.size
          if (isActiveLogStream(file)) {
            activeSize += stat.size
            if (stat.size >= DEFAULT_MAX_LOG_SIZE_BYTES) {
              oversizedActive.push(file)
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // readdirSync failure handled below
    }

    const sizeMB = totalSize / (1024 * 1024)
    const activeSizeMB = activeSize / (1024 * 1024)
    if (activeSizeMB > 500) {
      checks.push({ label: `${labelPrefix} daemon log size`, status: "fail", detail: `${activeSizeMB.toFixed(1)}MB active / ${sizeMB.toFixed(1)}MB total — active logs exceed 500MB limit` })
    } else if (oversizedActive.length > 0) {
      checks.push({
        label: `${labelPrefix} daemon log size`,
        status: "warn",
        detail: `${activeSizeMB.toFixed(1)}MB active / ${sizeMB.toFixed(1)}MB total; active stream(s) over ${Math.round(DEFAULT_MAX_LOG_SIZE_BYTES / (1024 * 1024))}MB: ${oversizedActive.join(", ")} — run \`ouro logs prune\``,
      })
    } else {
      checks.push({ label: `${labelPrefix} daemon log size`, status: "pass", detail: `${activeSizeMB.toFixed(1)}MB active / ${sizeMB.toFixed(1)}MB total` })
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
 * Reads the machine-local daemon.ndjson when available, plus any
 * bundle-local copies left by older runtimes. The newest parseable event
 * is the liveness signal; stale bundle logs cannot mask a live daemon.
 */
export function checkLifecycle(deps: DoctorDeps): DoctorCategory {
  const checks: DoctorCheck[] = []
  const HOUR_MS = 60 * 60 * 1000
  const STALE_THRESHOLD_MS = 5 * 60 * 1000
  const now = Date.now()
  const cutoff = now - HOUR_MS

  const logPaths: string[] = []
  const seenLogPaths = new Set<string>()
  const addLogPath = (candidate: string): void => {
    if (seenLogPaths.has(candidate) || !deps.existsSync(candidate)) return
    seenLogPaths.add(candidate)
    logPaths.push(candidate)
  }
  if (deps.daemonLogsDir) {
    addLogPath(`${deps.daemonLogsDir}/daemon.ndjson`)
  }
  const agents = discoverAgents(deps)
  for (const agentDir of agents) {
    addLogPath(`${deps.bundlesRoot}/${agentDir}/state/daemon/logs/daemon.ndjson`)
  }

  if (logPaths.length === 0) {
    checks.push({ label: "daemon log readable", status: "warn", detail: "no daemon.ndjson found in daemon or agent bundle logs" })
    return { name: "Lifecycle", checks }
  }

  let lastTs: string | null = null
  let lastEvent: string | null = null
  let lastEventTimeMs = Number.NEGATIVE_INFINITY
  let startCount = 0
  let installCount = 0
  let installVersions: string[] = []
  let processErrors: string[] = []
  let lastEntryAgeMs = Number.POSITIVE_INFINITY
  let readCount = 0
  const readErrors: string[] = []

  for (const logPath of logPaths) {
    try {
      // Read the whole log via deps.readFileSync, then take the tail. For a
      // chatty daemon this can be a few MB; we only inspect the last 5000
      // lines which is enough for the last hour of activity. If the file is
      // small (typical case), reading it all is cheap.
      const raw = deps.readFileSync(logPath)
      readCount++
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
        if (tsMs > lastEventTimeMs) {
          lastEventTimeMs = tsMs
          lastTs = ts
          lastEvent = event
          lastEntryAgeMs = Math.max(0, now - tsMs)
        }
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
      readErrors.push(`${logPath}: ${error instanceof Error ? error.message : /* v8 ignore next -- non-Error throw is unreachable from deps.readFileSync (always Error) @preserve */ String(error)}`)
    }
  }

  if (readCount === 0) {
    checks.push({ label: "daemon log readable", status: "fail", detail: `read failed: ${readErrors.join("; ")}` })
    return { name: "Lifecycle", checks }
  }
  if (readErrors.length > 0) {
    checks.push({ label: "daemon log readable", status: "warn", detail: `some daemon logs were unreadable: ${readErrors.join("; ")}` })
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
  { name: "RSVP", fn: checkRsvp },
  { name: "Security", fn: checkSecurity },
  { name: "Trips", fn: checkTrips },
  { name: "Mailroom", fn: checkMailroom },
  { name: "Friends", fn: checkFriends },
  { name: "Disk", fn: checkDisk },
]

export interface RunDoctorOptions {
  /** Run only the named category (case-insensitive). When unset, runs all categories. */
  category?: string
}

export const KNOWN_DOCTOR_CATEGORIES: readonly string[] = CATEGORY_CHECKERS.map((c) => c.name)

export async function runDoctorChecks(deps: DoctorDeps, options: RunDoctorOptions = {}): Promise<DoctorResult> {
  const categories: DoctorCategory[] = []

  const filter = options.category?.toLowerCase()
  /* v8 ignore next -- branch: filter present vs absent — covered separately by --category and plain doctor tests but the filter-array generation isn't double-counted by both code paths in the same suite @preserve */
  const checkers = filter
    ? CATEGORY_CHECKERS.filter((c) => c.name.toLowerCase() === filter)
    : CATEGORY_CHECKERS

  for (const checker of checkers) {
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
