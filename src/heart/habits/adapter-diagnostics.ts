import { emitNervesEvent } from "../../nerves/runtime"
import * as fs from "fs"
import * as path from "path"

const IDENTIFIER = /^[a-z][a-z0-9-]*$/
const BLOCKER_CODE = /^[a-z][a-z0-9_-]*$/
const SHA256 = /^[0-9a-f]{64}$/

export type AdapterDiagnosticStatus = "healthy" | "degraded" | "blocked" | "unavailable"
export type AdapterDiagnosticActor = "agent-runnable" | "human-required" | "human-choice"

export interface HabitAdapterDiagnosticProjectionV1 {
  schemaVersion: 1
  adapter: { id: string; version: 1 }
  status: AdapterDiagnosticStatus
  evidence: Array<{ ref: string; sha256: string }>
  blockers: Array<{ code: string; actor: AdapterDiagnosticActor; message: string }>
  observedAt: string
  expiresAt: string
}

function validateProjection(value: HabitAdapterDiagnosticProjectionV1): void {
  if (value.schemaVersion !== 1) throw new Error("Adapter diagnostics schemaVersion must be 1")
  if (!IDENTIFIER.test(value.adapter.id) || value.adapter.version !== 1) throw new Error("Adapter diagnostics adapter identity is invalid")
  if (!["healthy", "degraded", "blocked", "unavailable"].includes(value.status)) throw new Error("Adapter diagnostics status is invalid")
  for (const evidence of value.evidence) {
    if (!evidence.ref || !SHA256.test(evidence.sha256)) throw new Error("Adapter diagnostics evidence sha256 is invalid")
  }
  for (const blocker of value.blockers) {
    if (!BLOCKER_CODE.test(blocker.code)) throw new Error("Adapter diagnostics blocker code is invalid")
    if (!["agent-runnable", "human-required", "human-choice"].includes(blocker.actor)) throw new Error("Adapter diagnostics blocker actor is invalid")
    if (!blocker.message) throw new Error("Adapter diagnostics blocker message is required")
  }
  if (!Number.isFinite(Date.parse(value.observedAt)) || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new Error("Adapter diagnostics timestamps are invalid")
  }
}

export class AdapterDiagnosticsRegistry {
  private readonly projections = new Map<string, HabitAdapterDiagnosticProjectionV1>()

  publish(projection: HabitAdapterDiagnosticProjectionV1): void {
    validateProjection(projection)
    const key = `${projection.adapter.id}\u0000${projection.adapter.version}`
    if (this.projections.has(key)) throw new Error(`Duplicate adapter diagnostics projection: ${projection.adapter.id}@${projection.adapter.version}`)
    this.projections.set(key, structuredClone(projection))
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_adapter_diagnostics_published",
      message: "published closed generic adapter diagnostics",
      meta: { adapterId: projection.adapter.id, status: projection.status },
    })
  }

  replace(projection: HabitAdapterDiagnosticProjectionV1): void {
    validateProjection(projection)
    const key = `${projection.adapter.id}\u0000${projection.adapter.version}`
    this.projections.set(key, structuredClone(projection))
    emitNervesEvent({
      component: "heart",
      event: "heart.habit_adapter_diagnostics_replaced",
      message: "replaced closed generic adapter diagnostics",
      meta: { adapterId: projection.adapter.id, status: projection.status },
    })
  }

  get(id: string, version: number): HabitAdapterDiagnosticProjectionV1 | null {
    const projection = this.projections.get(`${id}\u0000${version}`)
    return projection ? structuredClone(projection) : null
  }

  list(): HabitAdapterDiagnosticProjectionV1[] {
    return Array.from(this.projections.values(), (projection) => structuredClone(projection))
  }
}

export function writeAdapterDiagnosticProjection(
  bundleRoot: string,
  projection: HabitAdapterDiagnosticProjectionV1,
): void {
  validateProjection(projection)
  const directory = path.join(bundleRoot, "state", "habits", "adapter-diagnostics")
  const target = path.join(directory, `${projection.adapter.id}-v${projection.adapter.version}.json`)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(projection)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temporary, target)
}

export function listStoredAdapterDiagnostics(bundlesRoot: string): HabitAdapterDiagnosticProjectionV1[] {
  if (!fs.existsSync(bundlesRoot)) return []
  const projections: HabitAdapterDiagnosticProjectionV1[] = []
  for (const bundleName of fs.readdirSync(bundlesRoot).filter((name) => name.endsWith(".ouro")).sort()) {
    const directory = path.join(bundlesRoot, bundleName, "state", "habits", "adapter-diagnostics")
    if (!fs.existsSync(directory)) continue
    for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
      const projection = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as HabitAdapterDiagnosticProjectionV1
      validateProjection(projection)
      projections.push(projection)
    }
  }
  return projections
}
