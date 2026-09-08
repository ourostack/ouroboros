import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { getAgentRoot } from "./identity"
import { emitNervesEvent } from "../nerves/runtime"
import { digestJson } from "../repertoire/tool-arguments"
import type { JsonValue } from "./approval-store"
import {
  isExactRawSessionRedactionMarker,
  parseSessionEnvelope,
  selectEffectiveSessionEvents,
  type SessionEnvelope,
  type SessionEvent,
} from "./session-events"
import { extractStructuredOutputsFromEvents } from "./structured-output"
import { readSessionTransaction, withSessionTurnLease, writeSessionTransaction, type SessionTurnLease } from "../mind/session-transaction"

const SCHEMA = "a003-sanctuary-session-repair-v1"
const SELECTOR = "a003-legacy-required-corrections-v1"
const POSITIONS = [86, 99, 107, 110, 113, 151, 221, 222] as const
const SESSION_LIMIT = 32 * 1024 * 1024
const MANIFEST_LIMIT = 1024 * 1024
const HASH = /^[a-f0-9]{64}$/u

interface Entry {
  target: SessionEvent
  targetSha256: string
  previousEventId: string | null
  nextEventId: string | null
  marker: SessionEvent
}

interface Manifest {
  schemaVersion: typeof SCHEMA
  selectorVersion: typeof SELECTOR
  agent: "sanctuary"
  sessionRelativePath: string
  capturedAt: string
  preimageRevision: string
  postimageRevision: string
  entries: Entry[]
}

interface Authority { manifestPath: string; manifestSha256: string }
interface RepairResult { status: "applied" | "not_applied" | "already_applied" | "indeterminate" | "rolled_back" | "already_rolled_back"; revision?: string }
interface DirectoryIdentity { path: string; dev: number; ino: number }

function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function refuse(reason: string): never {
  emitNervesEvent({
    level: "warn", component: "heart", event: "heart.session_redaction_repair_refused",
    message: "fixed session repair refused", meta: { reason },
  })
  throw new Error(reason)
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function iso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function directoryChain(directory: string): DirectoryIdentity[] {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) refuse("noncanonical directory path")
  let current = path.parse(directory).root
  const parts = [current]
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    parts.push(current)
  }
  return parts.map((file) => {
    const stat = fs.lstatSync(file)
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("directory symlink or type mismatch")
    return { path: file, dev: stat.dev, ino: stat.ino }
  })
}

function checkDirectories(pin: DirectoryIdentity[]): void {
  for (const entry of pin) {
    const stat = fs.lstatSync(entry.path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameInode(entry, stat)) refuse("directory identity changed")
  }
}

function privateDirectory(directory: string): DirectoryIdentity[] {
  const pin = directoryChain(directory)
  if ((fs.lstatSync(directory).mode & 0o777) !== 0o700) refuse("artifact directory must have mode 0700")
  return pin
}

function privateFile(file: string, label: string, limit: number): fs.Stats {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) refuse("noncanonical file path")
  directoryChain(path.dirname(file))
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) refuse(`${label} must be a regular file`)
  if ((stat.mode & 0o777) !== 0o600) refuse(`${label} must have mode 0600`)
  if (stat.size > limit) refuse(`${label} exceeds ${limit / (1024 * 1024)} MiB`)
  return stat
}

function readArtifact(file: string, label: string, limit: number): Buffer {
  const pin = privateDirectory(path.dirname(file))
  const original = privateFile(file, label, limit)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || !sameInode(original, opened) || (opened.mode & 0o777) !== 0o600 || opened.size > limit) refuse("artifact identity changed")
    const bytes = fs.readFileSync(fd)
    checkDirectories(pin)
    if (bytes.length > limit || !sameInode(opened, fs.lstatSync(file))) refuse("artifact changed during read")
    return bytes
  } finally { fs.closeSync(fd) }
}

function sessionLocation(agent: string, sessionPath: string): { root: string; relative: string } {
  if (agent !== "sanctuary") refuse("repair agent must be sanctuary")
  const root = path.join(getAgentRoot("sanctuary"), "state", "sessions")
  directoryChain(root)
  const relative = path.relative(root, sessionPath)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) refuse("session path escapes sanctuary")
  privateFile(sessionPath, "session", SESSION_LIMIT)
  return { root, relative: relative.split(path.sep).join("/") }
}

function manifestSessionPath(relative: string): string {
  if (!relative || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) refuse("invalid session relative path")
  const file = path.join(getAgentRoot("sanctuary"), "state", "sessions", relative)
  sessionLocation("sanctuary", file)
  return file
}

function marker(target: SessionEvent, sequence: number, capturedAt: string): SessionEvent {
  return {
    id: `evt-${String(sequence).padStart(6, "0")}`, sequence, role: "system", content: null,
    name: null, toolCallId: null, toolCalls: [], attachments: [],
    time: {
      authoredAt: null, authoredAtSource: "migration", observedAt: null, observedAtSource: "migration",
      recordedAt: capturedAt, recordedAtSource: "migration",
    },
    relations: {
      replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null,
      supersedesEventId: null, redactsEventId: target.id,
    },
    provenance: { captureKind: "migration", legacyVersion: 2, sourceMessageIndex: null },
  }
}

// Frozen constructor inputs, not a text/regex classifier and not live policy.
// The first media wording is the constructor shipped at 2efc01e5; the other
// finite variants are present in the P0 Sanctuary required-read contracts.
const LEGACY_CORRECTIONS = new Set<string>()
for (const [text, names] of [
  ["Before answering, read current active work, cares, system health, and service state. Then give Ari one compact household summary; do not ask him to choose a status slice.", ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers"]],
  ["Before answering, read current active work, cares, system health, service state, storage, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.", ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "sanctuary_get_download_queue"]],
  ["Run both safe reads now, identify the largest measured evidence, report Unmanic and Jellyfin findings, and propose a sample encode without inventing future savings. Do not ask permission or send Ari to a shell or QDirStat while these typed reads are available.", ["unraid_get_storage", "sanctuary_get_media_optimization"]],
  ["Run both safe reads now, identify the largest measured evidence, report Unmanic and Jellyfin findings, and propose a sample encode without inventing future savings. If one read returns a degraded or partial result, continue with the other safe reads and bounded container/log tools before answering. Do not ask permission or send Ari to a shell, dashboard, logs, or QDirStat while these typed reads are available.", ["unraid_get_storage", "sanctuary_get_media_optimization"]],
  ["Before answering, read current active work, cares, system health, service state, storage, notifications, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.", ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "unraid_get_notifications", "sanctuary_get_download_queue"]],
] as Array<[string, string[]]>) {
  for (let bits = 1; bits < 2 ** names.length; bits++) {
    LEGACY_CORRECTIONS.add(`${text} Missing required tool calls: ${names.filter((_name, index) => (bits & (1 << index)) !== 0).join(", ")}.`)
  }
}
for (const text of [
  "Use sanctuary_search_media_catalog before answering. If asked for taste or a favorite, form a light recommendation from returned catalog evidence instead of claiming you cannot have preferences. Keep it honest: say you cannot watch, but you can pick from the household shelf.",
  "Use sanctuary_search_media_catalog before answering. If a broader media-optimization read fails or degrades, treat that as a diagnostic note and still use the catalog tool for ordinary library visibility questions. If asked for taste or a favorite, form a light recommendation from returned catalog evidence instead of claiming you cannot have preferences. Keep it honest: say you cannot watch, but you can pick from the household shelf.",
  "Use sanctuary_search_media_catalog before answering, then report only the current shelf count in ordinary household language.",
  "Use sanctuary_search_media_catalog before answering. Lead with the direct answer from current catalog evidence, report the shelf count in ordinary household language, and stop without sampled titles or a follow-up question.",
  "Use sanctuary_search_media_catalog with the requested title before answering. Confirm its presence or absence directly from current catalog evidence.",
  "Use sanctuary_search_media_catalog before answering. Make one concise, decisive choice grounded in returned catalog evidence; do not volunteer an AI or 'I cannot watch' disclaimer.",
  "Use sanctuary_search_media_catalog before answering and base any named titles on the returned catalog evidence.",
  ...Array.from({ length: 20 }, (_, index) => `Use sanctuary_search_media_catalog with limit ${index + 1} before answering, then name exactly the returned catalog titles.`),
]) LEGACY_CORRECTIONS.add(`${text} Missing required tool calls: sanctuary_search_media_catalog.`)

export function selectA003LegacyRequiredCorrections(rawEvents: unknown): SessionEvent[] {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) refuse("legacy event set is missing")
  const events = rawEvents as SessionEvent[]
  if (events.some((event) => !event || typeof event !== "object" || event.relations?.redactsEventId != null)) refuse("legacy event set has a redaction conflict")
  const max = events.reduce((value, event) => Math.max(value, event.sequence), 0)
  const targets = POSITIONS.map((sequence) => events.find((event) => event.sequence === sequence))
  for (const target of targets) {
    if (!target || typeof target.content !== "string" || !LEGACY_CORRECTIONS.has(target.content)
      || !isExactRawSessionRedactionMarker(marker(target, max + 1, "1970-01-01T00:00:00.000Z"), [...events, marker(target, max + 1, "1970-01-01T00:00:00.000Z")])
      || target.name !== null || target.toolCallId !== null || target.toolCalls.length !== 0 || target.attachments.length !== 0
      || target.provenance.captureKind !== "live" || target.provenance.legacyVersion !== null || target.provenance.sourceMessageIndex !== null
      || target.time.authoredAt !== null || target.time.authoredAtSource !== "unknown" || target.time.observedAtSource !== "ingest"
      || target.time.recordedAtSource !== "save" || target.time.observedAt !== target.time.recordedAt
      || !isDeepStrictEqual(target.relations, { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null })) refuse("legacy correction constructor mismatch")
  }
  if (events.filter((event) => typeof event.content === "string" && LEGACY_CORRECTIONS.has(event.content)).length !== POSITIONS.length) refuse("extra or ambiguous legacy corrections")
  return targets as SessionEvent[]
}

function rawEnvelope(bytes: string): SessionEnvelope {
  if (Buffer.byteLength(bytes) > SESSION_LIMIT) refuse("session exceeds 32 MiB")
  const value: unknown = JSON.parse(bytes)
  const parsed = parseSessionEnvelope(value)
  if (!parsed || !value || typeof value !== "object" || (value as { version?: unknown }).version !== 2) refuse("session must be a v2 envelope")
  const envelope = value as SessionEnvelope
  if (JSON.stringify(value, null, 2) !== bytes) refuse("session bytes are not canonical transaction serialization")
  if (!isDeepStrictEqual(envelope.events, parsed.events)) refuse("session requires normalization")
  const projection = envelope.projection
  if (!exactKeys(projection, ["eventIds", "trimmed", "maxTokens", "contextMargin", "inputTokens", "projectedAt"])
    || !Array.isArray(projection.eventIds) || projection.eventIds.some((id) => typeof id !== "string")
    || typeof projection.trimmed !== "boolean"
    || ![projection.maxTokens, projection.contextMargin, projection.inputTokens].every((value) => value === null || typeof value === "number")
    || !(projection.projectedAt === null || iso(projection.projectedAt))) refuse("invalid session projection")
  const byId = new Map(envelope.events.map((event) => [event.id, event]))
  let sequence = 0
  for (const id of projection.eventIds as string[]) {
    const event = byId.get(id)
    if (!event || event.sequence <= sequence) refuse("invalid projection order or identity")
    sequence = event.sequence
  }
  return envelope
}

function compute(bytes: string, relative: string, capturedAt: string): { manifest: Manifest; postimage: SessionEnvelope } {
  const envelope = rawEnvelope(bytes)
  const targets = selectA003LegacyRequiredCorrections(envelope.events)
  const max = envelope.events.reduce((value, event) => Math.max(value, event.sequence), 0)
  const entries = targets.map((target, index) => {
    const position = envelope.events.indexOf(target)
    return {
      target, targetSha256: digestJson(target as unknown as JsonValue),
      previousEventId: envelope.events[position - 1]?.id ?? null,
      nextEventId: envelope.events[position + 1]?.id ?? null,
      marker: marker(target, max + index + 1, capturedAt),
    }
  })
  const events = [...envelope.events, ...entries.map((entry) => entry.marker)]
  if (!entries.every((entry) => isExactRawSessionRedactionMarker(entry.marker, events))) refuse("invalid computed marker block")
  const removed = new Set(entries.flatMap((entry) => [entry.target.id, entry.marker.id]))
  const postimage: SessionEnvelope = {
    ...envelope, events,
    projection: { ...envelope.projection, eventIds: envelope.projection.eventIds.filter((id) => !removed.has(id)) },
    structuredOutputs: extractStructuredOutputsFromEvents(selectEffectiveSessionEvents(events), { emitTelemetry: false }),
  }
  const postBytes = JSON.stringify(postimage, null, 2)
  if (Buffer.byteLength(postBytes) > SESSION_LIMIT) refuse("postimage exceeds 32 MiB")
  return {
    manifest: { schemaVersion: SCHEMA, selectorVersion: SELECTOR, agent: "sanctuary", sessionRelativePath: relative, capturedAt, preimageRevision: sha(bytes), postimageRevision: sha(postBytes), entries },
    postimage,
  }
}

function readManifest(authority: Authority): Manifest {
  if (typeof authority.manifestSha256 !== "string" || !HASH.test(authority.manifestSha256)) refuse("invalid manifest hash")
  const bytes = readArtifact(authority.manifestPath, "manifest", MANIFEST_LIMIT)
  if (sha(bytes) !== authority.manifestSha256) refuse("manifest hash changed")
  const value: unknown = JSON.parse(bytes.toString("utf8"))
  if (!exactKeys(value, ["schemaVersion", "selectorVersion", "agent", "sessionRelativePath", "capturedAt", "preimageRevision", "postimageRevision", "entries"])
    || value.schemaVersion !== SCHEMA || value.selectorVersion !== SELECTOR || value.agent !== "sanctuary"
    || typeof value.sessionRelativePath !== "string" || !iso(value.capturedAt)
    || typeof value.preimageRevision !== "string" || !HASH.test(value.preimageRevision)
    || typeof value.postimageRevision !== "string" || !HASH.test(value.postimageRevision)
    || !Array.isArray(value.entries) || value.entries.length !== POSITIONS.length
    || JSON.stringify(value, null, 2) !== bytes.toString("utf8")) refuse("invalid closed repair manifest")
  for (const entry of value.entries) {
    if (!exactKeys(entry, ["target", "targetSha256", "previousEventId", "nextEventId", "marker"])
      || typeof entry.targetSha256 !== "string" || !HASH.test(entry.targetSha256)
      || ![entry.previousEventId, entry.nextEventId].every((id) => id === null || typeof id === "string" && id.trim().length > 0)) refuse("invalid manifest entry")
  }
  const manifest = value as unknown as Manifest
  const targets = selectA003LegacyRequiredCorrections(manifest.entries.map((entry) => entry.target))
  const block = manifest.entries.map((entry) => entry.marker)
  for (let index = 0; index < manifest.entries.length; index++) {
    const entry = manifest.entries[index]!
    if (!isDeepStrictEqual(entry.target, targets[index])
      || entry.targetSha256 !== digestJson(entry.target as unknown as JsonValue)
      || !isExactRawSessionRedactionMarker(entry.marker, [...targets, ...block])
      || !isDeepStrictEqual(entry.marker, marker(entry.target, block[0]!.sequence + index, manifest.capturedAt))) refuse("manifest target or marker mismatch")
  }
  return manifest
}

function publishArtifacts(directory: string, artifacts: Array<{ path: string; bytes: Buffer }>): void {
  const pin = privateDirectory(directory)
  for (const artifact of artifacts) {
    try { fs.lstatSync(artifact.path); refuse("final artifact already exists") } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const created: Array<{ temporary: string; final: string; identity: fs.Stats | null; published: boolean }> = []
  try {
    for (const artifact of artifacts) {
      checkDirectories(pin)
      const record = { temporary: path.join(directory, `.${path.basename(artifact.path)}.${randomUUID()}`), final: artifact.path, identity: null as fs.Stats | null, published: false }
      created.push(record)
      const fd = fs.openSync(record.temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      try {
        record.identity = fs.fstatSync(fd)
        fs.writeFileSync(fd, artifact.bytes)
        fs.fsyncSync(fd)
      } catch (error) {
        try { fs.closeSync(fd) } catch {
          emitNervesEvent({ level: "warn", component: "heart", event: "heart.session_repair_artifact_cleanup_refused", message: "artifact descriptor cleanup failed; primary error retained", meta: { stage: "descriptor" } })
        }
        throw error
      }
      fs.closeSync(fd)
      checkDirectories(pin)
      fs.linkSync(record.temporary, record.final)
      record.published = true
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
      checkDirectories(pin)
      const readFd = fs.openSync(record.final, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const stat = fs.fstatSync(readFd)
        if (!stat.isFile() || !sameInode(record.identity, stat) || (stat.mode & 0o777) !== 0o600 || stat.size !== artifact.bytes.length
          || sha(fs.readFileSync(readFd)) !== sha(artifact.bytes)) refuse("published artifact identity or hash mismatch")
      } finally { fs.closeSync(readFd) }
    }
  } catch (error) {
    for (const record of created) {
      if (!record.published || !record.identity) continue
      try {
        checkDirectories(pin)
        const current = fs.lstatSync(record.final)
        if (current.isFile() && !current.isSymbolicLink() && sameInode(current, record.identity)) fs.unlinkSync(record.final)
      } catch {
        emitNervesEvent({ level: "warn", component: "heart", event: "heart.session_repair_artifact_cleanup_refused", message: "artifact cleanup could not safely address its original file", meta: { stage: "final" } })
      }
    }
    throw error
  } finally {
    for (const record of created) {
      if (!record.identity) continue
      try {
        checkDirectories(pin)
        const current = fs.lstatSync(record.temporary)
        if (current.isFile() && !current.isSymbolicLink() && sameInode(current, record.identity)) fs.unlinkSync(record.temporary)
      } catch {
        emitNervesEvent({ level: "warn", component: "heart", event: "heart.session_repair_artifact_cleanup_refused", message: "artifact cleanup could not safely address its original file", meta: { stage: "sibling" } })
      }
    }
  }
}

export async function inspectA003SessionRepair(input: { agent: string; sessionPath: string; artifactsDir: string }) {
  const location = sessionLocation(input.agent, input.sessionPath)
  privateDirectory(input.artifactsDir)
  return withSessionTurnLease(input.sessionPath, async (lease) => {
    privateFile(input.sessionPath, "session", SESSION_LIMIT)
    const current = readSessionTransaction(input.sessionPath, lease)
    const { manifest } = compute(current.bytes, location.relative, new Date().toISOString())
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2))
    if (manifestBytes.length > MANIFEST_LIMIT) refuse("manifest exceeds 1 MiB")
    const manifestPath = path.join(input.artifactsDir, "a003-session-manifest.json")
    const preimagePath = path.join(input.artifactsDir, "a003-session-preimage.json")
    publishArtifacts(input.artifactsDir, [{ path: preimagePath, bytes: Buffer.from(current.bytes) }, { path: manifestPath, bytes: manifestBytes }])
    emitNervesEvent({ component: "heart", event: "heart.session_redaction_repair_inspected", message: "fixed repair inspected without session mutation", meta: { targetCount: manifest.entries.length } })
    return { status: "inspected" as const, manifestPath, preimagePath, manifestSha256: sha(manifestBytes), preimageRevision: manifest.preimageRevision, postimageRevision: manifest.postimageRevision }
  }, { confinementRoot: location.root })
}

function alreadyApplied(envelope: SessionEnvelope, manifest: Manifest, currentRevision: string): boolean {
  const blockIndex = envelope.events.findIndex((event) => event.id === manifest.entries[0]!.marker.id)
  if (blockIndex < 0 || !isDeepStrictEqual(envelope.events.slice(blockIndex, blockIndex + POSITIONS.length), manifest.entries.map((entry) => entry.marker))) return false
  if (currentRevision !== manifest.postimageRevision && envelope.events.at(-1)!.sequence <= manifest.entries.at(-1)!.marker.sequence) return false
  try {
    const targets = selectA003LegacyRequiredCorrections(envelope.events.slice(0, blockIndex))
    if (!isDeepStrictEqual(targets, manifest.entries.map((entry) => entry.target))) return false
  } catch { return false }
  const marked = envelope.events.filter((event) => event.relations.redactsEventId !== null)
  if (!isDeepStrictEqual(marked, manifest.entries.map((entry) => entry.marker))
    || !marked.every((event) => isExactRawSessionRedactionMarker(event, envelope.events))) return false
  const effective = selectEffectiveSessionEvents(envelope.events)
  const visible = new Set(effective.map((event) => event.id))
  return envelope.projection.eventIds.every((id) => visible.has(id))
    && isDeepStrictEqual(envelope.structuredOutputs, extractStructuredOutputsFromEvents(effective, { emitTelemetry: false }))
}

async function reconcileWrite(
  sessionPath: string, lease: SessionTurnLease, value: unknown, before: string, after: string, success: "applied" | "rolled_back",
): Promise<RepairResult> {
  try { writeSessionTransaction(sessionPath, value, { lease, expectedRevision: before }) } catch {
    // A throw may occur after rename; only exact, still-confined readback decides.
  }
  try {
    privateFile(sessionPath, "session", SESSION_LIMIT)
    const current = readSessionTransaction(sessionPath, lease)
    if (current.revision === after) return { status: success, revision: after }
    if (current.revision === before) return { status: "not_applied", revision: before }
  } catch { return { status: "indeterminate" } }
  return { status: "indeterminate" }
}

export async function applyA003SessionRepair(authority: Authority): Promise<RepairResult> {
  const manifest = readManifest(authority)
  const sessionPath = manifestSessionPath(manifest.sessionRelativePath)
  const { root } = sessionLocation("sanctuary", sessionPath)
  let attemptedWrite = false
  try {
    const result = await withSessionTurnLease(sessionPath, async (lease) => {
      privateFile(sessionPath, "session", SESSION_LIMIT)
      const current = readSessionTransaction(sessionPath, lease)
      if (current.revision !== manifest.preimageRevision) {
        let envelope: SessionEnvelope
        try { envelope = rawEnvelope(current.bytes) } catch { return { status: "indeterminate" as const } }
        if (alreadyApplied(envelope, manifest, current.revision)) return { status: "already_applied" as const, revision: current.revision }
        if (!envelope.events.some((event) => event.relations.redactsEventId !== null)) refuse("session preimage revision changed")
        return { status: "indeterminate" as const }
      }
      const computed = compute(current.bytes, manifest.sessionRelativePath, manifest.capturedAt)
      if (!isDeepStrictEqual(computed.manifest, manifest)) refuse("manifest differs from independently computed repair")
      attemptedWrite = true
      return reconcileWrite(sessionPath, lease, computed.postimage, manifest.preimageRevision, manifest.postimageRevision, "applied")
    }, { confinementRoot: root })
    emitNervesEvent({ component: "heart", event: "heart.session_redaction_repair_applied", message: "fixed repair apply readback classified", meta: { status: result.status } })
    return result
  } catch (error) {
    if (attemptedWrite) return { status: "indeterminate" }
    throw error
  }
}

export async function rollbackA003SessionRepair(authority: Authority & { preimagePath: string }): Promise<RepairResult> {
  const manifest = readManifest(authority)
  const preimage = readArtifact(authority.preimagePath, "preimage", SESSION_LIMIT)
  if (sha(preimage) !== manifest.preimageRevision) refuse("preimage digest mismatch")
  const computed = compute(preimage.toString("utf8"), manifest.sessionRelativePath, manifest.capturedAt)
  if (!isDeepStrictEqual(computed.manifest, manifest)) refuse("rollback manifest differs from preimage")
  const value: unknown = JSON.parse(preimage.toString("utf8"))
  const sessionPath = manifestSessionPath(manifest.sessionRelativePath)
  const { root } = sessionLocation("sanctuary", sessionPath)
  let attemptedWrite = false
  try {
    const result = await withSessionTurnLease(sessionPath, async (lease) => {
      privateFile(sessionPath, "session", SESSION_LIMIT)
      const current = readSessionTransaction(sessionPath, lease)
      if (current.revision === manifest.preimageRevision) return { status: "already_rolled_back" as const, revision: current.revision }
      if (current.revision !== manifest.postimageRevision) refuse("rollback requires the exact untouched postimage")
      attemptedWrite = true
      return reconcileWrite(sessionPath, lease, value, manifest.postimageRevision, manifest.preimageRevision, "rolled_back")
    }, { confinementRoot: root })
    emitNervesEvent({ component: "heart", event: "heart.session_redaction_repair_rolled_back", message: "fixed repair rollback readback classified", meta: { status: result.status } })
    return result
  } catch (error) {
    if (attemptedWrite) return { status: "indeterminate" }
    throw error
  }
}
