#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import { createServer, type Server } from "node:http"
import * as os from "node:os"
import * as path from "node:path"

import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import {
  createSanctuaryHealthSweep,
  withSanctuaryHealthStateLease,
  type SanctuaryHealthStateLease,
} from "./sanctuary-health"
import {
  runSanctuaryHealthHabit,
  type SanctuaryHealthHabitRunnerOptions,
} from "./sanctuary-health-runner"
import { createSanctuaryToolContext } from "./sanctuary-runtime"

const SHA256 = /^[0-9a-f]{64}$/u
const TARGET_ENDPOINT = "https://books.mendelow.cloud/"
const CRON_MARKER = "# ouro:habit:sanctuary:sanctuary:sanctuary-health"
const CRON_COMMAND = "*/15 * * * * /usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron"
const PROCESS_ENTRY = "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe.js"
const LABELS = ["unit-16f-cron-fingerprint", "unit-16g-health-transition", "unit-16h-daily-digest"] as const

export type SanctuaryHealthAcceptanceProbeLabel = typeof LABELS[number]

export interface SanctuaryHealthAcceptanceProbeInput {
  label: SanctuaryHealthAcceptanceProbeLabel
  scenarioHandleDigest: string
  ownerImageDigest: string
  ownerContainerDigest: string
}

export interface SanctuaryHealthAcceptanceProbePhase {
  ordinal: number
  name: string
  trigger: "cron" | "acceptance"
  fixtureStatus: 200 | 503 | null
  opened: number
  recovered: number
  digestDue: boolean
  deliveryKind: "transition" | "digest" | "transition_and_digest" | null
  sweepReceiptDigest: string
  deliveryReceiptDigest: string | null
}

export interface SanctuaryHealthAcceptanceProbeReceipt {
  schemaVersion: "sanctuary-health-probe-receipt-v1"
  label: SanctuaryHealthAcceptanceProbeLabel
  scenarioHandleDigest: string
  ownerImageDigestBefore: string
  ownerImageDigestAfter: string
  ownerContainerDigestBefore: string
  ownerContainerDigestAfter: string
  beforeStateDigest: string
  restoredStateDigest: string
  cronFingerprintBefore: string
  cronFingerprintAfter: string
  cronRegisteredBefore: boolean
  cronRegisteredAfter: boolean
  cronDegradedBefore: boolean
  cronDegradedAfter: boolean
  fixtureSequenceDigest: string
  clockMode: "ambient" | "local-daily-boundary"
  effectiveNow: string
  phases: SanctuaryHealthAcceptanceProbePhase[]
  providerInvocationCount: number
  privateTurnCount: number
  deliveryCount: number
  workspaceAbsent: boolean
  socketAbsent: boolean
  snapshotAbsent: boolean
  realCheckEquivalent: boolean
  productionRestored: boolean
}

interface ProbeDependencies {
  agentRoot: string
  runtimeRoot: string
  toolContext: ReturnType<typeof createSanctuaryToolContext>
  ambientFetch: typeof fetch
  now(): Date
  runnerOptions?: SanctuaryHealthHabitRunnerOptions
  deferOwnerAttestation?: boolean
}

interface HealthSnapshot { exists: boolean; bytes: string }

interface ProbeProcessDependencies {
  agentRoot: string
  listPids(): number[]
  processAlive(pid: number): boolean
  readCommandLine(pid: number): string
  signal(pid: number, signal: NodeJS.Signals): void
  sleep(ms: number): Promise<void>
}

type HealthStateRecord = {
  incidents: Record<string, { id: string; summary: string }>
  lastDigestDay: string | null
  updatedAt: string
  outbox: unknown
  indeterminateDeliveries: unknown[]
  deliveredReceipts: Array<Record<string, unknown>>
  sweepReceipts: Array<Record<string, unknown>>
}

function digestBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function digestJson(value: unknown): string {
  return digestBytes(JSON.stringify(value))
}

function canonicalInput(input: SanctuaryHealthAcceptanceProbeInput): void {
  if (!LABELS.includes(input.label) || ![input.scenarioHandleDigest, input.ownerImageDigest, input.ownerContainerDigest].every((value) => SHA256.test(value))) {
    throw new Error("Sanctuary health acceptance probe input is invalid")
  }
}

function atomicPrivateFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(filePath), 0o700)
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 })
    const handle = fs.openSync(temporary, "r")
    try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, 0o600)
    const directory = fs.openSync(path.dirname(filePath), "r")
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function probeProcessPath(agentRoot: string, scenarioHandleDigest: string): string {
  return path.join(agentRoot, "state", "acceptance", "health-probe-processes", `${scenarioHandleDigest}.json`)
}

function processRecord(input: SanctuaryHealthAcceptanceProbeInput, pid: number): Record<string, unknown> {
  return { schemaVersion: "sanctuary-health-probe-process-v1", pid, ...input }
}

function sameProcessRecord(value: Record<string, unknown>, input: SanctuaryHealthAcceptanceProbeInput): value is Record<string, unknown> & { pid: number } {
  return value.schemaVersion === "sanctuary-health-probe-process-v1" && Number.isSafeInteger(value.pid) && Number(value.pid) > 1
    && value.label === input.label && value.scenarioHandleDigest === input.scenarioHandleDigest
    && value.ownerImageDigest === input.ownerImageDigest && value.ownerContainerDigest === input.ownerContainerDigest
}

export function registerSanctuaryHealthAcceptanceProbeProcess(
  input: SanctuaryHealthAcceptanceProbeInput,
  dependencies: { agentRoot: string; pid: number },
): void {
  canonicalInput(input)
  if (!Number.isSafeInteger(dependencies.pid) || dependencies.pid <= 1) throw new Error("Sanctuary health acceptance process pid is invalid")
  atomicPrivateFile(probeProcessPath(dependencies.agentRoot, input.scenarioHandleDigest), `${JSON.stringify(processRecord(input, dependencies.pid))}\n`)
}

function unregisterSanctuaryHealthAcceptanceProbeProcess(input: SanctuaryHealthAcceptanceProbeInput, agentRoot: string, pid: number): void {
  const marker = probeProcessPath(agentRoot, input.scenarioHandleDigest)
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>
    if (sameProcessRecord(value, input) && value.pid === pid) fs.unlinkSync(marker)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function defaultProbeProcessDependencies(): ProbeProcessDependencies {
  return {
    agentRoot: getAgentRoot("sanctuary"),
    listPids: () => fs.readdirSync("/proc").filter((entry) => /^[0-9]+$/u.test(entry)).map(Number),
    processAlive: (pid) => {
      try { process.kill(pid, 0); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error }
    },
    readCommandLine: (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"),
    signal: (pid, signal) => { process.kill(pid, signal) },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

function expectedProbeCommandLine(input: SanctuaryHealthAcceptanceProbeInput): string[] {
  return [
    "/usr/local/bin/node", PROCESS_ENTRY, "run",
    "--label", input.label,
    "--scenario", input.scenarioHandleDigest,
    "--owner-image", input.ownerImageDigest,
    "--owner-container", input.ownerContainerDigest,
  ]
}

function parsedCommandLine(raw: string): string[] {
  const parts = raw.split("\0")
  if (parts.at(-1) === "") parts.pop()
  return parts
}

function exactProbeProcessPids(input: SanctuaryHealthAcceptanceProbeInput, dependencies: ProbeProcessDependencies): number[] {
  const expected = JSON.stringify(expectedProbeCommandLine(input))
  return dependencies.listPids().filter((pid) => {
    if (!dependencies.processAlive(pid)) return false
    try { return JSON.stringify(parsedCommandLine(dependencies.readCommandLine(pid))) === expected }
    catch (error) {
      if (["ENOENT", "ESRCH"].includes(String((error as NodeJS.ErrnoException).code))) return false
      throw error
    }
  })
}

async function waitForProcessAbsent(pid: number, dependencies: ProbeProcessDependencies, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (dependencies.processAlive(pid) && Date.now() < deadline) await dependencies.sleep(Math.min(50, Math.max(1, deadline - Date.now())))
  return !dependencies.processAlive(pid)
}

export async function stopSanctuaryHealthAcceptanceProbeProcess(
  input: SanctuaryHealthAcceptanceProbeInput,
  dependencies: ProbeProcessDependencies = defaultProbeProcessDependencies(),
  options: { termGraceMs?: number; killGraceMs?: number } = {},
): Promise<{ stopped: boolean }> {
  canonicalInput(input)
  const marker = probeProcessPath(dependencies.agentRoot, input.scenarioHandleDigest)
  let markerPid: number | null = null
  try {
    const value = JSON.parse(fs.readFileSync(marker, "utf8")) as Record<string, unknown>
    if (!sameProcessRecord(value, input)) throw new Error("Sanctuary health acceptance process identity is invalid")
    markerPid = value.pid
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const exactPids = exactProbeProcessPids(input, dependencies)
  if (exactPids.length > 1) throw new Error("Sanctuary health acceptance process identity is ambiguous")
  if (markerPid !== null && dependencies.processAlive(markerPid) && exactPids[0] !== markerPid) {
    throw new Error("Sanctuary health acceptance process identity is invalid")
  }
  if (markerPid !== null && !dependencies.processAlive(markerPid) && exactPids.length !== 0) {
    throw new Error("Sanctuary health acceptance process identity is invalid")
  }
  const pid = markerPid !== null && dependencies.processAlive(markerPid) ? markerPid : exactPids[0] ?? null
  if (pid !== null) {
    dependencies.signal(pid, "SIGTERM")
    if (!await waitForProcessAbsent(pid, dependencies, options.termGraceMs ?? 5_000)) {
      dependencies.signal(pid, "SIGKILL")
      if (!await waitForProcessAbsent(pid, dependencies, options.killGraceMs ?? 5_000)) throw new Error("Sanctuary health acceptance process did not stop")
    }
  }
  if (markerPid !== null) unregisterSanctuaryHealthAcceptanceProbeProcess(input, dependencies.agentRoot, markerPid)
  if (exactProbeProcessPids(input, dependencies).length !== 0 || fs.existsSync(marker)) throw new Error("Sanctuary health acceptance process absence was not verified")
  return { stopped: pid !== null }
}

function snapshotState(statePath: string): HealthSnapshot {
  try { return { exists: true, bytes: fs.readFileSync(statePath).toString("base64") } }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, bytes: "" }
    throw error
  }
}

function snapshotDigest(snapshot: HealthSnapshot): string {
  return digestBytes(snapshot.exists ? Buffer.from(snapshot.bytes, "base64") : "sanctuary-health-state:absent")
}

function restoreState(statePath: string, snapshot: HealthSnapshot): void {
  if (!snapshot.exists) {
    try { fs.unlinkSync(statePath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    return
  }
  atomicPrivateFile(statePath, Buffer.from(snapshot.bytes, "base64").toString("utf8"))
}

function readHealthState(statePath: string): HealthStateRecord {
  const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as HealthStateRecord
  if (!value || typeof value !== "object" || Array.isArray(value.incidents) || !Array.isArray(value.sweepReceipts) || !Array.isArray(value.deliveredReceipts)) {
    throw new Error("Sanctuary health acceptance working state is invalid")
  }
  return value
}

function writeHealthState(statePath: string, state: HealthStateRecord): void {
  atomicPrivateFile(statePath, `${JSON.stringify(state)}\n`)
}

function localParts(date: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]))
}

function localDay(date: Date): string {
  const parts = localParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function exactLocalDailyBoundary(reference: Date): Date {
  const parts = localParts(reference)
  const desired = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 9, 0, 0, 0)
  let candidate = desired
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = localParts(new Date(candidate))
    const observedWall = Date.UTC(Number(observed.year), Number(observed.month) - 1, Number(observed.day), Number(observed.hour), Number(observed.minute), Number(observed.second), 0)
    candidate += desired - observedWall
  }
  const result = new Date(candidate)
  const final = localParts(result)
  if (final.year !== parts.year || final.month !== parts.month || final.day !== parts.day
    || final.hour !== "09" || final.minute !== "00" || final.second !== "00" || result.getUTCMilliseconds() !== 0) {
    throw new Error("Sanctuary daily boundary clock could not be resolved")
  }
  return result
}

function canonicalCron(raw: string): boolean {
  const lines = raw.split(/\r?\n/u)
  const marker = lines.indexOf(CRON_MARKER)
  return marker >= 0 && lines[marker + 1] === CRON_COMMAND
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function loopbackFixture(statuses: Array<200 | 503>, ambientFetch: typeof fetch): Promise<{
  fetch: typeof fetch
  server: Server
  observed: Array<200 | 503>
}> {
  let cursor = 0
  const observed: Array<200 | 503> = []
  const server = createServer((_request, response) => {
    const status = statuses[cursor]
    if (status === undefined) { response.writeHead(500); response.end(); return }
    cursor += 1
    observed.push(status)
    response.writeHead(status)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === "string") { await closeServer(server); throw new Error("Sanctuary loopback fixture address is invalid") }
  const fixtureUrl = `http://127.0.0.1:${address.port}/health`
  const fixtureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === TARGET_ENDPOINT) return globalThis.fetch(fixtureUrl, { ...init, redirect: "manual" })
    return ambientFetch(input, init)
  }) as typeof fetch
  return { fetch: fixtureFetch, server, observed }
}

function defaultDependencies(): ProbeDependencies {
  return {
    agentRoot: getAgentRoot("sanctuary"),
    runtimeRoot: path.join(os.homedir(), ".ouro-cli"),
    toolContext: createSanctuaryToolContext("sanctuary"),
    ambientFetch: fetch,
    now: () => new Date(),
    deferOwnerAttestation: true,
  }
}

async function normalizeWorkingState(input: {
  workspace: string
  statePath: string
  deps: ProbeDependencies
  effectiveNow: Date
}): Promise<string> {
  const temporaryState = path.join(input.workspace, "normalization.json")
  try { fs.copyFileSync(input.statePath, temporaryState) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const sweep = createSanctuaryHealthSweep({
    toolContext: input.deps.toolContext,
    statePath: temporaryState,
    fetch: input.deps.ambientFetch,
    now: () => input.effectiveNow,
    acceptanceEventMeta: () => ({}),
  })
  await sweep()
  const state = readHealthState(temporaryState)
  state.outbox = null
  state.indeterminateDeliveries = []
  state.lastDigestDay = localDay(input.effectiveNow)
  state.updatedAt = input.effectiveNow.toISOString()
  writeHealthState(input.statePath, state)
  const last = state.sweepReceipts.at(-1)
  if (!last || typeof last.incidentDigest !== "string" || !SHA256.test(last.incidentDigest)) throw new Error("Sanctuary health normalization receipt is invalid")
  return last.incidentDigest
}

function phaseFromState(
  statePath: string,
  scenarioHandleDigest: string,
  ordinal: number,
  name: string,
  trigger: "cron" | "acceptance",
  fixtureStatus: 200 | 503 | null,
): SanctuaryHealthAcceptanceProbePhase {
  const state = readHealthState(statePath)
  const sweep = state.sweepReceipts.filter((entry) => entry.scenarioHandleDigest === scenarioHandleDigest).at(-1)
  if (!sweep || typeof sweep.opened !== "number" || typeof sweep.recovered !== "number" || typeof sweep.digestDue !== "boolean") {
    throw new Error("Sanctuary health acceptance sweep receipt is missing")
  }
  const deliveryId = typeof sweep.deliveryId === "string" ? sweep.deliveryId : null
  const delivery = deliveryId ? state.deliveredReceipts.find((entry) => entry.deliveryId === deliveryId) : undefined
  const kind = delivery && ["transition", "digest", "transition_and_digest"].includes(String(delivery.kind))
    ? delivery.kind as SanctuaryHealthAcceptanceProbePhase["deliveryKind"] : null
  if (deliveryId && !delivery) throw new Error("Sanctuary health acceptance delivery receipt is missing")
  return {
    ordinal, name, trigger, fixtureStatus,
    opened: sweep.opened, recovered: sweep.recovered, digestDue: sweep.digestDue,
    deliveryKind: kind,
    sweepReceiptDigest: digestJson(sweep),
    deliveryReceiptDigest: delivery ? digestJson(delivery) : null,
  }
}

async function verifyRealCheckEquivalent(input: {
  workspace: string
  statePath: string
  deps: ProbeDependencies
  effectiveNow: Date
  expectedIncidentDigest: string
}): Promise<boolean> {
  const verifyState = path.join(input.workspace, "verify.json")
  try { fs.copyFileSync(input.statePath, verifyState) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const sweep = createSanctuaryHealthSweep({ toolContext: input.deps.toolContext, statePath: verifyState, fetch: input.deps.ambientFetch, now: () => input.effectiveNow })
  await sweep()
  const receipt = readHealthState(verifyState).sweepReceipts.at(-1)
  return Boolean(receipt && receipt.incidentDigest === input.expectedIncidentDigest)
}

export async function runSanctuaryHealthAcceptanceProbe(
  input: SanctuaryHealthAcceptanceProbeInput,
  dependencies: ProbeDependencies = defaultDependencies(),
): Promise<SanctuaryHealthAcceptanceProbeReceipt> {
  canonicalInput(input)
  const statePath = path.join(dependencies.agentRoot, "state", "health", "sanctuary-health.json")
  const acceptanceRoot = path.join(dependencies.agentRoot, "state", "acceptance")
  const workspace = path.join(acceptanceRoot, "health-probe-workspaces", input.scenarioHandleDigest)
  const snapshotPath = path.join(workspace, "snapshot.json")
  const checkpointPath = path.join(workspace, "checkpoint.json")
  const receiptPath = path.join(acceptanceRoot, "health-probe-receipts", `${input.scenarioHandleDigest}.json`)
  const pendingPath = path.join(acceptanceRoot, "health-probe-pending", `${input.scenarioHandleDigest}.json`)
  if (fs.existsSync(workspace) || fs.existsSync(receiptPath) || fs.existsSync(pendingPath)) throw new Error("Sanctuary health acceptance probe requires inspect-before-retry")
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 })
  fs.chmodSync(workspace, 0o700)
  const snapshot = snapshotState(statePath)
  const beforeStateDigest = snapshotDigest(snapshot)
  atomicPrivateFile(snapshotPath, `${JSON.stringify(snapshot)}\n`)
  atomicPrivateFile(checkpointPath, `${JSON.stringify({ schemaVersion: 1, ownerImageDigest: input.ownerImageDigest, ownerContainerDigest: input.ownerContainerDigest })}\n`)
  const cronPath = path.join(dependencies.runtimeRoot, "scheduler", "sanctuary.crontab")
  const cronBefore = fs.readFileSync(cronPath, "utf8")
  const cronFingerprintBefore = digestBytes(cronBefore)
  const cronRegisteredBefore = canonicalCron(cronBefore)
  const effectiveNow = input.label === "unit-16h-daily-digest" ? exactLocalDailyBoundary(dependencies.now()) : dependencies.now()
  let fixture: Awaited<ReturnType<typeof loopbackFixture>> | undefined
  let expectedIncidentDigest = ""
  let realCheckEquivalent = false
  let restoredStateDigest = ""
  let socketAbsent = true
  const phases: SanctuaryHealthAcceptanceProbePhase[] = []
  let providerInvocationCount = 0
  let privateTurnCount = 0
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_acceptance_start", message: "Sanctuary health acceptance probe started", meta: { label: input.label, scenarioHandleDigest: input.scenarioHandleDigest } })
  try {
    await withSanctuaryHealthStateLease(statePath, async (lease: SanctuaryHealthStateLease) => {
      expectedIncidentDigest = await normalizeWorkingState({ workspace, statePath, deps: dependencies, effectiveNow })
      if (input.label === "unit-16h-daily-digest") {
        const state = readHealthState(statePath)
        state.incidents[`endpoint:${TARGET_ENDPOINT}`] = { id: `endpoint:${TARGET_ENDPOINT}`, summary: `${TARGET_ENDPOINT} returned 503` }
        state.lastDigestDay = localDay(new Date(effectiveNow.getTime() - 36 * 60 * 60 * 1_000))
        writeHealthState(statePath, state)
      }
      const runPhase = async (name: string, trigger: "cron" | "acceptance", fixtureStatus: 200 | 503 | null, fetchImpl: typeof fetch, now: Date): Promise<void> => {
        const sweep = createSanctuaryHealthSweep({
          toolContext: dependencies.toolContext, statePath, fetch: fetchImpl, now: () => now, lease,
          acceptanceEventMeta: () => ({ scenarioHandleDigest: input.scenarioHandleDigest }),
        })
        await runSanctuaryHealthHabit("sanctuary", {
          ...dependencies.runnerOptions,
          createSweep: () => sweep,
          acceptanceMetrics: {
            onPrivateTurnStart: () => { privateTurnCount += 1 },
            onProviderInvocation: () => { providerInvocationCount += 1 },
          },
        })
        phases.push(phaseFromState(statePath, input.scenarioHandleDigest, phases.length + 1, name, trigger, fixtureStatus))
      }
      if (input.label === "unit-16f-cron-fingerprint") {
        await runPhase("cron-unchanged", "cron", null, dependencies.ambientFetch, effectiveNow)
      } else if (input.label === "unit-16g-health-transition") {
        await runPhase("live-baseline", "acceptance", null, dependencies.ambientFetch, effectiveNow)
        await runPhase("live-repeat", "acceptance", null, dependencies.ambientFetch, effectiveNow)
        fixture = await loopbackFixture([503, 503, 200, 503], dependencies.ambientFetch)
        for (const [name, status] of [["fixture-fail", 503], ["fixture-repeat", 503], ["fixture-recover", 200], ["fixture-refail", 503]] as const) {
          await runPhase(name, "acceptance", status, fixture.fetch, effectiveNow)
        }
      } else {
        fixture = await loopbackFixture([503, 503], dependencies.ambientFetch)
        await runPhase("digest-boundary", "acceptance", 503, fixture.fetch, effectiveNow)
        await runPhase("digest-repeat", "acceptance", 503, fixture.fetch, effectiveNow)
      }
      if (fixture) { await closeServer(fixture.server); socketAbsent = fixture.server.address() === null }
      restoreState(statePath, snapshot)
      realCheckEquivalent = await verifyRealCheckEquivalent({ workspace, statePath, deps: dependencies, effectiveNow, expectedIncidentDigest })
      restoreState(statePath, snapshot)
      restoredStateDigest = snapshotDigest(snapshotState(statePath))
    })
    const cronAfter = fs.readFileSync(cronPath, "utf8")
    const cronFingerprintAfter = digestBytes(cronAfter)
    const cronRegisteredAfter = canonicalCron(cronAfter)
    const observedFixtureSequence = fixture?.observed ?? []
    fs.rmSync(workspace, { recursive: true, force: false })
    const receipt: SanctuaryHealthAcceptanceProbeReceipt = {
      schemaVersion: "sanctuary-health-probe-receipt-v1",
      label: input.label,
      scenarioHandleDigest: input.scenarioHandleDigest,
      ownerImageDigestBefore: input.ownerImageDigest,
      ownerImageDigestAfter: input.ownerImageDigest,
      ownerContainerDigestBefore: input.ownerContainerDigest,
      ownerContainerDigestAfter: input.ownerContainerDigest,
      beforeStateDigest,
      restoredStateDigest,
      cronFingerprintBefore,
      cronFingerprintAfter,
      cronRegisteredBefore,
      cronRegisteredAfter,
      cronDegradedBefore: !cronRegisteredBefore,
      cronDegradedAfter: !cronRegisteredAfter,
      fixtureSequenceDigest: digestJson(observedFixtureSequence),
      clockMode: input.label === "unit-16h-daily-digest" ? "local-daily-boundary" : "ambient",
      effectiveNow: effectiveNow.toISOString(),
      phases,
      providerInvocationCount,
      privateTurnCount,
      deliveryCount: phases.filter((phase) => phase.deliveryReceiptDigest !== null).length,
      workspaceAbsent: !fs.existsSync(workspace),
      socketAbsent,
      snapshotAbsent: !fs.existsSync(snapshotPath),
      realCheckEquivalent,
      productionRestored: beforeStateDigest === restoredStateDigest && cronFingerprintBefore === cronFingerprintAfter
        && cronRegisteredBefore && cronRegisteredAfter && socketAbsent && realCheckEquivalent,
    }
    if (dependencies.deferOwnerAttestation) {
      atomicPrivateFile(pendingPath, `${JSON.stringify({ schemaVersion: "sanctuary-health-probe-pending-v1", receipt })}\n`)
    } else {
      atomicPrivateFile(receiptPath, `${JSON.stringify(receipt)}\n`)
    }
    emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_acceptance_end", message: "Sanctuary health acceptance probe completed", meta: { label: input.label, scenarioHandleDigest: input.scenarioHandleDigest, phaseCount: phases.length } })
    return receipt
  } catch (error) {
    try { if (fixture?.server.listening) await closeServer(fixture.server) } catch { /* restoration remains authoritative */ }
    try { restoreState(statePath, snapshot) } catch { /* recovery checkpoint remains for the fixed recovery operation */ }
    try { fs.rmSync(workspace, { recursive: true, force: false }) } catch { /* retain checkpoint for recovery */ }
    emitNervesEvent({ level: "error", component: "senses", event: "senses.sanctuary_health_acceptance_error", message: "Sanctuary health acceptance probe failed", meta: { label: input.label, scenarioHandleDigest: input.scenarioHandleDigest, error: error instanceof Error ? error.message : String(error) } })
    throw error
  }
}

export function finalizeSanctuaryHealthAcceptanceProbe(
  input: SanctuaryHealthAcceptanceProbeInput,
  after: { ownerImageDigest: string; ownerContainerDigest: string },
  dependencies: Pick<ProbeDependencies, "agentRoot"> = { agentRoot: getAgentRoot("sanctuary") },
): SanctuaryHealthAcceptanceProbeReceipt {
  canonicalInput(input)
  if (!SHA256.test(after.ownerImageDigest) || !SHA256.test(after.ownerContainerDigest)) throw new Error("Sanctuary health acceptance final owner is invalid")
  const acceptanceRoot = path.join(dependencies.agentRoot, "state", "acceptance")
  const pendingPath = path.join(acceptanceRoot, "health-probe-pending", `${input.scenarioHandleDigest}.json`)
  const receiptPath = path.join(acceptanceRoot, "health-probe-receipts", `${input.scenarioHandleDigest}.json`)
  const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as { schemaVersion?: unknown; receipt?: SanctuaryHealthAcceptanceProbeReceipt }
  const pending = envelope.receipt
  if (envelope.schemaVersion !== "sanctuary-health-probe-pending-v1" || !pending
    || pending.label !== input.label || pending.scenarioHandleDigest !== input.scenarioHandleDigest
    || pending.ownerImageDigestBefore !== input.ownerImageDigest || pending.ownerContainerDigestBefore !== input.ownerContainerDigest) {
    throw new Error("Sanctuary health acceptance pending receipt binding is invalid")
  }
  const ownerStable = after.ownerImageDigest === input.ownerImageDigest && after.ownerContainerDigest === input.ownerContainerDigest
  if (!ownerStable) throw new Error("Sanctuary health acceptance owner drifted")
  const receipt = {
    ...pending,
    ownerImageDigestAfter: after.ownerImageDigest,
    ownerContainerDigestAfter: after.ownerContainerDigest,
    productionRestored: pending.productionRestored && ownerStable,
  }
  atomicPrivateFile(receiptPath, `${JSON.stringify(receipt)}\n`)
  fs.unlinkSync(pendingPath)
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_acceptance_attested", message: "Sanctuary health acceptance owner continuity was attested", meta: { label: input.label, scenarioHandleDigest: input.scenarioHandleDigest } })
  return receipt
}

export async function recoverSanctuaryHealthAcceptanceProbe(
  input: SanctuaryHealthAcceptanceProbeInput,
  dependencies: ProbeDependencies = defaultDependencies(),
): Promise<{ recovered: boolean }> {
  canonicalInput(input)
  const statePath = path.join(dependencies.agentRoot, "state", "health", "sanctuary-health.json")
  const pendingPath = path.join(dependencies.agentRoot, "state", "acceptance", "health-probe-pending", `${input.scenarioHandleDigest}.json`)
  const workspace = path.join(dependencies.agentRoot, "state", "acceptance", "health-probe-workspaces", input.scenarioHandleDigest)
  if (!fs.existsSync(workspace)) {
    if (!fs.existsSync(pendingPath)) return { recovered: false }
    const envelope = JSON.parse(fs.readFileSync(pendingPath, "utf8")) as { receipt?: SanctuaryHealthAcceptanceProbeReceipt }
    if (!envelope.receipt || envelope.receipt.label !== input.label || envelope.receipt.scenarioHandleDigest !== input.scenarioHandleDigest
      || envelope.receipt.ownerImageDigestBefore !== input.ownerImageDigest || envelope.receipt.ownerContainerDigestBefore !== input.ownerContainerDigest) {
      throw new Error("Sanctuary health acceptance pending recovery binding is invalid")
    }
    fs.unlinkSync(pendingPath)
    return { recovered: true }
  }
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workspace, "checkpoint.json"), "utf8")) as Record<string, unknown>
  if (checkpoint.schemaVersion !== 1 || checkpoint.ownerImageDigest !== input.ownerImageDigest || checkpoint.ownerContainerDigest !== input.ownerContainerDigest) {
    throw new Error("Sanctuary health acceptance recovery owner binding is invalid")
  }
  const snapshot = JSON.parse(fs.readFileSync(path.join(workspace, "snapshot.json"), "utf8")) as HealthSnapshot
  await withSanctuaryHealthStateLease(statePath, async () => restoreState(statePath, snapshot))
  fs.rmSync(workspace, { recursive: true, force: false })
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath)
  emitNervesEvent({ component: "senses", event: "senses.sanctuary_health_acceptance_recovered", message: "Sanctuary health acceptance probe state was restored", meta: { label: input.label, scenarioHandleDigest: input.scenarioHandleDigest } })
  return { recovered: true }
}

function parseCli(argv: string[]): { mode: "run" | "stop" | "recover" | "finalize"; input: SanctuaryHealthAcceptanceProbeInput; after?: { ownerImageDigest: string; ownerContainerDigest: string } } {
  if ((argv.length !== 9 && argv.length !== 13) || (argv[0] !== "run" && argv[0] !== "stop" && argv[0] !== "recover" && argv[0] !== "finalize")
    || argv[1] !== "--label" || argv[3] !== "--scenario" || argv[5] !== "--owner-image" || argv[7] !== "--owner-container") {
    throw new Error("usage: sanctuary-health-acceptance-probe <run|stop|recover|finalize> --label <label> --scenario <digest> --owner-image <digest> --owner-container <digest> [--owner-image-after <digest> --owner-container-after <digest>]")
  }
  const input = { label: argv[2] as SanctuaryHealthAcceptanceProbeLabel, scenarioHandleDigest: argv[4]!, ownerImageDigest: argv[6]!, ownerContainerDigest: argv[8]! }
  canonicalInput(input)
  if (argv[0] === "finalize") {
    if (argv.length !== 13 || argv[9] !== "--owner-image-after" || argv[11] !== "--owner-container-after") throw new Error("Sanctuary health acceptance finalize coordinates are invalid")
    return { mode: argv[0], input, after: { ownerImageDigest: argv[10]!, ownerContainerDigest: argv[12]! } }
  }
  if (argv.length !== 9) throw new Error("Sanctuary health acceptance probe coordinates are invalid")
  return { mode: argv[0], input }
}

async function runCliProbe(input: SanctuaryHealthAcceptanceProbeInput): Promise<SanctuaryHealthAcceptanceProbeReceipt> {
  const agentRoot = getAgentRoot("sanctuary")
  registerSanctuaryHealthAcceptanceProbeProcess(input, { agentRoot, pid: process.pid })
  const interrupted = (signal: NodeJS.Signals): void => {
    unregisterSanctuaryHealthAcceptanceProbeProcess(input, agentRoot, process.pid)
    process.removeListener("SIGTERM", onTerm)
    process.removeListener("SIGINT", onInterrupt)
    process.kill(process.pid, signal)
  }
  const onTerm = (): void => interrupted("SIGTERM")
  const onInterrupt = (): void => interrupted("SIGINT")
  process.once("SIGTERM", onTerm)
  process.once("SIGINT", onInterrupt)
  try { return await runSanctuaryHealthAcceptanceProbe(input) }
  finally {
    process.removeListener("SIGTERM", onTerm)
    process.removeListener("SIGINT", onInterrupt)
    unregisterSanctuaryHealthAcceptanceProbeProcess(input, agentRoot, process.pid)
  }
}

if (require.main === module) {
  const { mode, input, after } = parseCli(process.argv.slice(2))
  const operation = mode === "run"
    ? runCliProbe(input)
    : mode === "stop" ? stopSanctuaryHealthAcceptanceProbeProcess(input)
      : mode === "recover" ? recoverSanctuaryHealthAcceptanceProbe(input) : Promise.resolve(finalizeSanctuaryHealthAcceptanceProbe(input, after!))
  void operation.catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
