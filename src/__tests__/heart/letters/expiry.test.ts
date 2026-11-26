import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { FriendRecord } from "@ouro.bot/friends"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { letterExpiredNote, letterExpiredTeller, letterExpiredWake } from "../../../heart/letters/expired-note"
import type { Letter } from "../../../heart/letters/letter"
import { queueNoteAndWake } from "../../../heart/letters/tell-agent"
import { EXPIRY_GRACE_MS, LetterRefusal, LettersWriter, NOW_LETTER_EXPIRY_MS, type WriterDeps } from "../../../heart/letters/writer"
import { getPrivateRuntimePendingDir } from "../../../mind/pending"
import { emitNervesEvent } from "../../../nerves/runtime"

const NOW = Date.parse("2026-11-26T12:00:00.000Z")
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.mocked(emitNervesEvent).mockClear() })
const events = (name: string) => vi.mocked(emitNervesEvent).mock.calls.filter(([event]) => event.event === name)

function setup(extra: Partial<WriterDeps> = {}) {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "letters-expiry-"))
  roots.push(bundles)
  fs.mkdirSync(path.join(bundles, "slugger.ouro"))
  const clock = { now: NOW }
  let n = 0
  const writer = new LettersWriter({
    bundlesRoot: bundles,
    now: () => new Date(clock.now),
    newId: () => `ltr_T${++n}`,
    listFriends: async () => [{ id: "friend-ari", trustLevel: "family", externalIds: [{ provider: "local", externalId: "ari" }] } as unknown as FriendRecord],
    ownerUsername: () => "ari",
    waitUnitMs: 5,
    ...extra,
  })
  return { writer, bundles, clock }
}
const notes = (bundles: string) => {
  const dir = getPrivateRuntimePendingDir("slugger", path.join(bundles, "slugger.ouro"))
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : []
}

describe("when a letter expires", () => {
  it("gives a now letter 24 hours when its sender sets no expiry, and leaves the others alone", async () => {
    const { writer } = setup()
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Now", urgency: "now" })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Set", urgency: "now", expiresAt: "2026-11-27T00:00:00.000Z" })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Today", urgency: "today" })
    const expiry = async (code: string) => (JSON.parse(String((await writer.run("slugger", "mailbox_read", { letter: code })).letter)) as Letter).expiresAt
    expect(await expiry("L1")).toBe(new Date(NOW + NOW_LETTER_EXPIRY_MS).toISOString())
    expect(await expiry("L2")).toBe("2026-11-27T00:00:00.000Z")
    expect(await expiry("L3")).toBeUndefined()
  })

  it("closes each waiting letter past its expiry, once, releases its waiters and tells its agent", async () => {
    const told: string[] = []
    const { writer, bundles, clock } = setup({ onExpired: async (agent, letter) => { told.push(`${agent}:${letter.code}`) } })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Soon", expiresAt: new Date(NOW + 1000).toISOString() })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Later", expiresAt: new Date(NOW + 10_000).toISOString() })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Never" })
    // Folders that aren't agents with letters are passed over.
    fs.mkdirSync(path.join(bundles, "notes"))
    fs.mkdirSync(path.join(bundles, "empty.ouro"))
    expect(await writer.expireDue()).toBe(0)
    // Within the grace after its expiry a letter stays open, so an answer sent in time and read late still counts.
    clock.now = NOW + 1000 + EXPIRY_GRACE_MS - 1
    expect(await writer.expireDue()).toBe(0)
    const waiting = writer.run("slugger", "mailbox_wait", { letter: "L1", timeout: 50 })
    clock.now = NOW + 1000 + EXPIRY_GRACE_MS
    expect(await writer.expireDue()).toBe(1)
    expect(await waiting).toMatchObject({ state: "expired" })
    expect(await writer.expireDue()).toBe(0)
    expect(told).toEqual(["slugger:L1"])
    expect((await writer.run("slugger", "mailbox_list", {})).listing).not.toContain("Soon")
  })

  it("keeps the expiry when telling the agent fails, and passes over an agent whose letters don't read", async () => {
    const { writer, bundles, clock } = setup({ onExpired: async () => { throw new Error("down") } })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Soon", expiresAt: new Date(NOW + 1000).toISOString() })
    clock.now = NOW + 1000 + EXPIRY_GRACE_MS
    expect(await writer.expireDue()).toBe(1)
    await vi.waitFor(() => expect(events("letters.expired_tell_failed")).toEqual([[expect.objectContaining({ meta: { code: "L1", reason: "down" } })]]))
    fs.mkdirSync(path.join(bundles, "broken.ouro", "state", "letters", "ltr_X.jsonl"), { recursive: true })
    expect(await writer.expireDue()).toBe(0)
    expect(events("letters.expiry_failed")).toHaveLength(1)
    const quiet = setup()
    await quiet.writer.run("slugger", "mailbox_send", { kind: "know", subject: "Soon", expiresAt: new Date(NOW + 1000).toISOString() })
    quiet.clock.now = NOW + 1000 + EXPIRY_GRACE_MS
    expect(await quiet.writer.expireDue()).toBe(1)
    expect(notes(quiet.bundles)).toEqual([])
  })

  it("leaves a letter withdrawn before its expiry alone", async () => {
    const told: string[] = []
    const { writer, clock } = setup({ onExpired: async (_agent, letter) => { told.push(letter.code) } })
    await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Soon", expiresAt: new Date(NOW + 1000).toISOString() })
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "Fixed it myself." })
    clock.now = NOW + 1000 + EXPIRY_GRACE_MS
    expect(await writer.expireDue()).toBe(0)
    expect(told).toEqual([])
  })

  it("refuses an expiresAt that has already passed, in a preview too", async () => {
    const { writer } = setup()
    for (const dryRun of [false, true]) {
      const refused = await writer.run("slugger", "mailbox_send", { kind: "know", subject: "Late", expiresAt: new Date(NOW).toISOString() }, { dryRun }).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(LetterRefusal)
      expect(refused).toMatchObject({ code: "invalid-letter", message: expect.stringContaining("has already passed") })
    }
  })

  it("files a new letter for a dedupeKey whose waiting letter is past its expiry", async () => {
    const { writer, clock } = setup()
    const letter = { kind: "know", subject: "Again", dedupeKey: "k", expiresAt: new Date(NOW + 1000).toISOString() }
    expect(await writer.run("slugger", "mailbox_send", letter)).toMatchObject({ code: "L1" })
    expect(await writer.run("slugger", "mailbox_send", letter)).toMatchObject({ code: "L1", message: expect.stringContaining("refiled") })
    clock.now = NOW + 2000
    expect(await writer.run("slugger", "mailbox_send", { ...letter, expiresAt: new Date(NOW + 60_000).toISOString() })).toMatchObject({ code: "L2" })
  })
})

describe("telling the agent", () => {
  const letter = { id: "ltr_A1", code: "L7", subject: "Which name?", expiresAt: "2026-11-27T12:00:00.000Z" } as Letter

  it("queues one note dated by the expiry and wakes the agent", async () => {
    const { bundles } = setup()
    const wakes: unknown[] = []
    const tell = letterExpiredTeller(bundles, async (wake) => { wakes.push(wake); return { ok: true, data: { decision: { executable: true } } } })
    await tell("slugger", letter)
    await tell("slugger", letter)
    expect(notes(bundles)).toEqual([expect.objectContaining({
      packetId: "letter-expired:ltr_A1", timestamp: Date.parse(letter.expiresAt!), channel: "inner",
      content: "letter L7 expired at 2026-11-27T12:00:00.000Z with no answer from my person; its sender gave it the subject \"Which name?\". it is closed, so it can't be answered or delivered now; mailbox_read shows it.",
    })])
    expect(letterExpiredNote(letter)).toBe(notes(bundles)[0].content)
    expect(wakes[0]).toEqual(letterExpiredWake("slugger", letter))
    expect(events("letters.expired_told")).toHaveLength(2)
  })

  it("logs a wake that is refused, denied or throws, and keeps the note", async () => {
    const { bundles } = setup()
    for (const wake of [
      async () => ({ ok: false, error: "no" }),
      async () => ({ ok: false }),
      async () => ({ ok: true, message: "denied", data: { decision: { executable: false } } }),
      async () => ({ ok: true, data: { decision: { executable: false } } }),
      async () => { throw new Error("down") },
    ]) await letterExpiredTeller(bundles, wake)("slugger", letter)
    expect(events("letters.expired_wake_failed").map(([event]) => event.meta?.error)).toEqual(["no", "the wake was refused", "denied", "the wake was denied", "down"])
    expect(notes(bundles)).toHaveLength(1)
  })

  it("throws when the note can't be queued", async () => {
    const blocked = path.join(setup().bundles, "file")
    fs.writeFileSync(blocked, "")
    await expect(queueNoteAndWake("slugger", blocked, { content: "x", packetId: "p", timestamp: 1 }, async () => ({ ok: true }))).rejects.toThrow()
  })
})
