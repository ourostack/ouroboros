import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { a003Event, a003LegacyEnvelope, a003Marker, A003_LEGACY_MEDIA, A003_POSITIONS, A003_REPAIR_AT } from "../fixtures/a003-session"
import type { SessionEvent } from "../../heart/session-events"
import * as transactions from "../../mind/session-transaction"

const context = vi.hoisted(() => ({ root: "" }))
// Keep every native filesystem implementation; only the ESM export facade is
// configurable so fault/race spies can wrap real calls on this Vitest host.
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }))
vi.mock("../../heart/identity", async (original) => ({
  ...await original<typeof import("../../heart/identity")>(),
  getAgentRoot: (agent: string) => path.join(context.root, `${agent}.ouro`),
}))

interface InspectResult {
  status: "inspected"
  manifestPath: string
  preimagePath: string
  manifestSha256: string
  preimageRevision: string
  postimageRevision: string
}
interface RepairResult { status: string; revision?: string }
interface Runner {
  selectA003LegacyRequiredCorrections(raw: unknown): SessionEvent[]
  inspectA003SessionRepair(input: { agent: string; sessionPath: string; artifactsDir: string }): Promise<InspectResult>
  applyA003SessionRepair(input: { manifestPath: string; manifestSha256: string }): Promise<RepairResult>
  rollbackA003SessionRepair(input: { manifestPath: string; manifestSha256: string; preimagePath: string }): Promise<RepairResult>
}
async function runner(): Promise<Runner> {
  // A dynamic production-boundary import makes each case an independently
  // executable missing-module red without preventing the suite from loading.
  const modulePath = "../../heart/session-redaction-repair"
  return import(modulePath) as Promise<Runner>
}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")

function canonicalValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
  return value
}

function expectedRepair(bytes: string, sequences: readonly number[] = A003_POSITIONS) {
  const raw = JSON.parse(bytes) as ReturnType<typeof a003LegacyEnvelope>
  const entries = sequences.map((sequence, index) => {
    const position = raw.events.findIndex((event) => event.sequence === sequence)
    const target = raw.events[position]!
    return {
      target,
      targetSha256: hash(JSON.stringify(canonicalValue(target))),
      previousEventId: raw.events[position - 1]?.id ?? null,
      nextEventId: raw.events[position + 1]?.id ?? null,
      marker: a003Marker(target, Math.max(...raw.events.map((event) => event.sequence)) + index + 1),
    }
  })
  const removed = new Set(entries.flatMap((entry) => [entry.target.id, entry.marker.id]))
  const postimage = JSON.stringify({
    ...raw,
    events: [...raw.events, ...entries.map((entry) => entry.marker)],
    projection: { ...raw.projection, eventIds: raw.projection.eventIds.filter((id) => !removed.has(id)) },
    structuredOutputs: a003LegacyEnvelope().structuredOutputs,
  }, null, 2)
  const manifest = {
    schemaVersion: "a003-sanctuary-session-repair-v1",
    selectorVersion: "a003-legacy-required-corrections-v1",
    agent: "sanctuary",
    sessionRelativePath: "ari/telegram/owner.json",
    capturedAt: A003_REPAIR_AT,
    preimageRevision: hash(bytes),
    postimageRevision: hash(postimage),
    entries,
  }
  return { manifest, postimage, manifestBytes: JSON.stringify(manifest, null, 2) }
}

describe("A003 fixed session repair", () => {
  let sessionPath: string
  let artifactsDir: string
  let original: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(A003_REPAIR_AT))
    context.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "a003-repair-")))
    sessionPath = path.join(context.root, "sanctuary.ouro", "state", "sessions", "ari", "telegram", "owner.json")
    artifactsDir = path.join(context.root, "private")
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 })
    fs.mkdirSync(artifactsDir, { mode: 0o700 })
    original = JSON.stringify(a003LegacyEnvelope(), null, 2)
    fs.writeFileSync(sessionPath, original, { mode: 0o600 })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    fs.rmSync(context.root, { recursive: true, force: true })
  })
  async function inspect() {
    const r = await runner()
    return r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })
  }
  function writeManifest(file: string, value: unknown): string {
    const bytes = JSON.stringify(value, null, 2)
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    return hash(bytes)
  }

  it("uses real filesystem functions through the configurable fault-injection facade", async () => {
    const native = await vi.importActual<typeof import("node:fs")>("node:fs")
    expect(fs.openSync).toBe(native.openSync)
    expect(fs.readFileSync).toBe(native.readFileSync)
    const open = vi.spyOn(fs, "openSync")
    const fd = fs.openSync(sessionPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      expect(fs.readFileSync(fd, "utf8")).toBe(original)
      expect(fs.fstatSync(fd).ino).toBe(native.statSync(sessionPath).ino)
      expect(open).toHaveBeenCalledOnce()
    } finally { fs.closeSync(fd) }
  })

  it("selects all eight exact constructor outputs without accepting target coordinates", async () => {
    const r = await runner()
    const raw = JSON.parse(original)
    const before = structuredClone(raw)
    const selected = r.selectA003LegacyRequiredCorrections(raw.events)
    expect(selected.map((event) => event.sequence)).toEqual(A003_POSITIONS)
    expect(selected).toEqual(A003_POSITIONS.map((sequence) => raw.events[sequence - 1]))
    expect(raw).toEqual(before)
    const shuffledContent = structuredClone(raw.events)
    shuffledContent[220].content = A003_LEGACY_MEDIA.replace("Missing required tool calls:", "Missing required tool call:")
    expect(() => r.selectA003LegacyRequiredCorrections(shuffledContent)).toThrow()
  })

  it.each([
    // Exact historical constructor inputs: 201a88ec, 9631b6a0, 088601d7, cf15cbdd.
    "Before answering, read current active work, cares, system health, and service state. Then give Ari one compact household summary; do not ask him to choose a status slice. Missing required tool calls: query_active_work, query_cares, unraid_get_system, unraid_list_containers.",
    "Before answering, read current active work, cares, system health, service state, storage, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice. Missing required tool calls: query_active_work, query_cares, unraid_get_system, unraid_list_containers, unraid_get_storage, sanctuary_get_download_queue.",
    "Run both safe reads now, identify the largest measured evidence, report Unmanic and Jellyfin findings, and propose a sample encode without inventing future savings. Do not ask permission or send Ari to a shell or QDirStat while these typed reads are available. Missing required tool calls: unraid_get_storage, sanctuary_get_media_optimization.",
    "Use sanctuary_search_media_catalog before answering. If a broader media-optimization read fails or degrades, treat that as a diagnostic note and still use the catalog tool for ordinary library visibility questions. If asked for taste or a favorite, form a light recommendation from returned catalog evidence instead of claiming you cannot have preferences. Keep it honest: say you cannot watch, but you can pick from the household shelf. Missing required tool calls: sanctuary_search_media_catalog.",
  ])("accepts the exact audited-position set with historical constructor %s", async (content) => {
    const r = await runner()
    const raw = JSON.parse(original)
    for (const sequence of A003_POSITIONS) raw.events[sequence - 1].content = content
    expect(r.selectA003LegacyRequiredCorrections(raw.events)).toEqual(A003_POSITIONS.map((sequence) => raw.events[sequence - 1]))
    raw.events[223].content = content
    expect(() => r.selectA003LegacyRequiredCorrections(raw.events)).toThrow()
  })

  it.each(["absent", "extra", "ambiguous-id", "ambiguous-sequence", "reordered", "wrong-role", "name", "tool-call", "attachment", "normalization", "provenance", "relation", "unknown-field", "constructor", "non-array", "partial-marker"])(
    "refuses the whole fixed selection for %s",
    async (mutation) => {
      const r = await runner()
      const raw = JSON.parse(original)
      const target = raw.events[85]
      if (mutation === "absent") raw.events.splice(85, 1)
      if (mutation === "extra") raw.events[223] = a003Event(224, "user", A003_LEGACY_MEDIA)
      if (mutation === "ambiguous-id") raw.events[84].id = target.id
      if (mutation === "ambiguous-sequence") raw.events[84].sequence = target.sequence
      if (mutation === "reordered") [raw.events[85], raw.events[86]] = [raw.events[86], raw.events[85]]
      if (mutation === "wrong-role") target.role = "assistant"
      if (mutation === "name") target.name = "Ari"
      if (mutation === "tool-call") target.toolCalls = [{ id: "x", type: "function", function: { name: "probe", arguments: "{}" } }]
      if (mutation === "attachment") target.attachments = ["file"]
      if (mutation === "normalization") target.content = `[just now] ${target.content}`
      if (mutation === "provenance") target.provenance.captureKind = "synthetic"
      if (mutation === "relation") target.relations.references = ["human-ingress"]
      if (mutation === "unknown-field") target.extra = true
      if (mutation === "constructor") target.content += " "
      if (mutation === "partial-marker") raw.events.push(a003Marker(target, 231))
      expect(() => r.selectA003LegacyRequiredCorrections(mutation === "non-array" ? null : raw.events)).toThrow()
    },
  )

  it("inspect is session-read-only and publishes exact bounded private no-replace artifacts", async () => {
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    const result = await inspect()
    expect(result.status).toBe("inspected")
    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
    expect(fs.readdirSync(artifactsDir).sort()).toEqual([path.basename(result.manifestPath), path.basename(result.preimagePath)].sort())
    for (const file of [result.manifestPath, result.preimagePath]) {
      expect(fs.lstatSync(file).isFile()).toBe(true)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
    expect(fs.readFileSync(result.preimagePath, "utf8")).toBe(original)
    expect(result.preimageRevision).toBe(hash(original))
    expect(result.manifestSha256).toBe(hash(fs.readFileSync(result.manifestPath)))
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"))
    expect(manifest).toEqual(expectedRepair(original).manifest)
    expect(fs.readFileSync(result.manifestPath, "utf8")).toBe(expectedRepair(original).manifestBytes)
    expect(Object.keys(manifest).sort()).toEqual(["schemaVersion", "selectorVersion", "agent", "sessionRelativePath", "capturedAt", "preimageRevision", "postimageRevision", "entries"].sort())
    expect(manifest.schemaVersion).toBe("a003-sanctuary-session-repair-v1")
    expect(manifest.agent).toBe("sanctuary")
    expect(manifest.sessionRelativePath).toBe("ari/telegram/owner.json")
    expect(manifest.entries).toHaveLength(8)
    expect(manifest.entries.map((entry: any) => entry.target.sequence)).toEqual(A003_POSITIONS)
    expect(manifest.entries.map((entry: any) => entry.marker.sequence)).toEqual([231, 232, 233, 234, 235, 236, 237, 238])
    for (const entry of manifest.entries) {
      expect(entry.target).toEqual(JSON.parse(original).events[entry.target.sequence - 1])
      expect(entry.previousEventId).toBe(`evt-${String(entry.target.sequence - 1).padStart(6, "0")}`)
      expect(entry.nextEventId).toBe(`evt-${String(entry.target.sequence + 1).padStart(6, "0")}`)
      expect(entry.marker.relations.redactsEventId).toBe(entry.target.id)
    }
    const inode = fs.statSync(result.manifestPath).ino
    const backupInode = fs.statSync(result.preimagePath).ino
    await expect(inspect()).rejects.toThrow()
    expect(fs.statSync(result.manifestPath).ino).toBe(inode)
    expect(fs.statSync(result.preimagePath).ino).toBe(backupInode)
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it.each(["wrong-agent", "escape", "session-link", "parent-link", "root-link", "agent-link", "state-link", "friend-link", "artifact-link", "artifact-parent-link", "directory-file", "session-mode", "directory-mode", "oversize-session", "noncanonical-bytes"])(
    "inspect refuses %s before publishing or changing session evidence",
    async (mutation) => {
      const r = await runner()
      let candidate = sessionPath
      let agent = "sanctuary"
      if (mutation === "wrong-agent") agent = "other"
      if (mutation === "escape") { candidate = path.join(context.root, "escape.json"); fs.writeFileSync(candidate, original, { mode: 0o600 }) }
      if (mutation === "session-link") { fs.renameSync(sessionPath, `${sessionPath}.actual`); fs.symlinkSync(`${sessionPath}.actual`, sessionPath) }
      if (["parent-link", "root-link", "agent-link", "state-link", "friend-link"].includes(mutation)) {
        const component = mutation === "parent-link" ? path.dirname(sessionPath)
          : mutation === "agent-link" ? path.join(context.root, "sanctuary.ouro")
          : mutation === "state-link" ? path.join(context.root, "sanctuary.ouro", "state")
          : mutation === "friend-link" ? path.dirname(path.dirname(sessionPath))
          : path.join(context.root, "sanctuary.ouro", "state", "sessions")
        fs.renameSync(component, `${component}.actual`); fs.symlinkSync(`${component}.actual`, component)
      }
      if (mutation === "artifact-link") { fs.renameSync(artifactsDir, `${artifactsDir}.actual`); fs.symlinkSync(`${artifactsDir}.actual`, artifactsDir) }
      if (mutation === "artifact-parent-link") {
        const link = path.join(context.root, "linked"); fs.symlinkSync(context.root, link); artifactsDir = path.join(link, "private")
      }
      if (mutation === "directory-file") { fs.unlinkSync(sessionPath); fs.mkdirSync(sessionPath) }
      if (mutation === "session-mode") fs.chmodSync(sessionPath, 0o644)
      if (mutation === "directory-mode") fs.chmodSync(artifactsDir, 0o755)
      if (mutation === "oversize-session") {
        const oversized = JSON.parse(original); oversized.events[0].content = "x".repeat(32 * 1024 * 1024)
        fs.writeFileSync(sessionPath, JSON.stringify(oversized, null, 2))
      }
      if (mutation === "noncanonical-bytes") fs.writeFileSync(sessionPath, `${original}\n`)
      const before = mutation === "directory-file" ? null : hash(fs.readFileSync(candidate))
      await expect(r.inspectA003SessionRepair({ agent, sessionPath: candidate, artifactsDir })).rejects.toThrow()
      expect(fs.readdirSync(artifactsDir)).toEqual([])
      if (before) expect(hash(fs.readFileSync(candidate))).toBe(before)
    },
  )

  it.each(["create", "write", "file-fsync", "link", "directory-fsync", "reopen", "hash"].flatMap((fault) => [1, 2].map((ordinal) => ({ fault, ordinal }))))("inspect contains artifact $ordinal $fault faults without a partial final authority", async ({ fault, ordinal }) => {
    const r = await runner()
    const open = fs.openSync
    const write = fs.writeFileSync
    const sync = fs.fsyncSync
    const link = fs.linkSync
    const read = fs.readFileSync
    const artifactFds = new Set<number>()
    let fired = false
    let hits = 0
    const selected = () => !fired && ++hits === ordinal
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: number | string, mode?: number) => {
      const artifact = String(file).startsWith(`${artifactsDir}${path.sep}`)
      const create = typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0
      if (artifact && (fault === "create" && create || fault === "reopen" && !create) && selected()) { fired = true; throw new Error("injected artifact open fault") }
      const fd = open(file, flags, mode)
      if (artifact) artifactFds.add(fd)
      return fd
    }) as typeof fs.openSync)
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (fault === "write" && typeof file === "number" && artifactFds.has(file) && selected()) { fired = true; throw new Error("injected write fault") }
      return (write as any)(file, ...args)
    }) as typeof fs.writeFileSync)
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if ((fault === "file-fsync" && artifactFds.has(fd) && fs.fstatSync(fd).isFile() || fault === "directory-fsync" && fs.fstatSync(fd).isDirectory()) && selected()) { fired = true; throw new Error("injected fsync fault") }
      return sync(fd)
    })
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (fault === "link" && String(to).startsWith(artifactsDir) && selected()) { fired = true; throw new Error("injected link fault") }
      return link(from, to)
    })
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (fault === "hash" && typeof file === "number" && artifactFds.has(file) && selected()) { fired = true; return Buffer.from("corrupt reopened artifact") }
      return (read as any)(file, ...args)
    }) as typeof fs.readFileSync)
    await expect(r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })).rejects.toThrow()
    expect(fired).toBe(true)
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
    expect(fs.readdirSync(artifactsDir).filter((name) => !name.startsWith("."))).toEqual([])
  })

  it("publishes only complete fsynced siblings using explicit exclusive no-follow opens", async () => {
    const r = await runner()
    const realOpen = fs.openSync
    const realSync = fs.fsyncSync
    const realLink = fs.linkSync
    const synced = new Set<string>()
    const inode = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`
    let creates = 0
    let links = 0
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: number | string, mode?: number) => {
      if (String(file).startsWith(`${artifactsDir}/`) && typeof flags === "number" && (flags & fs.constants.O_CREAT)) {
        creates++
        expect(path.basename(String(file))).toMatch(/^\./u)
        expect(flags & (fs.constants.O_EXCL | fs.constants.O_NOFOLLOW)).toBe(fs.constants.O_EXCL | fs.constants.O_NOFOLLOW)
        expect(mode).toBe(0o600)
      }
      return realOpen(file, flags, mode)
    }) as typeof fs.openSync)
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { synced.add(inode(fs.fstatSync(fd))); return realSync(fd) })
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      links++
      expect(synced.has(inode(fs.statSync(from)))).toBe(true)
      expect([original, expectedRepair(original).manifestBytes]).toContain(fs.readFileSync(from, "utf8"))
      expect(fs.existsSync(to)).toBe(false)
      realLink(from, to)
      expect(fs.statSync(to).ino).toBe(fs.statSync(from).ino)
      expect(fs.readFileSync(to, "utf8")).toBe(fs.readFileSync(from, "utf8"))
    })
    await r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })
    expect(creates).toBe(2)
    expect(links).toBe(2)
  })

  it.each([1, 2])("preserves a competing final artifact at publication %s", async (ordinal) => {
    const r = await runner()
    const realLink = fs.linkSync
    let calls = 0
    let competing = ""
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (++calls === ordinal) { competing = String(to); fs.writeFileSync(to, "competing final", { flag: "wx", mode: 0o600 }) }
      return realLink(from, to)
    })
    await expect(r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })).rejects.toThrow()
    expect(competing).not.toBe("")
    expect(fs.readFileSync(competing, "utf8")).toBe("competing final")
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it.each([1, 2])("refuses same-content different-inode replacement before artifact %s reopen", async (ordinal) => {
    const r = await runner()
    const realOpen = fs.openSync
    let calls = 0
    let replaced = ""
    let replacementInode = 0
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: number | string, mode?: number) => {
      if (String(file).startsWith(`${artifactsDir}/`) && !path.basename(String(file)).startsWith(".")
        && typeof flags === "number" && !(flags & fs.constants.O_CREAT) && ++calls === ordinal) {
        replaced = String(file)
        const bytes = fs.readFileSync(file)
        fs.renameSync(file, path.join(artifactsDir, `.prior-${ordinal}`))
        fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" })
        replacementInode = fs.statSync(file).ino
      }
      return realOpen(file, flags, mode)
    }) as typeof fs.openSync)
    await expect(r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })).rejects.toThrow()
    expect(replaced).not.toBe("")
    expect(fs.statSync(replaced).ino).toBe(replacementInode)
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it.each(["apply", "rollback"].flatMap((operation) => ["agent", "state", "sessions", "friend", "channel", "session", "mode", "type"].map((component) => ({ operation, component }))))(
    "rechecks $component confinement immediately before $operation",
    async ({ operation, component }) => {
      const r = await runner()
      const artifact = await inspect()
      if (operation === "rollback") await r.applyA003SessionRepair(artifact)
      const bytes = fs.readFileSync(sessionPath, "utf8")
      const components = {
        agent: path.join(context.root, "sanctuary.ouro"),
        state: path.join(context.root, "sanctuary.ouro", "state"),
        sessions: path.join(context.root, "sanctuary.ouro", "state", "sessions"),
        friend: path.dirname(path.dirname(sessionPath)), channel: path.dirname(sessionPath), session: sessionPath,
      }
      let sentinel: string | undefined
      if (component in components) {
        const from = components[component as keyof typeof components]
        const outside = path.join(context.root, "outside")
        fs.renameSync(from, outside); fs.symlinkSync(outside, from)
        sentinel = path.join(outside, path.relative(from, sessionPath))
      } else if (component === "mode") fs.chmodSync(sessionPath, 0o644)
      else { fs.renameSync(sessionPath, `${sessionPath}.original`); fs.mkdirSync(sessionPath); sentinel = `${sessionPath}.original` }
      const write = vi.spyOn(transactions, "writeSessionTransaction")
      const lease = vi.spyOn(transactions, "withSessionTurnLease")
      await expect(operation === "apply" ? r.applyA003SessionRepair(artifact) : r.rollbackA003SessionRepair(artifact)).rejects.toThrow()
      expect(write).not.toHaveBeenCalled()
      expect(lease).not.toHaveBeenCalled()
      expect(fs.readFileSync(sentinel ?? sessionPath, "utf8")).toBe(bytes)
    },
  )

  it.each(["apply", "rollback"].flatMap((operation) => ["state", "channel"].flatMap((component) => ["lease-pending", "lease-held", "before-rename"].map((timing) => ({ operation, component, timing })))))(
    "contains a $component replacement during $operation at $timing",
    async ({ operation, component, timing }) => {
      const r = await runner()
      const artifact = await inspect()
      if (operation === "rollback") await r.applyA003SessionRepair(artifact)
      const before = fs.readFileSync(sessionPath, "utf8")
      const ancestor = component === "state" ? path.join(context.root, "sanctuary.ouro", "state") : path.dirname(sessionPath)
      const outside = path.join(context.root, "outside-race")
      const aside = path.join(context.root, "original-race")
      fs.cpSync(ancestor, outside, { recursive: true })
      const sentinel = path.join(outside, path.relative(ancestor, sessionPath))
      let swapped = false
      let foreignBefore: Record<string, string> = {}
      const snapshotForeign = (): Record<string, string> => {
        const files: Record<string, string> = {}
        const walk = (directory: string): void => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name)
            if (entry.isDirectory()) walk(file)
            else if (entry.isFile()) files[path.relative(outside, file)] = hash(fs.readFileSync(file))
          }
        }
        walk(outside)
        return files
      }
      const swap = () => {
        fs.renameSync(ancestor, aside)
        // At publication, supply even the unpredictable temporary sibling at
        // the escaped path. ENOENT must not accidentally make this test pass.
        if (timing === "before-rename") fs.cpSync(aside, outside, { recursive: true })
        if (timing === "lease-pending" && component === "state") fs.unlinkSync(`${sentinel}.turn.lock`)
        fs.symlinkSync(outside, ancestor)
        foreignBefore = snapshotForeign()
        swapped = true
      }
      const realRename = fs.renameSync
      const publications: string[] = []
      vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(to) === sessionPath) publications.push(String(to))
        return realRename(from, to)
      })
      const realWith = transactions.withSessionTurnLease
      const realWrite = transactions.writeSessionTransaction
      const write = vi.spyOn(transactions, "writeSessionTransaction")
      let blocker: transactions.SessionTurnLease | undefined
      if (timing === "lease-pending") blocker = await transactions.acquireSessionTurnLease(sessionPath)
      if (timing === "lease-held") vi.spyOn(transactions, "withSessionTurnLease").mockImplementation((file, work, options) => realWith(file, async (lease) => { swap(); return work(lease) }, options))
      if (timing === "before-rename") write.mockImplementation((file, value, options) => realWrite(file, value, { ...options, hooks: { beforeRename: () => { swap(); options.hooks?.beforeRename?.() } } }))
      try {
        const pending = operation === "apply" ? r.applyA003SessionRepair(artifact) : r.rollbackA003SessionRepair(artifact)
        if (timing === "before-rename") {
          expect((await pending).status).toBe("indeterminate")
          expect(write).toHaveBeenCalledOnce()
        } else {
          const rejected = expect(pending).rejects.toThrow()
          if (timing === "lease-pending") { await new Promise<void>((resolve) => setImmediate(resolve)); swap() }
          await rejected
          expect(write).not.toHaveBeenCalled()
        }
        expect(swapped).toBe(true)
        expect(publications).toEqual([])
        expect(fs.readFileSync(sentinel, "utf8")).toBe(before)
        // JSON-only checks miss escaped SQLite lease/sidecar writes and the
        // transaction writer deleting a foreign lookalike temporary sibling.
        expect(snapshotForeign()).toEqual(foreignBefore)
      } finally { await blocker?.release() }
    },
  )

  it.each(["session", "manifest", "preimage"])("refuses valid oversized %s bytes with matching digests before reading the payload", async (kind) => {
    const r = await runner()
    const raw = JSON.parse(original)
    if (kind === "manifest") {
      const priorId = raw.events[85].id
      raw.events[85].id = "x".repeat(600_000)
      raw.projection.eventIds = raw.projection.eventIds.map((id: string) => id === priorId ? raw.events[85].id : id)
    } else raw.events[0].content = "x".repeat(32 * 1024 * 1024)
    const bytes = JSON.stringify(raw, null, 2)
    const oracle = expectedRepair(bytes)
    fs.writeFileSync(sessionPath, kind === "preimage" ? oracle.postimage : bytes)
    const manifestPath = path.join(artifactsDir, "oversized-manifest.json")
    const preimagePath = path.join(artifactsDir, "oversized-preimage.json")
    fs.writeFileSync(manifestPath, oracle.manifestBytes, { mode: 0o600 })
    fs.writeFileSync(preimagePath, bytes, { mode: 0o600 })
    const observedPath = kind === "session" ? sessionPath : kind === "manifest" ? manifestPath : preimagePath
    const observedInode = fs.statSync(observedPath).ino
    const realRead = fs.readFileSync
    let payloadRead = false
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (file === observedPath || typeof file === "number" && fs.fstatSync(file).ino === observedInode) payloadRead = true
      return (realRead as any)(file, ...args)
    }) as typeof fs.readFileSync)
    const authority = { manifestPath, preimagePath, manifestSha256: hash(oracle.manifestBytes) }
    await expect(kind === "session" ? r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })
      : kind === "manifest" ? r.applyA003SessionRepair(authority) : r.rollbackA003SessionRepair(authority)).rejects.toThrow(`${kind} exceeds ${kind === "manifest" ? 1 : 32} MiB`)
    expect(payloadRead).toBe(false)
  })

  it("accepts the exact 32 MiB postimage read boundary", async () => {
    const r = await runner()
    const raw = JSON.parse(original)
    raw.events[0].content += "x".repeat(32 * 1024 * 1024 - Buffer.byteLength(expectedRepair(original).postimage))
    const bytes = JSON.stringify(raw, null, 2)
    const expected = expectedRepair(bytes)
    expect(Buffer.byteLength(expected.postimage)).toBe(32 * 1024 * 1024)
    fs.writeFileSync(sessionPath, bytes)
    const artifact = await inspect()
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("applied")
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(expected.postimage)
  })

  it("applies one reviewed CAS, retains all raw evidence, and is idempotent before and after ordinary append", async () => {
    const r = await runner()
    const artifact = await inspect()
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("applied")
    expect(write).toHaveBeenCalledOnce()
    const post = fs.readFileSync(sessionPath, "utf8")
    const oracle = expectedRepair(original)
    expect(post).toBe(oracle.postimage)
    expect(write).toHaveBeenCalledWith(sessionPath, JSON.parse(oracle.postimage), expect.objectContaining({ expectedRevision: hash(original) }))
    expect(hash(post)).toBe(artifact.postimageRevision)
    const raw = JSON.parse(post)
    expect(raw.events).toHaveLength(238)
    expect(raw.events.slice(0, 230)).toEqual(JSON.parse(original).events)
    expect(raw.events.slice(-8).map((event: SessionEvent) => event.relations.redactsEventId)).toEqual(A003_POSITIONS.map((sequence) => `evt-${String(sequence).padStart(6, "0")}`))
    const { projectProviderMessages, parseSessionEnvelope } = await import("../../heart/session-events")
    expect(JSON.stringify(projectProviderMessages(parseSessionEnvelope(raw)!))).not.toContain("Missing required tool calls")
    expect(raw.projection.eventIds).toHaveLength(222)
    expect(raw.projection.eventIds).toEqual(JSON.parse(oracle.postimage).projection.eventIds)
    expect(raw.events.slice(-8)).toEqual(oracle.manifest.entries.map((entry) => entry.marker))
    expect(raw.structuredOutputs).toEqual(a003LegacyEnvelope().structuredOutputs)
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("already_applied")
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(post)
    expect(write).toHaveBeenCalledOnce()
    await transactions.withSessionTurnLease(sessionPath, async (lease) => {
      const current = transactions.readSessionTransaction(sessionPath, lease)
      const value = current.value as typeof raw
      const event = a003Event(239, "user", "later ordinary append")
      value.events.push(event); value.projection.eventIds.push(event.id)
      transactions.writeSessionTransaction(sessionPath, value, { lease, expectedRevision: current.revision })
    })
    const appended = fs.readFileSync(sessionPath, "utf8")
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("already_applied")
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(appended)
    expect(write).toHaveBeenCalledTimes(2)
    await expect(r.rollbackA003SessionRepair(artifact)).rejects.toThrow()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it("refuses an internally consistent reviewed-hash manifest selecting ordinary human events", async () => {
    const r = await runner()
    const artifact = await inspect()
    const forged = expectedRepair(original, [85, ...A003_POSITIONS.slice(1)])
    const manifestSha256 = writeManifest(artifact.manifestPath, forged.manifest)
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    await expect(r.applyA003SessionRepair({ ...artifact, manifestSha256 })).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it("holds one real lease and the same token through exact CAS and readback before release", async () => {
    const r = await runner()
    const artifact = await inspect()
    const order: string[] = []
    const realRead = transactions.readSessionTransaction
    const realWrite = transactions.writeSessionTransaction
    let owner: transactions.SessionTurnLease | undefined
    const busyChecks: Promise<unknown>[] = []
    const acquire = vi.spyOn(transactions, "withSessionTurnLease")
    vi.spyOn(transactions, "readSessionTransaction").mockImplementation((file, lease) => {
      if (!owner) {
        owner = lease
        const release = lease.release
        vi.spyOn(lease, "release").mockImplementation(async () => { order.push("release"); await release() })
      }
      expect(lease).toBe(owner)
      transactions.assertSessionTurnLease(file, lease)
      order.push("read")
      return realRead(file, lease)
    })
    vi.spyOn(transactions, "writeSessionTransaction").mockImplementation((file, value, options) => {
      expect(options.lease).toBe(owner)
      expect(options.expectedRevision).toBe(hash(original))
      expect(value).toEqual(JSON.parse(expectedRepair(original).postimage))
      order.push("write")
      const revision = realWrite(file, value, options)
      busyChecks.push(expect(transactions.acquireSessionTurnLease(file, { timeoutMs: 0 })).rejects.toBeInstanceOf(transactions.SessionTurnBusyError))
      return revision
    })
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("applied")
    await Promise.all(busyChecks)
    expect(acquire).toHaveBeenCalledOnce()
    expect(order).toEqual(["read", "write", "read", "release"])
  })

  it.each(["hash", "unknown", "entry-unknown", "schema", "selector", "agent", "path", "absolute-path", "target", "target-digest", "neighbor", "marker", "projection-revision", "preimage-revision", "order", "extra-entry", "time"])(
    "rejects a changed manifest %s before any CAS",
    async (mutation) => {
      const r = await runner()
      const artifact = await inspect()
      const manifest = JSON.parse(fs.readFileSync(artifact.manifestPath, "utf8"))
      if (mutation === "unknown") manifest.extra = true
      if (mutation === "entry-unknown") manifest.entries[0].extra = true
      if (mutation === "schema") manifest.schemaVersion = "other"
      if (mutation === "selector") manifest.selectorVersion = "other"
      if (mutation === "agent") manifest.agent = "other"
      if (mutation === "path") manifest.sessionRelativePath = "../../escape.json"
      if (mutation === "absolute-path") manifest.sessionRelativePath = sessionPath
      if (mutation === "target") manifest.entries[0].target.content = "real human"
      if (mutation === "target-digest") manifest.entries[0].targetSha256 = "0".repeat(64)
      if (mutation === "neighbor") manifest.entries[0].previousEventId = "wrong"
      if (mutation === "marker") manifest.entries[0].marker.content = "payload"
      if (mutation === "projection-revision") manifest.postimageRevision = "0".repeat(64)
      if (mutation === "preimage-revision") manifest.preimageRevision = "0".repeat(64)
      if (mutation === "order") manifest.entries.reverse()
      if (mutation === "extra-entry") manifest.entries.push(manifest.entries[0])
      if (mutation === "time") manifest.capturedAt = "not-a-date"
      const changedHash = writeManifest(artifact.manifestPath, manifest)
      const write = vi.spyOn(transactions, "writeSessionTransaction")
      await expect(r.applyA003SessionRepair({ ...artifact, manifestSha256: mutation === "hash" ? "0".repeat(64) : changedHash })).rejects.toThrow()
      expect(write).not.toHaveBeenCalled()
      expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
    },
  )

  it.each(["manifest-mode", "manifest-link", "preimage-mode", "preimage-link", "preimage-digest"])("refuses unsafe %s artifacts", async (mutation) => {
    const r = await runner()
    const artifact = await inspect()
    if (mutation.startsWith("preimage")) await r.applyA003SessionRepair(artifact)
    const file = mutation.startsWith("manifest") ? artifact.manifestPath : artifact.preimagePath
    if (mutation.endsWith("mode")) fs.chmodSync(file, 0o644)
    if (mutation.endsWith("link")) { fs.renameSync(file, `${file}.actual`); fs.symlinkSync(`${file}.actual`, file) }
    if (mutation.endsWith("digest")) fs.writeFileSync(file, "{}")
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    await expect(mutation.startsWith("manifest") ? r.applyA003SessionRepair(artifact) : r.rollbackA003SessionRepair(artifact)).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
  })

  it.each(["before-rename", "after-rename", "reread", "divergent-readback"])("classifies exact apply readback after %s without blind retry", async (fault) => {
    const r = await runner()
    const artifact = await inspect()
    const realWrite = transactions.writeSessionTransaction
    let wrote = false
    const write = vi.spyOn(transactions, "writeSessionTransaction").mockImplementation((file, value, options) => {
      if (fault === "before-rename") return realWrite(file, value, { ...options, hooks: { beforeRename: () => { throw new Error("pre-rename fault") } } })
      const result = realWrite(file, value, options)
      wrote = true
      if (fault === "after-rename") throw new Error("post-rename fault")
      return result
    })
    const realRead = transactions.readSessionTransaction
    vi.spyOn(transactions, "readSessionTransaction").mockImplementation((...args) => {
      if (wrote && fault === "reread") throw new Error("readback unavailable")
      if (wrote && fault === "divergent-readback") return { bytes: "different", value: {}, revision: hash("different") }
      return realRead(...args)
    })
    const result = await r.applyA003SessionRepair(artifact)
    expect(result.status).toBe(fault === "before-rename" ? "not_applied" : fault === "after-rename" ? "applied" : "indeterminate")
    expect(write).toHaveBeenCalledOnce()
    expect(hash(fs.readFileSync(sessionPath))).toBe(fault === "before-rename" ? artifact.preimageRevision : artifact.postimageRevision)
  })

  it("serializes against a real session writer and refuses its stale preimage", async () => {
    const r = await runner()
    const artifact = await inspect()
    const lease = await transactions.acquireSessionTurnLease(sessionPath)
    const pending = r.applyA003SessionRepair(artifact)
    let finished = false
    void pending.then(() => { finished = true }, () => { finished = true })
    const rejected = expect(pending).rejects.toThrow(/revision|preimage/u)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(finished).toBe(false)
    const current = transactions.readSessionTransaction(sessionPath, lease)
    const value = current.value as ReturnType<typeof a003LegacyEnvelope>
    const added = a003Event(231, "user", "racing user")
    value.events.push(added); value.projection.eventIds.push(added.id)
    transactions.writeSessionTransaction(sessionPath, value, { lease, expectedRevision: current.revision })
    const raced = fs.readFileSync(sessionPath, "utf8")
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    await lease.release()
    await rejected
    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(raced)
  })

  it("reports a real busy lease without any session CAS", async () => {
    const r = await runner()
    const artifact = await inspect()
    const lease = await transactions.acquireSessionTurnLease(sessionPath)
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    try {
      const pending = r.applyA003SessionRepair(artifact)
      const rejected = expect(pending).rejects.toBeInstanceOf(transactions.SessionTurnBusyError)
      await new Promise<void>((resolve) => setImmediate(resolve))
      vi.setSystemTime(new Date(Date.parse(A003_REPAIR_AT) + 6000))
      await rejected
      expect(write).not.toHaveBeenCalled()
      expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
    } finally { await lease.release() }
  })

  it.each(["partial", "duplicate", "reordered", "mutated", "target-mutated", "resurrected-projection", "forged-structured-output"])("never calls a divergent %s block already applied", async (mutation) => {
    const r = await runner()
    const artifact = await inspect()
    await r.applyA003SessionRepair(artifact)
    const raw = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
    if (mutation === "partial") raw.events.pop()
    if (mutation === "duplicate") raw.events.push(structuredClone(raw.events.at(-1)))
    if (mutation === "reordered") [raw.events[230], raw.events[231]] = [raw.events[231], raw.events[230]]
    if (mutation === "mutated") raw.events[230].time.recordedAt = "2026-09-08T12:00:00.000Z"
    if (mutation === "target-mutated") raw.events[85].content = "changed target snapshot"
    if (mutation === "resurrected-projection") raw.projection.eventIds.push(raw.events[85].id)
    if (mutation === "forged-structured-output") raw.structuredOutputs = [{ forged: true }]
    const bytes = JSON.stringify(raw, null, 2)
    fs.writeFileSync(sessionPath, bytes)
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("indeterminate")
    expect(write).not.toHaveBeenCalled()
    await expect(r.rollbackA003SessionRepair(artifact)).rejects.toThrow()
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(bytes)
  })

  it("restores only the exact untouched postimage and then reports already rolled back", async () => {
    const r = await runner()
    const artifact = await inspect()
    expect((await r.rollbackA003SessionRepair(artifact)).status).toBe("already_rolled_back")
    await r.applyA003SessionRepair(artifact)
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    expect((await r.rollbackA003SessionRepair(artifact)).status).toBe("rolled_back")
    expect(write).toHaveBeenCalledOnce()
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
    expect((await r.rollbackA003SessionRepair(artifact)).status).toBe("already_rolled_back")
    expect(write).toHaveBeenCalledOnce()
  })

  it.each(["before", "after", "readback"])("reconciles rollback %s failures without erasing other revisions", async (fault) => {
    const r = await runner()
    const artifact = await inspect()
    await r.applyA003SessionRepair(artifact)
    const realWrite = transactions.writeSessionTransaction
    let wrote = false
    const write = vi.spyOn(transactions, "writeSessionTransaction").mockImplementation((...args) => {
      if (fault === "before") throw new Error("before rollback")
      const revision = realWrite(...args); wrote = true
      if (fault === "after") throw new Error("after rollback")
      return revision
    })
    const realRead = transactions.readSessionTransaction
    vi.spyOn(transactions, "readSessionTransaction").mockImplementation((...args) => {
      if (wrote && fault === "readback") throw new Error("rollback readback")
      return realRead(...args)
    })
    expect((await r.rollbackA003SessionRepair(artifact)).status).toBe(fault === "before" ? "not_applied" : fault === "after" ? "rolled_back" : "indeterminate")
    expect(write).toHaveBeenCalledOnce()
  })

  it.each(["relative-directory", "noncanonical-session", "version", "projection", "projection-time", "normalization", "marker-collision", "postimage-limit", "manifest-limit"])(
    "refuses independently malformed inspect input %s",
    async (kind) => {
      const r = await runner()
      const raw = JSON.parse(original)
      let directory = artifactsDir
      let file = sessionPath
      if (kind === "relative-directory") directory = "private"
      if (kind === "noncanonical-session") file = `${path.dirname(sessionPath)}/./owner.json`
      if (kind === "version") raw.version = 1
      if (kind === "projection") raw.projection.extra = true
      if (kind === "projection-time") raw.projection.projectedAt = "bad"
      if (kind === "normalization") raw.events[0].extra = true
      if (kind === "marker-collision" || kind === "manifest-limit") {
        const position = kind === "marker-collision" ? 0 : 85
        const previous = raw.events[position].id
        raw.events[position].id = kind === "marker-collision" ? "evt-000232" : "x".repeat(600_000)
        raw.projection.eventIds = raw.projection.eventIds.map((id: string) => id === previous ? raw.events[position].id : id)
      }
      if (kind === "postimage-limit") raw.events[0].content += "x".repeat(32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(raw, null, 2)))
      fs.writeFileSync(sessionPath, JSON.stringify(raw, null, 2))
      await expect(r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath: file, artifactsDir: directory })).rejects.toThrow()
      expect(fs.readdirSync(artifactsDir)).toEqual([])
    },
  )

  it("bounds transaction bytes even if the read dependency returns a newly grown valid session", async () => {
    const r = await runner()
    const read = transactions.readSessionTransaction
    const raw = JSON.parse(original)
    raw.events[0].content = "x".repeat(32 * 1024 * 1024)
    vi.spyOn(transactions, "readSessionTransaction").mockImplementationOnce((file, lease) => {
      fs.writeFileSync(file, JSON.stringify(raw, null, 2))
      return read(file, lease)
    })
    await expect(r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })).rejects.toThrow("session exceeds 32 MiB")
    expect(fs.readdirSync(artifactsDir)).toEqual([])
  })

  it("binds null immediate neighbors for a retained first and last audited target", async () => {
    const r = await runner()
    const raw = JSON.parse(original)
    raw.events = raw.events.filter((event: SessionEvent) => event.sequence >= 86 && event.sequence <= 222)
    const ids = new Set(raw.events.map((event: SessionEvent) => event.id))
    raw.projection.eventIds = raw.projection.eventIds.filter((id: string) => ids.has(id))
    raw.structuredOutputs = []
    const bytes = JSON.stringify(raw, null, 2)
    fs.writeFileSync(sessionPath, bytes)
    const artifact = await inspect()
    const manifest = JSON.parse(fs.readFileSync(artifact.manifestPath, "utf8"))
    expect(manifest.entries[0].previousEventId).toBeNull()
    expect(manifest.entries.at(-1).nextEventId).toBeNull()
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("applied")
    expect((await r.rollbackA003SessionRepair(artifact)).status).toBe("rolled_back")
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(bytes)
  })

  it.each(["open-inode", "open-mode", "read-inode", "read-size", "read-directory"])("refuses artifact %s changes at the actual read boundary", async (kind) => {
    const r = await runner()
    const artifact = await inspect()
    const bytes = fs.readFileSync(artifact.manifestPath)
    const inode = fs.statSync(artifact.manifestPath).ino
    const open = fs.openSync
    const read = fs.readFileSync
    let fired = false
    const change = () => {
      fired = true
      if (kind === "open-mode") fs.chmodSync(artifact.manifestPath, 0o644)
      else if (kind === "read-size") fs.appendFileSync(artifact.manifestPath, " ".repeat(1024 * 1024))
      else if (kind === "read-directory") {
        fs.renameSync(artifactsDir, `${artifactsDir}.saved`)
        fs.cpSync(`${artifactsDir}.saved`, artifactsDir, { recursive: true })
      } else {
        fs.renameSync(artifact.manifestPath, `${artifact.manifestPath}.saved`)
        fs.writeFileSync(artifact.manifestPath, bytes, { mode: 0o600 })
      }
    }
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
      if (!fired && String(file) === artifact.manifestPath && kind.startsWith("open")) change()
      return (open as any)(file, ...args)
    }) as typeof fs.openSync)
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      const target = !fired && typeof file === "number" && fs.fstatSync(file).ino === inode && kind.startsWith("read")
      if (target && kind === "read-size") change()
      const value = (read as any)(file, ...args)
      if (target && kind !== "read-size") change()
      return value
    }) as typeof fs.readFileSync)
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    await expect(r.applyA003SessionRepair(artifact)).rejects.toThrow()
    expect(fired).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it.each(["final", "sibling"])("preserves the primary artifact error when %s cleanup fails", async (stage) => {
    const r = await runner()
    const link = fs.linkSync
    const unlink = fs.unlinkSync
    const primary = new Error("primary publication fault")
    let links = 0
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (++links === 2) throw primary
      return link(from, to)
    })
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).startsWith(artifactsDir) && path.basename(String(file)).startsWith(".") === (stage === "sibling")) throw new Error("cleanup denied")
      return unlink(file)
    })
    await expect(r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })).rejects.toBe(primary)
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it("does not delete a foreign replacement for an artifact sibling", async () => {
    const r = await runner()
    const link = fs.linkSync
    const replacements: string[] = []
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      link(from, to)
      fs.unlinkSync(from)
      fs.writeFileSync(from, "foreign sibling", { mode: 0o600 })
      replacements.push(String(from))
    })
    await r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })
    expect(replacements).toHaveLength(2)
    for (const file of replacements) expect(fs.readFileSync(file, "utf8")).toBe("foreign sibling")
  })

  it("preserves an artifact write failure when closing its descriptor also fails", async () => {
    const r = await runner()
    const open = fs.openSync
    const write = fs.writeFileSync
    const close = fs.closeSync
    const primary = new Error("primary artifact write")
    let targetFd: number | undefined
    let closed = false
    vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: string | number, mode?: number) => {
      const fd = open(file, flags, mode)
      if (String(file).startsWith(`${artifactsDir}/`) && typeof flags === "number" && flags & fs.constants.O_CREAT) targetFd = fd
      return fd
    }) as typeof fs.openSync)
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (file === targetFd) throw primary
      return (write as any)(file, ...args)
    }) as typeof fs.writeFileSync)
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      close(fd)
      if (fd === targetFd && !closed) { closed = true; throw new Error("secondary close failure") }
    })
    await expect(r.inspectA003SessionRepair({ agent: "sanctuary", sessionPath, artifactsDir })).rejects.toBe(primary)
  })

  it.each(["target-text", "target-valid-constructor", "target-id", "extra-marker", "projection", "structured"])("rejects %s drift after a real later append", async (kind) => {
    const r = await runner()
    const artifact = await inspect()
    await r.applyA003SessionRepair(artifact)
    const raw = JSON.parse(fs.readFileSync(sessionPath, "utf8"))
    const later = a003Event(239, "user", "later")
    raw.events.push(later); raw.projection.eventIds.push(later.id)
    if (kind === "target-text") raw.events[85].content = "not a correction"
    if (kind === "target-valid-constructor") raw.events[85].content = A003_LEGACY_MEDIA
    if (kind === "target-id") raw.events[85].id = "changed-target-id"
    if (kind === "extra-marker") raw.events.push(a003Marker(later, 240))
    if (kind === "projection") {
      raw.projection.eventIds.push(raw.events[85].id)
      const order = new Map(raw.events.map((event: SessionEvent) => [event.id, event.sequence]))
      raw.projection.eventIds.sort((left: string, right: string) => Number(order.get(left)) - Number(order.get(right)))
    }
    if (kind === "structured") raw.structuredOutputs = []
    const bytes = JSON.stringify(raw, null, 2)
    fs.writeFileSync(sessionPath, bytes)
    const write = vi.spyOn(transactions, "writeSessionTransaction")
    expect((await r.applyA003SessionRepair(artifact)).status).toBe("indeterminate")
    expect(write).not.toHaveBeenCalled()
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(bytes)
  })

  it("refuses a well-shaped rollback manifest whose postimage disagrees with the exact preimage", async () => {
    const r = await runner()
    const artifact = await inspect()
    const manifest = JSON.parse(fs.readFileSync(artifact.manifestPath, "utf8"))
    manifest.postimageRevision = "0".repeat(64)
    const manifestSha256 = writeManifest(artifact.manifestPath, manifest)
    await expect(r.rollbackA003SessionRepair({ ...artifact, manifestSha256 })).rejects.toThrow("rollback manifest differs from preimage")
  })

  async function invokeCli(args: string[]): Promise<{ code: number | string | undefined; value: any }> {
    const argv = process.argv
    const exitCode = process.exitCode
    const output: string[] = []
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { output.push(String(chunk)); return true }) as typeof process.stdout.write)
    try {
      process.argv = [process.execPath, "session-redaction-repair-cli-main.js", ...args]
      process.exitCode = undefined
      vi.resetModules()
      const modulePath = "../../heart/session-redaction-repair-cli-main"
      await import(modulePath)
      await vi.waitFor(() => expect(process.exitCode).not.toBeUndefined())
      expect(output).toHaveLength(1)
      expect(output[0]!.length).toBeLessThan(2048)
      return { code: process.exitCode, value: JSON.parse(output[0]!) }
    } finally { write.mockRestore(); process.argv = argv; process.exitCode = exitCode }
  }

  it("translates an exact not-applied readback to a nonzero private CLI result", async () => {
    const artifact = await inspect()
    const rename = fs.renameSync
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === sessionPath) throw new Error("before rename")
      return rename(from, to)
    })
    const result = await invokeCli(["apply", "--manifest-sha256", artifact.manifestSha256, artifact.manifestPath])
    expect(result.code).toBe(1)
    expect(result.value.status).toBe("not_applied")
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it("translates a non-Error dependency failure without losing the bounded CLI contract", async () => {
    const artifact = await inspect()
    const stat = fs.lstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...args: any[]) => {
      if (String(file) === artifact.manifestPath) throw "metadata unavailable"
      return (stat as any)(file, ...args)
    }) as typeof fs.lstatSync)
    const result = await invokeCli(["apply", "--manifest-sha256", artifact.manifestSha256, artifact.manifestPath])
    expect(result).toEqual({ code: 2, value: { status: "refused", error: "metadata unavailable" } })
  })

  it.each([[], ["repair"], ["inspect"], ["apply"], ["rollback"], ["apply", "--manifest-sha256", "bad", "file"], ["inspect", "--agent", "sanctuary", "--targets", "86"], ["apply", "--manifest-sha256", "0".repeat(64), "file", "extra"]].map((args) => ({ args })))(
    "translates invalid private CLI args $args into a bounded refusal",
    async ({ args }) => {
      const result = await invokeCli(args)
      expect(result.code).toBe(2)
      expect(result.value.status).toBe("refused")
      expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
    },
  )

  it("runs inspect, apply, and rollback through only the private direct adapter", async () => {
    const inspected = await invokeCli(["inspect", "--agent", "sanctuary", "--session", sessionPath, "--artifacts-dir", artifactsDir])
    expect(inspected.code).toBe(0)
    expect(inspected.value.status).toBe("inspected")
    const artifact = inspected.value as InspectResult
    const applied = await invokeCli(["apply", "--manifest-sha256", artifact.manifestSha256, artifact.manifestPath])
    expect(applied.code).toBe(0)
    expect(applied.value.status).toBe("applied")
    const rolledBack = await invokeCli(["rollback", "--manifest-sha256", artifact.manifestSha256, artifact.manifestPath, artifact.preimagePath])
    expect(rolledBack.code).toBe(0)
    expect(rolledBack.value.status).toBe("rolled_back")
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })

  it("refuses caller-supplied targets even on an otherwise complete inspect invocation", async () => {
    const result = await invokeCli(["inspect", "--agent", "sanctuary", "--session", sessionPath, "--artifacts-dir", artifactsDir, "--targets", "86"])
    expect(result.code).toBe(2)
    expect(result.value.status).toBe("refused")
    expect(fs.readdirSync(artifactsDir)).toEqual([])
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(original)
  })
})
