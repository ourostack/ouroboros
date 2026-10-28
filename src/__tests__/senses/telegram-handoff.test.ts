import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { foldHeldNotices, isCriticalNoticeKey, isQuietHour, OWNER_CHAT_HANDOFF_MS, ownerChatHandedOff, proactiveHoldReason, readHeldNotices, readReleasedHeldKeys, recordProactiveSend, recordReleasedHeldKeys, writeHeldNotices } from "../../senses/telegram-handoff"

const at = Date.parse("2026-10-11T04:27:28.812Z")
const event = (role: string, content: string, observedAt: string | null = new Date(at).toISOString(), recordedAt = new Date(at).toISOString()) => ({
  id: "e", sequence: 1, role, content, name: null, toolCallId: null, toolCalls: [], attachments: [],
  time: { authoredAt: null, authoredAtSource: "unknown", observedAt, observedAtSource: "ingest", recordedAt, recordedAtSource: "save" },
  relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
  provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
}) as any

describe("ownerChatHandedOff", () => {
  it("is on within the window after Ari hands the chat over, and off after it", () => {
    const events = [event("user", "hello pal! I’m going to hand you to my wife, Rachel."), event("user", "i want something silly")]
    expect(ownerChatHandedOff(events, at + 60_000)).toBe(true)
    expect(ownerChatHandedOff(events, at + OWNER_CHAT_HANDOFF_MS)).toBe(false)
    expect(ownerChatHandedOff([event("user", "say hi to her!", null)], at + 60_000)).toBe(true)
    expect(ownerChatHandedOff([event("user", "passing you over to Sam")], at + 60_000)).toBe(true)
    expect(ownerChatHandedOff([event("user", "handing you off to Sam")], at + 60_000)).toBe(true)
  })

  it("stays on while the handed-off conversation keeps going, and goes off two hours after its last message", () => {
    const later = new Date(at + OWNER_CHAT_HANDOFF_MS).toISOString()
    const events = [event("user", "say hi to her!"), event("assistant", "Hi Rachel!", later), event("user", "something silly please", later)]
    expect(ownerChatHandedOff(events, at + OWNER_CHAT_HANDOFF_MS + 60_000)).toBe(true)
    expect(ownerChatHandedOff(events, at + 2 * OWNER_CHAT_HANDOFF_MS)).toBe(false)
    expect(ownerChatHandedOff([event("user", "say hi to her!", null, "not a date")], at)).toBe(false)
  })

  it("is off with no handoff, or when only the Butler said the words", () => {
    expect(ownerChatHandedOff([], at)).toBe(false)
    expect(ownerChatHandedOff([event("user", "what's up?"), event("assistant", "I'll hand you to Ari")], at)).toBe(false)
  })
})

describe("held notices", () => {
  it("round-trips, and reads a missing or malformed file as empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-notices-"))
    const file = path.join(dir, "telegram", "held.json")
    expect(readHeldNotices(file)).toEqual([])
    writeHeldNotices(file, [{ key: "k", text: "t" }])
    expect(readHeldNotices(file)).toEqual([{ key: "k", text: "t" }])
    fs.writeFileSync(file, JSON.stringify([{ key: "k" }, null, { key: "a", text: "b" }]))
    expect(readHeldNotices(file)).toEqual([{ key: "a", text: "b" }])
    fs.writeFileSync(file, JSON.stringify({ not: "a list" }))
    expect(readHeldNotices(file)).toEqual([])
  })
})

describe("proactive pacing", () => {
  const la = { timeZone: "America/Los_Angeles" }
  const ledger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-pacing-")), "proactive-sends.json")

  it("knows quiet hours in the owner's time zone", () => {
    expect(isQuietHour(new Date("2026-10-20T06:30:00.000Z"), la)).toBe(true) // 23:30
    expect(isQuietHour(new Date("2026-10-20T14:59:00.000Z"), la)).toBe(true) // 07:59
    expect(isQuietHour(new Date("2026-10-20T15:00:00.000Z"), la)).toBe(false) // 08:00
  })

  it("caps a local day at three and starts over the next day", () => {
    const file = ledger()
    const noon = new Date("2026-10-20T19:00:00.000Z")
    expect(proactiveHoldReason(file, noon, la)).toBeNull()
    for (let i = 0; i < 3; i++) recordProactiveSend(file, noon, la)
    expect(proactiveHoldReason(file, noon, la)).toBe("daily_cap")
    expect(proactiveHoldReason(file, new Date("2026-10-21T16:00:00.000Z"), la)).toBeNull()
    recordProactiveSend(file, new Date("2026-10-21T16:00:00.000Z"), la)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ day: "2026-10-21", count: 1 })
    fs.writeFileSync(file, "{not json")
    expect(proactiveHoldReason(file, noon, la)).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ day: 3 }))
    expect(proactiveHoldReason(file, noon, la)).toBeNull()
    expect(proactiveHoldReason(file, new Date("2026-10-20T07:00:00.000Z"), la)).toBe("quiet_hours")
  })

  it("treats only failures of the array, disks and parity as critical", () => {
    expect(isCriticalNoticeKey('external-event:["sanctuary-health","disk:Disk:1:smart",2]')).toBe(true)
    expect(isCriticalNoticeKey('external-event:["sanctuary-health","parity:stale-or-failed",1]')).toBe(true)
    expect(isCriticalNoticeKey("owner-notice:disk:array:state")).toBe(true)
    expect(isCriticalNoticeKey('external-event:["sanctuary-health","endpoint:https://media/",1]')).toBe(false)
  })

  it("folds several held notices into one message and leaves a single one alone", () => {
    const one = { key: "a", text: "A." }
    expect(foldHeldNotices([one])).toBe(one)
    const folded = foldHeldNotices([one, { key: "b", text: "B." }])
    expect(folded.text).toBe("While you were away:\n- A.\n- B.")
    expect(folded.key).toMatch(/^held-batch:[0-9a-f]{32}$/u)
  })

  it("remembers keys released inside a folded message, newest last, capped at 500, and reads a missing or corrupt file as empty", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "released-keys-")), "telegram", "released-held-keys.json")
    expect(readReleasedHeldKeys(file)).toEqual([])
    recordReleasedHeldKeys(file, ["a", "b"])
    recordReleasedHeldKeys(file, ["a", "c"])
    expect(readReleasedHeldKeys(file)).toEqual(["b", "a", "c"])
    recordReleasedHeldKeys(file, Array.from({ length: 600 }, (_, index) => `k${index}`))
    const kept = readReleasedHeldKeys(file)
    expect(kept).toHaveLength(500)
    expect(kept.at(-1)).toBe("k599")
    fs.writeFileSync(file, JSON.stringify({ not: "a list" }))
    expect(readReleasedHeldKeys(file)).toEqual([])
    fs.writeFileSync(file, JSON.stringify(["ok", 7]))
    expect(readReleasedHeldKeys(file)).toEqual(["ok"])
    fs.writeFileSync(file, "{broken")
    expect(readReleasedHeldKeys(file)).toEqual([])
  })
})
