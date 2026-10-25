import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", async (original) => ({ ...await original<typeof import("fs")>() }))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
vi.mock("../../mind/prompt", () => ({
  buildSystem: vi.fn(async () => "SYSTEM PROMPT"),
  flattenSystemPrompt: (value: string) => value,
}))

import { emitNervesEvent } from "../../nerves/runtime"
import { resolveSessionPath } from "../../heart/config"
import { loadSessionEnvelopeFile, parseSessionEnvelope } from "../../heart/session-events"
import { appendSyntheticAssistantMessage, loadSession, saveSession } from "../../mind/context"
import { drainOutboundRecords, recordOutboundInSession } from "../../mind/outbound-record"
import { refreshSystemPrompt } from "../../mind/prompt-refresh"
import { acquireSessionTurnLease, withImmediateSessionTurnLease } from "../../mind/session-transaction"

const KEY = "chat:any;-;+15555550123"
let agentRoot: string

function sessionFile(key = KEY): string {
  return resolveSessionPath("ari", "bluebubbles", key, { agentRoot })
}

function seedSession(key = KEY): string {
  const file = sessionFile(key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  saveSession(file, [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }])
  return file
}

function record(overrides: Partial<Parameters<typeof recordOutboundInSession>[0]> = {}) {
  return recordOutboundInSession({
    agentRoot, friendId: "ari", channel: "bluebubbles", key: KEY, content: "Your agent needs you.",
    origin: "shepherd", deliveryId: "shepherd:abc", originLabel: "Shepherd", ...overrides,
  })
}

function deferredDir(): string {
  return path.join(agentRoot, "state", "outbound-records", "ari", "bluebubbles", "chat_any;-;+15555550123")
}

function writeDeferred(name: string, value: unknown): void {
  fs.mkdirSync(deferredDir(), { recursive: true })
  fs.writeFileSync(path.join(deferredDir(), name), typeof value === "string" ? value : JSON.stringify(value))
}

function outboundEvents(file: string) {
  return loadSessionEnvelopeFile(file)!.events.filter((event) => event.provenance.outbound)
}

const errorEvents = () => vi.mocked(emitNervesEvent).mock.calls.map(([entry]) => entry).filter((entry) => entry.event === "mind.outbound_record_error")

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-record-"))
  vi.mocked(emitNervesEvent).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

describe("recordOutboundInSession", () => {
  it("records into an existing session with the prefix and provenance", () => {
    const file = seedSession()
    expect(record()).toBe("recorded")
    const [event] = outboundEvents(file)
    expect(event).toMatchObject({ role: "assistant", content: "[sent by Shepherd] Your agent needs you.",
      provenance: { captureKind: "synthetic", outbound: { origin: "shepherd", deliveryId: "shepherd:abc" } } })
  })

  it("creates the session when missing", () => {
    expect(fs.existsSync(sessionFile())).toBe(false)
    expect(record()).toBe("recorded")
    expect(outboundEvents(sessionFile())).toHaveLength(1)
  })

  it("a repeated deliveryId is recorded once", () => {
    expect(record()).toBe("recorded")
    expect(record()).toBe("recorded")
    expect(outboundEvents(sessionFile())).toHaveLength(1)
  })

  it("defers to state/outbound-records when another owner holds the lease", async () => {
    const file = seedSession()
    const held = await acquireSessionTurnLease(file)
    try {
      expect(record()).toBe("deferred")
    } finally {
      await held.release()
    }
    const [name] = fs.readdirSync(deferredDir())
    expect(name).toMatch(/^[a-f0-9]{32}\.json$/)
    expect(JSON.parse(fs.readFileSync(path.join(deferredDir(), name!), "utf8"))).toMatchObject({
      content: "Your agent needs you.", origin: "shepherd", deliveryId: "shepherd:abc", originLabel: "Shepherd", recordedAt: expect.any(String),
    })
    expect(outboundEvents(file)).toHaveLength(0)
  })

  it("skips when the current async context holds that session's lease", () => {
    const file = seedSession()
    expect(withImmediateSessionTurnLease(file, () => record())).toBe("skipped_current_session")
    expect(outboundEvents(file)).toHaveLength(0)
  })

  it("a lease-holding record drains older deferred records first", () => {
    const file = seedSession()
    writeDeferred("older.json", { content: "earlier", origin: "send_message", deliveryId: "d-older", originLabel: "send_message", recordedAt: "2026-10-24T10:00:00.000Z" })
    expect(record()).toBe("recorded")
    expect(outboundEvents(file).map((event) => event.content)).toEqual(["[sent by send_message] earlier", "[sent by Shepherd] Your agent needs you."])
  })

  it("a write failure returns failed and logs mind.outbound_record_error", () => {
    fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "state", "sessions"), "not a directory")
    expect(record()).toBe("failed")
    expect(errorEvents()).toHaveLength(1)
  })

  it("refuses coordinates that would leave the sessions folder", () => {
    expect(record({ friendId: "../escape" })).toBe("failed")
    expect(errorEvents()).toHaveLength(1)
  })

  it("a session file it cannot read returns failed and logs the error", () => {
    const file = sessionFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "{not a session")
    expect(record()).toBe("failed")
    expect(errorEvents()).toEqual([expect.objectContaining({ message: "could not append an outbound record to its session" })])
  })

  it("refuses a key that names no session folder", () => {
    expect(record({ key: ".." })).toBe("failed")
    expect(fs.existsSync(path.join(agentRoot, "state", "outbound-records"))).toBe(false)
  })

  it("a deferral that cannot be written returns failed", async () => {
    const file = seedSession()
    const held = await acquireSessionTurnLease(file)
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw "disk full" })
    try {
      expect(record()).toBe("failed")
    } finally {
      await held.release()
    }
    expect(errorEvents()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ error: "disk full" }) })])
  })

  it("keeps a readable outbound marker, including an origin this version does not know, and drops a malformed one", () => {
    record()
    const raw = JSON.parse(fs.readFileSync(sessionFile(), "utf8"))
    const index = raw.events.findIndex((event: any) => event.provenance.outbound)
    const parsedWith = (outbound: unknown) => {
      const copy = structuredClone(raw)
      copy.events[index].provenance.outbound = outbound
      return parseSessionEnvelope(copy)!.events[index]!.provenance.outbound
    }
    expect(parsedWith({ origin: "future", deliveryId: "d-1", extra: true })).toEqual({ origin: "future", deliveryId: "d-1" })
    for (const malformed of [null, [], "x", { origin: "", deliveryId: "d" }, { origin: "shepherd", deliveryId: 5 }, { origin: "shepherd", deliveryId: "" }]) {
      expect(parsedWith(malformed)).toBeUndefined()
    }
  })

  it("the provenance survives parseSessionEnvelope round-trip", () => {
    record()
    const raw = JSON.parse(fs.readFileSync(sessionFile(), "utf8"))
    const parsed = parseSessionEnvelope(raw)!
    expect(parsed.events.find((event) => event.provenance.outbound)?.provenance.outbound).toEqual({ origin: "shepherd", deliveryId: "shepherd:abc" })
  })

  it("loadSession of the recorded session yields an assistant message beginning \"[sent by Shepherd]\"", () => {
    seedSession()
    record()
    const messages = loadSession(sessionFile())!.messages
    expect(messages.at(-1)).toMatchObject({ role: "assistant" })
    expect(String(messages.at(-1)!.content)).toMatch(/\[sent by Shepherd\] Your agent needs you\.$/)
  })

  it("a turn on a session created by createIfMissing builds a valid provider request (system prompt added by prompt-refresh)", async () => {
    record()
    const messages = loadSession(sessionFile())!.messages
    expect(messages.map((message) => message.role)).toEqual(["assistant"])
    await refreshSystemPrompt(messages, "bluebubbles")
    messages.push({ role: "user", content: "what do you need?" })
    expect(messages.map((message) => message.role)).toEqual(["system", "assistant", "user"])
    saveSession(sessionFile(), messages)
    const saved = loadSessionEnvelopeFile(sessionFile())!
    expect(saved.events.filter((event) => event.provenance.outbound)).toHaveLength(1)
    expect(loadSession(sessionFile())!.messages.map((message) => message.role)).toEqual(["system", "assistant", "user"])
  })
})

describe("drainOutboundRecords", () => {
  it("drain appends deferred records in order and moves them to applied/", () => {
    const file = seedSession()
    writeDeferred("b.json", { content: "second", origin: "shepherd", deliveryId: "d-2", originLabel: "Shepherd", recordedAt: "2026-10-24T11:00:00.000Z" })
    writeDeferred("a.json", { content: "first", origin: "voice", deliveryId: "d-1", originLabel: "voice call", recordedAt: "2026-10-24T10:00:00.000Z" })
    const count = withImmediateSessionTurnLease(file, (lease) => drainOutboundRecords(agentRoot, "ari", "bluebubbles", KEY, lease))
    expect(count).toBe(2)
    expect(outboundEvents(file).map((event) => event.content)).toEqual(["[sent by voice call] first", "[sent by Shepherd] second"])
    expect(fs.readdirSync(deferredDir()).sort()).toEqual(["applied"])
    expect(fs.readdirSync(path.join(deferredDir(), "applied")).sort()).toEqual(["a.json", "b.json"])
  })

  it("drain skips applied/ and .tmp files and survives an unparseable record", () => {
    const file = seedSession()
    writeDeferred("half.json.tmp", "{")
    writeDeferred("broken.json", "{not json")
    writeDeferred("wrong-shape.json", { content: 1 })
    writeDeferred("good.json", { content: "kept", origin: "reminder", deliveryId: "d-good", originLabel: "reminder", recordedAt: "2026-10-24T10:00:00.000Z" })
    fs.mkdirSync(path.join(deferredDir(), "applied"), { recursive: true })
    fs.writeFileSync(path.join(deferredDir(), "applied", "old.json"), JSON.stringify({ content: "old", origin: "shepherd", deliveryId: "d-old", originLabel: "Shepherd", recordedAt: "2026-10-23T10:00:00.000Z" }))
    const count = withImmediateSessionTurnLease(file, (lease) => drainOutboundRecords(agentRoot, "ari", "bluebubbles", KEY, lease))
    expect(count).toBe(1)
    expect(outboundEvents(file).map((event) => event.content)).toEqual(["[sent by reminder] kept"])
    expect(fs.readdirSync(deferredDir()).sort()).toEqual(["applied", "half.json.tmp"])
    expect(errorEvents()).toHaveLength(2)
  })

  it("a drain that cannot move its files logs the error and lets the turn go on", () => {
    const file = seedSession()
    writeDeferred("a.json", { content: "first", origin: "voice", deliveryId: "d-1", originLabel: "voice", recordedAt: "2026-10-24T10:00:00.000Z" })
    fs.writeFileSync(path.join(deferredDir(), "applied"), "not a directory")
    expect(withImmediateSessionTurnLease(file, (lease) => drainOutboundRecords(agentRoot, "ari", "bluebubbles", KEY, lease))).toBe(0)
    expect(errorEvents()).toEqual([expect.objectContaining({ message: "could not drain deferred outbound records" })])
  })

  it("a deferred record whose session cannot be read is kept in applied/ with an error", () => {
    const file = sessionFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "{not a session")
    writeDeferred("a.json", { content: "first", origin: "voice", deliveryId: "d-1", originLabel: "voice", recordedAt: "2026-10-24T10:00:00.000Z" })
    writeDeferred("null.json", "null")
    const count = withImmediateSessionTurnLease(file, (lease) => drainOutboundRecords(agentRoot, "ari", "bluebubbles", KEY, lease))
    expect(count).toBe(0)
    expect(fs.readdirSync(path.join(deferredDir(), "applied")).sort()).toEqual(["a.json", "null.json"])
    expect(errorEvents().map((entry) => entry.message).sort()).toEqual(["could not append a deferred outbound record", "skipped an unreadable deferred outbound record"])
  })

  it("a drain failure that is not an Error is still logged", () => {
    const file = seedSession()
    writeDeferred("a.json", { content: "first", origin: "voice", deliveryId: "d-1", originLabel: "voice", recordedAt: "2026-10-24T10:00:00.000Z" })
    const mkdir = fs.mkdirSync
    vi.spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(target).endsWith("applied")) throw "no space"
      return mkdir(target, options)
    }) as typeof fs.mkdirSync)
    expect(withImmediateSessionTurnLease(file, (lease) => drainOutboundRecords(agentRoot, "ari", "bluebubbles", KEY, lease))).toBe(0)
    expect(errorEvents()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ error: "no space" }) })])
  })

  it("returns 0 when nothing is deferred", () => {
    const file = seedSession()
    expect(withImmediateSessionTurnLease(file, (lease) => drainOutboundRecords(agentRoot, "ari", "bluebubbles", KEY, lease))).toBe(0)
    fs.mkdirSync(deferredDir(), { recursive: true })
    expect(withImmediateSessionTurnLease(file, (lease) => drainOutboundRecords(agentRoot, "ari", "bluebubbles", KEY, lease))).toBe(0)
  })
})

describe("appendSyntheticAssistantMessage options", () => {
  it("still returns false for a missing session without createIfMissing", () => {
    expect(appendSyntheticAssistantMessage(sessionFile(), "x")).toBe(false)
  })
})
