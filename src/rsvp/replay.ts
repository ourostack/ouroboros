import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

export const RSVP_REPLAY_POLICY_VERSION = "rsvp-replay/v1" as const
export const RSVP_REPLAY_RESULT_POLICY_VERSION = "rsvp-replay-result/v1" as const

type ForbiddenLiveHelper = (...args: unknown[]) => unknown

export interface RsvpReplayDeps {
  fetchAislePlanner?: ForbiddenLiveHelper
  sendBlueBubbles?: ForbiddenLiveHelper
  writeVaultItem?: ForbiddenLiveHelper
}

export interface LegacyRsvpOfflineDeps {
  saveSnapshot?: ForbiddenLiveHelper
  writeSentState?: ForbiddenLiveHelper
  runReportPipeline?: ForbiddenLiveHelper
  fetchAislePlanner?: ForbiddenLiveHelper
  sendBlueBubbles?: ForbiddenLiveHelper
}

export interface ReplayRsvpFixtureInput {
  fixturePath: string
  deps?: RsvpReplayDeps
}

export interface RenderLegacyRsvpSnapshotOfflineInput {
  legacyRoot: string
  outputPath: string
  deps?: LegacyRsvpOfflineDeps
}

export interface RsvpReplayResult {
  schemaVersion: 1
  policyVersion: typeof RSVP_REPLAY_RESULT_POLICY_VERSION
  sideEffect: false
  contextPacketHash: string
  modelInputHash: string
  answer: string
  indexPolicy: { search: false; vector: false }
}

export interface LegacyRsvpOfflineRenderResult {
  schemaVersion: 1
  sideEffect: false
  outputPath: string
  legacyRootHashBefore: string
  legacyRootHashAfter: string
  pendingGuests: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256(input: string): string {
  return `sha256:${crypto.createHash("sha256").update(input).digest("hex")}`
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
}

function fixtureExpected(fixture: Record<string, unknown>): { contextPacketHash: string; modelInputHash: string } {
  const expected = isRecord(fixture.expected) ? fixture.expected : null
  const contextPacketHash = expected ? stringField(expected, "contextPacketHash") : null
  const modelInputHash = expected ? stringField(expected, "modelInputHash") : null
  if (!contextPacketHash || !modelInputHash) throw new Error("RSVP replay fixture missing expected hashes")
  return { contextPacketHash, modelInputHash }
}

function fixturePendingGuests(fixture: Record<string, unknown>): string[] {
  const snapshot = isRecord(fixture.snapshot) ? fixture.snapshot : null
  const raw = snapshot && Array.isArray(snapshot.pendingGuests) ? snapshot.pendingGuests : []
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
}

function fixtureAllowsOfflineReplay(fixture: Record<string, unknown>): void {
  if (fixture.schemaVersion !== 1 || fixture.policyVersion !== RSVP_REPLAY_POLICY_VERSION) {
    throw new Error("unsupported RSVP replay fixture")
  }
  const privacy = isRecord(fixture.privacy) ? fixture.privacy : null
  if (
    !privacy
    || privacy.rawLiveTranscriptStored !== false
    || privacy.searchIndex !== false
    || privacy.vectorIndex !== false
  ) {
    throw new Error("RSVP replay fixture must be minimized and private")
  }
}

function answerForPendingGuests(pendingGuests: string[]): string {
  return pendingGuests.length === 0
    ? "No pending guests in the replay fixture."
    : `Pending guests: ${pendingGuests.join(", ")}`
}

export async function replayRsvpFixture(input: ReplayRsvpFixtureInput): Promise<RsvpReplayResult> {
  const fixture = readJsonFile(input.fixturePath)
  if (!isRecord(fixture)) throw new Error("RSVP replay fixture must be an object")
  fixtureAllowsOfflineReplay(fixture)
  const expected = fixtureExpected(fixture)
  const pendingGuests = fixturePendingGuests(fixture)
  const result: RsvpReplayResult = {
    schemaVersion: 1,
    policyVersion: RSVP_REPLAY_RESULT_POLICY_VERSION,
    sideEffect: false,
    contextPacketHash: expected.contextPacketHash,
    modelInputHash: expected.modelInputHash,
    answer: answerForPendingGuests(pendingGuests),
    indexPolicy: { search: false, vector: false },
  }
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.replay_fixture_replayed",
    message: "replayed RSVP fixture offline",
    meta: { fixturePath: input.fixturePath, pendingGuests: pendingGuests.length },
  })
  return result
}

function hashFile(filePath: string): string {
  return sha256(fs.readFileSync(filePath, "utf-8"))
}

function legacyRootHash(legacyRoot: string): string {
  const entries = fs.readdirSync(legacyRoot)
    .sort()
    .map((name) => {
      const filePath = path.join(legacyRoot, name)
      const stat = fs.statSync(filePath)
      return stat.isFile() ? { name, hash: hashFile(filePath) } : { name, hash: "directory" }
    })
  return sha256(stableJson(entries))
}

function displayName(row: Record<string, unknown>): string | null {
  const display = stringField(row, "displayName")
  if (display) return display
  const first = stringField(row, "first_name") ?? ""
  const last = stringField(row, "last_name") ?? ""
  const combined = `${first} ${last}`.trim()
  return combined.length > 0 ? combined : null
}

function pendingGuestsFromLegacyRoot(legacyRoot: string): string[] {
  const guestsPath = path.join(legacyRoot, "guests.json")
  const parsed = readJsonFile(guestsPath)
  const guests = isRecord(parsed) && isRecord(parsed.guests) ? Object.values(parsed.guests) : []
  return guests
    .filter(isRecord)
    .filter((row) => stringField(row, "attending_status") === "pending" || stringField(row, "status") === "pending")
    .map(displayName)
    .filter((name): name is string => !!name)
}

export async function renderLegacyRsvpSnapshotOffline(input: RenderLegacyRsvpSnapshotOfflineInput): Promise<LegacyRsvpOfflineRenderResult> {
  const legacyRootHashBefore = legacyRootHash(input.legacyRoot)
  const pendingGuests = pendingGuestsFromLegacyRoot(input.legacyRoot)
  const legacyRootHashAfter = legacyRootHash(input.legacyRoot)
  const result: LegacyRsvpOfflineRenderResult = {
    schemaVersion: 1,
    sideEffect: false,
    outputPath: input.outputPath,
    legacyRootHashBefore,
    legacyRootHashAfter,
    pendingGuests,
  }
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })
  fs.writeFileSync(input.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8")
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.legacy_offline_rendered",
    message: "rendered legacy RSVP snapshot offline",
    meta: { legacyRoot: input.legacyRoot, outputPath: input.outputPath, pendingGuests: pendingGuests.length },
  })
  return result
}
