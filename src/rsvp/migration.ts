import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { emitNervesEvent } from "../nerves/runtime"
import {
  buildRsvpSnapshot,
  type LegacyRsvpAllGuestRow,
  type LegacyRsvpGuestRow,
  type RsvpSnapshot,
} from "./snapshot"

export const RSVP_MIGRATION_POLICY_VERSION = "rsvp-migration/v1" as const

interface LegacySnapshotFile {
  guests: Record<string, LegacyRsvpGuestRow>
  all_guests: Record<string, LegacyRsvpAllGuestRow>
}

interface SentStateFile {
  snapshot_path?: unknown
  source?: unknown
  updated_at?: unknown
}

export interface ImportLegacyRsvpStateInput {
  agent: string
  agentRoot: string
  legacyRoot: string
  weddingId: string
  eventId: string
  importedAt: string
}

export interface RsvpBaselineState {
  schemaVersion: 1
  policyVersion: typeof RSVP_MIGRATION_POLICY_VERSION
  agent: string
  importedAt: string
  baselineSource: string
  legacySnapshotRelativePath: string
  legacySnapshotHash: string
  sentStateHash: string
  nativeSnapshotId: string
  nativeSnapshotRelativePath: string
}

export type ImportLegacyRsvpStateResult =
  | {
    ok: true
    latestSnapshotId: string
    baselineSnapshotId: string
    latestSnapshotPath: string
    baselineSnapshotPath: string
    baselineSource: string
  }
  | {
    ok: false
    reason:
      | "missing_legacy_data"
      | "missing_sent_state"
      | "malformed_sent_state"
      | "missing_baseline_snapshot"
      | "baseline_outside_legacy_root"
      | "missing_legacy_snapshot"
      | "malformed_legacy_snapshot"
    actor: "agent-runnable"
    message: string
  }

function rsvpRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "rsvp")
}

function snapshotsDir(agentRoot: string): string {
  return path.join(rsvpRoot(agentRoot), "snapshots")
}

function baselineStatePath(agentRoot: string): string {
  return path.join(rsvpRoot(agentRoot), "baseline.json")
}

function hashBytes(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function hashFile(filePath: string): string {
  return hashBytes(fs.readFileSync(filePath))
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function fail(reason: ImportLegacyRsvpStateResult extends infer _ ? Extract<ImportLegacyRsvpStateResult, { ok: false }>["reason"] : never, message: string): ImportLegacyRsvpStateResult {
  return { ok: false, reason, actor: "agent-runnable", message }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

function normalizeRelative(root: string, filePath: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(filePath))
  if (relative.startsWith("..")) return null
  return relative.split(path.sep).join("/")
}

function listLegacySnapshotFiles(legacyRoot: string): string[] {
  const dataDir = path.join(legacyRoot, "data")
  return fs.readdirSync(dataDir)
    .filter((name) => /^snapshot_.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(dataDir, name))
}

function readLegacySnapshot(filePath: string): LegacySnapshotFile | null {
  const parsed = readJsonFile<Partial<LegacySnapshotFile>>(filePath)
  if (!parsed || !parsed.guests || typeof parsed.guests !== "object" || Array.isArray(parsed.guests)) return null
  const allGuests = parsed.all_guests && typeof parsed.all_guests === "object" && !Array.isArray(parsed.all_guests)
    ? parsed.all_guests
    : {}
  return {
    guests: parsed.guests as Record<string, LegacyRsvpGuestRow>,
    all_guests: allGuests as Record<string, LegacyRsvpAllGuestRow>,
  }
}

function fetchedAtFromLegacyName(filePath: string): string {
  const basename = path.basename(filePath)
  const match = basename.match(/^snapshot_(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})\.json$/)
  if (!match) return new Date(0).toISOString()
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`
}

function snapshotPath(agentRoot: string, snapshot: RsvpSnapshot): string {
  return path.join(snapshotsDir(agentRoot), `${snapshot.snapshotId}.json`)
}

function writeSnapshot(agentRoot: string, snapshot: RsvpSnapshot): string {
  const filePath = snapshotPath(agentRoot, snapshot)
  writeJson(filePath, snapshot)
  return filePath
}

function buildImportedSnapshot(input: ImportLegacyRsvpStateInput, filePath: string, sentStateHash?: string): RsvpSnapshot | null {
  const legacy = readLegacySnapshot(filePath)
  const relativePath = normalizeRelative(input.legacyRoot, filePath)
  if (!legacy || !relativePath) return null
  return buildRsvpSnapshot({
    agent: input.agent,
    fetchedAt: fetchedAtFromLegacyName(filePath),
    source: {
      kind: "aisleplanner",
      weddingId: input.weddingId,
      eventId: input.eventId,
      adapter: "aisleplanner-api-v1",
    },
    guests: legacy.guests,
    allGuests: legacy.all_guests,
    provenance: {
      kind: "legacy-import",
      importedAt: input.importedAt,
      legacySnapshotRelativePath: relativePath,
      legacySnapshotHash: hashFile(filePath),
      ...(sentStateHash ? { sentStateHash } : {}),
    },
  })
}

export function readRsvpBaselineState(agentRoot: string): RsvpBaselineState | null {
  return readJsonFile<RsvpBaselineState>(baselineStatePath(agentRoot))
}

export function importLegacyRsvpState(input: ImportLegacyRsvpStateInput): ImportLegacyRsvpStateResult {
  const dataDir = path.join(input.legacyRoot, "data")
  if (!fs.existsSync(dataDir)) return fail("missing_legacy_data", "legacy RSVP data directory is missing")
  const sentStatePath = path.join(dataDir, "sent_state.json")
  if (!fs.existsSync(sentStatePath)) return fail("missing_sent_state", "legacy sent_state.json is missing; refusing to bootstrap baseline")
  const sentStateRaw = fs.readFileSync(sentStatePath, "utf-8")
  const sentState = readJsonFile<SentStateFile>(sentStatePath)
  if (!sentState || typeof sentState.snapshot_path !== "string") {
    return fail("malformed_sent_state", "legacy sent_state.json is malformed; refusing to bootstrap baseline")
  }
  const baselineLegacyPath = path.resolve(sentState.snapshot_path)
  const baselineRelativePath = normalizeRelative(input.legacyRoot, baselineLegacyPath)
  if (!baselineRelativePath) return fail("baseline_outside_legacy_root", "legacy sent baseline points outside the legacy root")
  if (!fs.existsSync(baselineLegacyPath)) return fail("missing_baseline_snapshot", "legacy sent baseline snapshot is missing")
  const legacySnapshots = listLegacySnapshotFiles(input.legacyRoot)
  const latestLegacyPath = legacySnapshots.at(-1)
  if (!latestLegacyPath) return fail("missing_legacy_snapshot", "no legacy snapshot_*.json files found")

  const sentStateHash = hashBytes(sentStateRaw)
  const baselineSnapshot = buildImportedSnapshot(input, baselineLegacyPath, sentStateHash)
  const latestSnapshot = buildImportedSnapshot(input, latestLegacyPath)
  if (!baselineSnapshot || !latestSnapshot) return fail("malformed_legacy_snapshot", "legacy snapshot file is malformed")

  const baselineSnapshotPath = writeSnapshot(input.agentRoot, baselineSnapshot)
  const latestSnapshotPath = writeSnapshot(input.agentRoot, latestSnapshot)
  const baselineState: RsvpBaselineState = {
    schemaVersion: 1,
    policyVersion: RSVP_MIGRATION_POLICY_VERSION,
    agent: input.agent,
    importedAt: input.importedAt,
    baselineSource: typeof sentState.source === "string" ? sentState.source : "sent",
    legacySnapshotRelativePath: baselineRelativePath,
    legacySnapshotHash: hashFile(baselineLegacyPath),
    sentStateHash,
    nativeSnapshotId: baselineSnapshot.snapshotId,
    nativeSnapshotRelativePath: normalizeRelative(input.agentRoot, baselineSnapshotPath)!,
  }
  writeJson(baselineStatePath(input.agentRoot), baselineState)

  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.legacy_state_imported",
    message: "imported legacy RSVP snapshots into native state",
    meta: {
      agent: input.agent,
      latestSnapshotId: latestSnapshot.snapshotId,
      baselineSnapshotId: baselineSnapshot.snapshotId,
      baselineSource: baselineState.baselineSource,
    },
  })

  return {
    ok: true,
    latestSnapshotId: latestSnapshot.snapshotId,
    baselineSnapshotId: baselineSnapshot.snapshotId,
    latestSnapshotPath,
    baselineSnapshotPath,
    baselineSource: baselineState.baselineSource,
  }
}
