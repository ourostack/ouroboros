import * as fs from "node:fs"
import * as path from "node:path"
import { runDoctorChecks } from "../heart/daemon/doctor"
import type { DoctorResult } from "../heart/daemon/doctor-types"
import { emitNervesEvent } from "../nerves/runtime"
import {
  collectRsvpDiagnostics,
  type RsvpContextPacketLedgerHealth,
  type RsvpDeliveryReconciliationHealth,
  type RsvpDiagnosticsDeps,
  type RsvpHabitScheduleHealth,
  type RsvpLatestFetchHealth,
  type RsvpSpendTimelineHealth,
} from "./diagnostics"

export interface RsvpIncidentBundleDeps extends RsvpDiagnosticsDeps {
  statSync: (filePath: string) => { mode: number; size: number }
  checkSocketAlive: (socketPath: string) => Promise<boolean>
  now?: () => Date
  runDoctorChecks?: () => Promise<DoctorResult>
}

export interface RsvpIncidentBundle {
  schemaVersion: 1
  agent: string
  generatedAt: string
  sideEffect: false
  doctor: DoctorResult
  contextPacketLedger: RsvpContextPacketLedgerHealth
  habitSchedule: RsvpHabitScheduleHealth
  latestFetch: RsvpLatestFetchHealth
  deliveryReconciliation: RsvpDeliveryReconciliationHealth
  spendTimeline: RsvpSpendTimelineHealth
}

export interface BuildRsvpIncidentBundleInput {
  agent: string
  agentRoot: string
  deps: RsvpIncidentBundleDeps
}

export interface WriteRsvpIncidentBundleInput extends BuildRsvpIncidentBundleInput {
  outputPath: string
}

export interface WriteRsvpIncidentBundleResult {
  outputPath: string
  bundle: RsvpIncidentBundle
}

function nowIso(deps: RsvpIncidentBundleDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}

async function doctorResult(input: BuildRsvpIncidentBundleInput): Promise<DoctorResult> {
  if (input.deps.runDoctorChecks) return input.deps.runDoctorChecks()
  const bundleRoot = path.dirname(input.agentRoot)
  return runDoctorChecks({
    existsSync: input.deps.existsSync,
    readFileSync: input.deps.readFileSync,
    readdirSync: input.deps.readdirSync,
    statSync: input.deps.statSync,
    checkSocketAlive: input.deps.checkSocketAlive,
    socketPath: "",
    bundlesRoot: bundleRoot,
    homedir: path.dirname(bundleRoot),
    envPath: "",
    platform: process.platform,
  }, { category: "RSVP" })
}

export async function buildRsvpIncidentBundle(input: BuildRsvpIncidentBundleInput): Promise<RsvpIncidentBundle> {
  const diagnostics = collectRsvpDiagnostics(input.agentRoot, input.deps)
  const bundle = {
    schemaVersion: 1 as const,
    agent: input.agent,
    generatedAt: nowIso(input.deps),
    sideEffect: false as const,
    doctor: await doctorResult(input),
    ...diagnostics,
  }
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.incident_bundle_built",
    message: "built RSVP incident bundle",
    meta: {
      agent: input.agent,
      doctorFailed: bundle.doctor.summary.failed,
      contextPacketLedger: bundle.contextPacketLedger.status,
      latestFetch: bundle.latestFetch.status,
    },
  })
  return bundle
}

export async function writeRsvpIncidentBundle(input: WriteRsvpIncidentBundleInput): Promise<WriteRsvpIncidentBundleResult> {
  const bundle = await buildRsvpIncidentBundle(input)
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })
  fs.writeFileSync(input.outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8")
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.incident_bundle_written",
    message: "wrote RSVP incident bundle",
    meta: { agent: input.agent, outputPath: input.outputPath },
  })
  return { outputPath: input.outputPath, bundle }
}
