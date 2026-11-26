import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { afterEach, describe, expect, it } from "vitest"
import type { LetterEvent } from "../../../heart/letters/letter"
import { writeAnsweringHandle } from "../../../heart/letters/answering"
import { LetterStore } from "../../../heart/letters/store"
import { DELIVER_DEADLINE_MS, LetterRefusal, LettersWriter, answerLettersCommand, ownerFriendIds, type ChatDelivery, type WriterDeps } from "../../../heart/letters/writer"
import { renderLetter } from "../../../heart/letters/render"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const NOW = Date.parse("2026-11-23T12:00:00.000Z")
const HOUR = 60 * 60 * 1000

function friend(id: string, trustLevel: FriendRecord["trustLevel"], externalId: string): FriendRecord {
  return {
    id, name: id, trustLevel, externalIds: [{ provider: "local", externalId, linkedAt: "2026-01-01T00:00:00.000Z" }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
  } as FriendRecord
}

/** A bundles folder with one agent, slugger, whose person is friend-ari; the clock and ids are the test's. */
function setup(extra: Partial<WriterDeps> = {}): { writer: LettersWriter; bundles: string; clock: { now: number }; lettersDir: string } {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "letters-writer-"))
  roots.push(bundles)
  fs.mkdirSync(path.join(bundles, "slugger.ouro"))
  const clock = { now: NOW }
  let n = 0
  const writer = new LettersWriter({
    bundlesRoot: bundles,
    now: () => new Date(clock.now),
    newId: () => `ltr_T${++n}`,
    listFriends: async () => [friend("friend-ari", "family", "ari")],
    ownerUsername: () => "ari",
    waitUnitMs: 5,
    ...extra,
  })
  return { writer, bundles, clock, lettersDir: path.join(bundles, "slugger.ouro", "state", "letters") }
}

const know = { kind: "know", subject: "The build is green" }
const decide = {
  kind: "decide", subject: "Which name?", whyOnlyYou: "It is your product.",
  options: [{ label: "Orca", effect: "Ship as Orca." }, { label: "Ouro", effect: "Ship as Ouro." }],
}

async function refusal(promise: Promise<unknown>): Promise<LetterRefusal> {
  const error = await promise.then(() => null, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(LetterRefusal)
  return error as LetterRefusal
}

describe("LettersWriter send", () => {
  it("files a new letter to the machine owner's family record and answers needs-human with its id", async () => {
    const { writer, lettersDir } = setup()
    const result = await writer.run("slugger", "mailbox_send", { ...decide, lane: "desk/task" })
    expect(result).toEqual({ outcome: "needs-human", id: "ltr_T1", code: "L1", state: "waiting", message: "Filed L1, Which name?. It waits for the person's answer." })
    const stored = new LetterStore(lettersDir).read("ltr_T1")!
    expect(stored.letter).toMatchObject({ v: 1, id: "ltr_T1", code: "L1", to: "friend-ari", from: { agent: "slugger", lane: "desk/task" }, createdAt: new Date(NOW).toISOString() })
    expect(stored.letter.options.map((option) => option.id)).toEqual(["1", "2"])
    expect(new LetterStore(lettersDir).readNextCode()).toBe(2)
    expect((await writer.run("slugger", "mailbox_send", know)).code).toBe("L2")
  })

  it("freezes the person's answering handle into the letter at filing, so a later change leaves it alone", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", know)
    expect(new LetterStore(lettersDir).read("ltr_T1")!.letter.answeringHandle).toBeUndefined()
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", know)
    writeAnsweringHandle(lettersDir, "friend-ari", "ari@example.com")
    const store = new LetterStore(lettersDir)
    expect(store.read("ltr_T2")!.letter.answeringHandle).toBe("+15551234567")
    await writer.run("slugger", "mailbox_send", know)
    expect(store.read("ltr_T3")!.letter.answeringHandle).toBe("ari@example.com")
  })

  it("previews a dry run without filing anything", async () => {
    const { writer, lettersDir } = setup()
    expect(await writer.run("slugger", "mailbox_send", know, { dryRun: true })).toEqual({ outcome: "preview", id: "", code: "", state: "waiting", message: "Would file a new letter to friend-ari." })
    expect(fs.existsSync(lettersDir)).toBe(false)
    await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })
    expect(await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" }, { dryRun: true })).toEqual({ outcome: "preview", id: "ltr_T1", code: "L1", state: "waiting", message: "Would return L1, which is already waiting with this dedupeKey." })
  })

  it("previews a duplicate of an answered letter with its real id, code and state", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })
    const answered: LetterEvent = { t: "answered", at: new Date(NOW).toISOString(), option: "1", via: "chat", evidence: { friendId: "friend-ari", channel: "bluebubbles", chatGuid: "c", messageGuid: "g", dateCreated: new Date(NOW).toISOString() }, hostTrust: "separate" }
    new LetterStore(lettersDir).append("ltr_T1", answered)
    const fresh = new LettersWriter({ bundlesRoot: path.dirname(path.dirname(path.dirname(lettersDir))), now: () => new Date(NOW), listFriends: async () => [friend("friend-ari", "family", "ari")], ownerUsername: () => "ari" })
    expect(await fresh.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" }, { dryRun: true })).toEqual({ outcome: "preview", id: "ltr_T1", code: "L1", state: "answered", message: "Would return L1, which is already answered with this dedupeKey." })
  })

  it("doesn't roll when an agent's first call is a dry run", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", know)
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "moot" })
    const later = () => new Date(NOW + 91 * 24 * HOUR)
    const bundlesRoot = path.dirname(path.dirname(path.dirname(lettersDir)))
    const fresh = new LettersWriter({ bundlesRoot, now: later, listFriends: async () => [friend("friend-ari", "family", "ari")], ownerUsername: () => "ari" })
    await fresh.run("slugger", "mailbox_send", { ...know, subject: "Preview" }, { dryRun: true })
    expect(fs.existsSync(path.join(lettersDir, "ltr_T1.jsonl"))).toBe(true)
    const other = new LettersWriter({ bundlesRoot, now: later, listFriends: async () => [friend("friend-ari", "family", "ari")], ownerUsername: () => "ari" })
    await other.run("slugger", "mailbox_list", {})
    expect(fs.existsSync(path.join(lettersDir, "closed", "2026-11", "ltr_T1.jsonl"))).toBe(true)
  })

  it("refuses a letter that breaks a rule, with the rule's own text", async () => {
    const { writer } = setup()
    const error = await refusal(writer.run("slugger", "mailbox_send", { kind: "do", subject: "Sign it" }))
    expect(error.code).toBe("invalid-letter")
    expect(error.message).toMatch(/whyOnlyYou/)
  })

  it("refuses when no single family record names the machine's owner", async () => {
    expect((await refusal(setup({ listFriends: async () => [] }).writer.run("slugger", "mailbox_send", know))).code).toBe("no-person")
    const two = setup({ listFriends: async () => [friend("a", "family", "ari"), friend("b", "family", "ari@host")] })
    expect((await refusal(two.writer.run("slugger", "mailbox_send", know))).message).toMatch(/2 family records/)
  })

  it("refiles an open duplicate in the same scope instead of filing a second letter", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })
    const again = await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })
    expect(again).toEqual({ outcome: "done", id: "ltr_T1", code: "L1", state: "waiting", message: "L1 is already waiting with this dedupeKey, so it was refiled, not filed again." })
    expect(new LetterStore(lettersDir).read("ltr_T1")!.events).toEqual([{ t: "refiled", at: new Date(NOW).toISOString(), by: "slugger" }])
  })

  it("dedupes concurrent sends with the same key through the one queue", async () => {
    const { writer } = setup()
    const results = await Promise.all([1, 2, 3].map(() => writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "same" })))
    expect(results.map((result) => result.outcome).sort()).toEqual(["done", "done", "needs-human"])
    expect(new Set(results.map((result) => result.id))).toEqual(new Set(["ltr_T1"]))
  })

  it("never hands a code out twice, even when a create fails after the counter moved", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", know)
    const create = LetterStore.prototype.create
    LetterStore.prototype.create = function (this: LetterStore, letter) {
      create.call(this, letter)
      throw new Error("fsync failed")
    }
    try {
      await expect(writer.run("slugger", "mailbox_send", know)).rejects.toThrow("fsync failed")
    } finally {
      LetterStore.prototype.create = create
    }
    expect((await writer.run("slugger", "mailbox_send", know)).code).toBe("L3")
    expect(new LetterStore(lettersDir).readNextCode()).toBe(4)
  })

  it("removes the file a failed create left, so a retry after a restart keeps one waiting letter per dedupe scope", async () => {
    const { writer, lettersDir } = setup()
    const create = LetterStore.prototype.create
    LetterStore.prototype.create = function (this: LetterStore, letter) {
      create.call(this, letter)
      throw new Error("fsync failed")
    }
    try {
      await expect(writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })).rejects.toThrow("fsync failed")
    } finally {
      LetterStore.prototype.create = create
    }
    expect(fs.existsSync(path.join(lettersDir, "ltr_T1.jsonl"))).toBe(false)
    expect((await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })).code).toBe("L2")
    const waiting = new LetterStore(lettersDir).loadAll().filter((stored) => stored.letter.dedupeKey === "k")
    expect(waiting.map((stored) => stored.letter.code)).toEqual(["L2"])
  })

  it("indexes the file a failed create couldn't remove, so a retry dedupes to it", async () => {
    const { writer } = setup()
    const create = LetterStore.prototype.create
    const discard = LetterStore.prototype.discard
    LetterStore.prototype.create = function (this: LetterStore, letter) {
      create.call(this, letter)
      throw new Error("fsync failed")
    }
    LetterStore.prototype.discard = () => false
    try {
      await expect(writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })).rejects.toThrow("fsync failed")
    } finally {
      LetterStore.prototype.create = create
      LetterStore.prototype.discard = discard
    }
    const retry = await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })
    expect(retry).toMatchObject({ outcome: "done", id: "ltr_T1", code: "L1", state: "waiting" })
  })

  it("leaves another letter's file alone when a create finds its id taken", async () => {
    const { writer, lettersDir } = setup({ newId: () => "ltr_SAME" })
    await writer.run("slugger", "mailbox_send", know)
    await expect(writer.run("slugger", "mailbox_send", { ...know, subject: "Second" })).rejects.toThrow(/EEXIST/)
    expect(new LetterStore(lettersDir).read("ltr_SAME")!.letter.subject).toBe("The build is green")
  })

  it("rethrows a failed create whose leftover can't be read or removed", async () => {
    const { writer } = setup()
    const create = LetterStore.prototype.create
    const discard = LetterStore.prototype.discard
    LetterStore.prototype.create = () => { throw new Error("ENOSPC") }
    LetterStore.prototype.discard = () => false
    try {
      await expect(writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })).rejects.toThrow("ENOSPC")
    } finally {
      LetterStore.prototype.create = create
      LetterStore.prototype.discard = discard
    }
    expect((await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })).code).toBe("L2")
  })

  it("rolls letters closed long enough on a later send, so a long-running daemon rolls them too", async () => {
    const { writer, clock, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", know)
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "moot" })
    clock.now = NOW + 91 * 24 * HOUR
    await writer.run("slugger", "mailbox_send", { ...know, subject: "Next" })
    expect(fs.existsSync(path.join(lettersDir, "closed", "2026-11", "ltr_T1.jsonl"))).toBe(true)
    expect((await writer.run("slugger", "mailbox_read", { letter: "L1" })).state).toBe("withdrawn")
  })

  it("keeps filing when a closed letter can't be rolled, and rolls it on a later send; a dry run doesn't roll", async () => {
    const { writer, clock, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", know)
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "moot" })
    clock.now = NOW + 91 * 24 * HOUR
    const rolled = path.join(lettersDir, "closed", "2026-11", "ltr_T1.jsonl")
    await writer.run("slugger", "mailbox_send", { ...know, subject: "Preview" }, { dryRun: true })
    expect(fs.existsSync(rolled)).toBe(false)
    const roll = LetterStore.prototype.roll
    LetterStore.prototype.roll = () => { throw new Error("EXDEV") }
    try {
      expect((await writer.run("slugger", "mailbox_send", { ...know, subject: "Second" })).code).toBe("L2")
    } finally {
      LetterStore.prototype.roll = roll
    }
    expect(fs.existsSync(rolled)).toBe(false)
    expect((await writer.run("slugger", "mailbox_read", { letter: "L1" })).state).toBe("withdrawn")
    await writer.run("slugger", "mailbox_send", { ...know, subject: "Third" })
    expect(fs.existsSync(rolled)).toBe(true)
  })

  it("refuses an input that isn't an object", async () => {
    const { writer } = setup()
    expect((await refusal(writer.run("slugger", "mailbox_read", null as never))).code).toBe("bad-input")
    expect((await refusal(writer.run("slugger", "mailbox_read", [] as never))).code).toBe("bad-input")
  })

  it("keeps the queue going after a send fails", async () => {
    const { writer } = setup()
    await refusal(writer.run("slugger", "mailbox_send", { kind: "do", subject: "x" }))
    expect((await writer.run("slugger", "mailbox_send", know)).outcome).toBe("needs-human")
  })
})

function answeredEvent(at: number): LetterEvent {
  return {
    t: "answered", at: new Date(at).toISOString(), option: "2", via: "chat",
    evidence: { friendId: "friend-ari", channel: "bluebubbles", chatGuid: "c", messageGuid: "g", dateCreated: "d" }, hostTrust: "separate",
  }
}

function appendDirect(lettersDir: string, id: string, event: LetterEvent): void {
  new LetterStore(lettersDir).append(id, event)
}

describe("LettersWriter after a restart", () => {
  it("rebuilds from disk: answered-then-refile returns the answer, codes keep counting, and old closed letters roll", async () => {
    const first = setup()
    await first.writer.run("slugger", "mailbox_send", { ...decide, dedupeKey: "name" })
    await first.writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "old" })
    await first.writer.run("slugger", "mailbox_withdraw", { letter: "L2", reason: "moot" })
    appendDirect(first.lettersDir, "ltr_T1", answeredEvent(NOW + HOUR))
    // The counter file is lost; the codes on disk still keep it from going back.
    fs.rmSync(path.join(first.lettersDir, "next-code"))
    let n = 10
    const clock = { now: NOW + 2 * HOUR }
    const deps: WriterDeps = {
      bundlesRoot: first.bundles, now: () => new Date(clock.now), newId: () => `ltr_R${++n}`,
      listFriends: async () => [friend("friend-ari", "family", "ari")], ownerUsername: () => "ari", waitUnitMs: 5,
    }
    const again = await new LettersWriter(deps).run("slugger", "mailbox_send", { ...decide, dedupeKey: "name" })
    expect(again).toEqual({ outcome: "done", id: "ltr_T1", code: "L1", state: "answered", message: "L1 was answered 2 (Ouro) in the last day, so the answer stands." })
    expect((await new LettersWriter(deps).run("slugger", "mailbox_send", know)).code).toBe("L3")

    clock.now = NOW + 91 * 24 * HOUR
    const later = new LettersWriter(deps)
    const list = await later.run("slugger", "mailbox_list", { all: true })
    expect(list.count).toBe(3)
    expect(fs.existsSync(path.join(first.lettersDir, "closed", "2026-11", "ltr_T1.jsonl"))).toBe(true)
    expect(fs.existsSync(path.join(first.lettersDir, "closed", "2026-11", "ltr_T2.jsonl"))).toBe(true)
    expect(fs.existsSync(path.join(first.lettersDir, "ltr_R11.jsonl"))).toBe(true)
    expect(JSON.parse(String((await later.run("slugger", "mailbox_read", { letter: "L1" })).letter)).id).toBe("ltr_T1")
  })
})

describe("LettersWriter list and read", () => {
  it("lists waiting letters oldest first, one line each, and narrows by mine, kind and all", async () => {
    const { writer, clock } = setup()
    expect(await writer.run("slugger", "mailbox_list", {})).toEqual({ outcome: "done", count: 0, listing: "" })
    await writer.run("slugger", "mailbox_send", know)
    clock.now += 3 * HOUR
    await writer.run("slugger", "mailbox_send", decide)
    await writer.run("slugger", "mailbox_withdraw", { letter: "L2", reason: "moot" })
    clock.now += 2 * 24 * HOUR
    expect(await writer.run("slugger", "mailbox_list", {})).toEqual({ outcome: "done", count: 1, listing: "L1  waiting  2d  The build is green" })
    expect((await writer.run("slugger", "mailbox_list", { all: true })).listing).toBe("L1  waiting  2d  The build is green\nL2  withdrawn  2d  Which name?")
    expect((await writer.run("slugger", "mailbox_list", { kind: "decide", all: true })).count).toBe(1)
    expect((await writer.run("slugger", "mailbox_list", { mine: true })).count).toBe(1)
  })

  it("says ages in minutes, hours and days", async () => {
    const { writer, clock } = setup()
    await writer.run("slugger", "mailbox_send", know)
    clock.now += 5 * 60 * 1000
    expect((await writer.run("slugger", "mailbox_list", {})).listing).toMatch(/ 5m /)
    clock.now += 2 * HOUR
    expect((await writer.run("slugger", "mailbox_list", {})).listing).toMatch(/ 2h /)
  })

  it("reads one letter by id or code with each event on its own line", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", { ...decide, dedupeKey: "k" })
    await writer.run("slugger", "mailbox_send", { ...decide, dedupeKey: "k" })
    const events: LetterEvent[] = [
      { t: "delivered", at: "2026-11-23T12:01:00.000Z", via: "chat", channel: "bluebubbles", key: "k", messageId: "m" },
      { t: "seen", at: "2026-11-23T12:02:00.000Z", via: "web" },
      answeredEvent(NOW + 3 * 60 * 1000),
      { t: "returned", at: "2026-11-23T12:04:00.000Z", to: "session", ok: true },
      { t: "returned", at: "2026-11-23T12:05:00.000Z", to: "waiter", ok: false },
      { t: "expired", at: "2026-11-23T12:06:00.000Z" },
      { t: "withdrawn", at: "2026-11-23T12:07:00.000Z", reason: "moot" },
      { ...answeredEvent(NOW + 8 * 60 * 1000), option: "9" },
    ]
    for (const event of events) appendDirect(lettersDir, "ltr_T1", event)
    const restarted = new LettersWriter({ ...depsOf(writer) })
    const read = await restarted.run("slugger", "mailbox_read", { letter: "l1" })
    expect(read.outcome).toBe("done")
    expect(read.state).toBe("answered")
    expect(JSON.parse(String(read.letter)).subject).toBe("Which name?")
    expect(String(read.events).split("\n")).toEqual([
      "2026-11-23T12:00:00.000Z refiled by slugger",
      "2026-11-23T12:01:00.000Z delivered to bluebubbles",
      "2026-11-23T12:02:00.000Z seen on web",
      "2026-11-23T12:03:00.000Z answered 2 (Ouro)",
      "2026-11-23T12:04:00.000Z returned to session",
      "2026-11-23T12:05:00.000Z returned to waiter, failed",
      "2026-11-23T12:06:00.000Z expired",
      "2026-11-23T12:07:00.000Z withdrawn: moot",
      "2026-11-23T12:08:00.000Z answered 9",
    ])
    expect((await restarted.run("slugger", "mailbox_read", { letter: "ltr_T1" })).state).toBe("answered")
  })

  it("refuses a letter it doesn't have", async () => {
    const { writer } = setup()
    for (const action of ["mailbox_read", "mailbox_wait", "mailbox_withdraw", "mailbox_deliver"]) {
      expect((await refusal(writer.run("slugger", action, { letter: "L9", reason: "r" }))).code).toBe("not-found")
    }
    expect((await refusal(writer.run("slugger", "mailbox_read", { letter: 7 }))).code).toBe("not-found")
  })
})

function depsOf(writer: LettersWriter): WriterDeps {
  return (writer as unknown as { deps: WriterDeps }).deps
}

describe("LettersWriter withdraw and deliver", () => {
  it("lets only the filing agent withdraw a waiting letter", async () => {
    const { writer, lettersDir, bundles } = setup()
    await writer.run("slugger", "mailbox_send", know)
    fs.mkdirSync(path.join(bundles, "butler.ouro"))
    const butlerDir = path.join(bundles, "butler.ouro", "state", "letters")
    fs.mkdirSync(butlerDir, { recursive: true })
    fs.copyFileSync(path.join(lettersDir, "ltr_T1.jsonl"), path.join(butlerDir, "ltr_T1.jsonl"))
    expect((await refusal(writer.run("butler", "mailbox_withdraw", { letter: "L1", reason: "mine now" }))).code).toBe("not-sender")
    expect(await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "moot" })).toEqual({ outcome: "done", state: "withdrawn" })
    expect((await refusal(writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "again" }))).code).toBe("not-waiting")
  })

  it("refuses a reason that is empty, too long or carries a letter code, and stores it as sender text", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", know)
    for (const reason of [" ", undefined, "x".repeat(201), "Answered as L2 already"]) {
      expect((await refusal(writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason }))).code).toBe("bad-input")
    }
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: " moot\u200b\u200bnow " })
    expect(new LetterStore(lettersDir).read("ltr_T1")!.events[0]).toMatchObject({ t: "withdrawn", reason: "moot now" })
  })

  it("previews a dry-run withdraw after every check, and writes nothing", async () => {
    const { writer, lettersDir } = setup()
    await writer.run("slugger", "mailbox_send", know)
    expect(await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "moot" }, { dryRun: true })).toEqual({ outcome: "preview", state: "waiting" })
    expect(new LetterStore(lettersDir).read("ltr_T1")!.events).toEqual([])
    expect((await refusal(writer.run("slugger", "mailbox_withdraw", { letter: "L1" }, { dryRun: true }))).code).toBe("bad-input")
    expect((await refusal(writer.run("slugger", "mailbox_withdraw", { letter: "L9", reason: "moot" }, { dryRun: true }))).code).toBe("not-found")
  })

  it("can't deliver until the person has an answering handle", async () => {
    const { writer } = setup()
    await writer.run("slugger", "mailbox_send", know)
    expect((await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))).code).toBe("no-answering-handle")
    expect((await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }, { dryRun: true }))).code).toBe("no-answering-handle")
  })

  it("sends a waiting letter to the handle frozen into it, in Ouro's text, and records where it landed", async () => {
    const sent: ChatDelivery[] = []
    const { writer, lettersDir } = setup({ deliverChat: async (request) => { sent.push(request); return { channel: "bluebubbles", key: "iMessage;-;+15551234567", messageId: "msg-1" } } })
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", decide)
    writeAnsweringHandle(lettersDir, "friend-ari", "ari@example.com")
    const preview = await writer.run("slugger", "mailbox_deliver", { letter: "L1" }, { dryRun: true })
    expect(preview).toEqual({ outcome: "preview", state: "waiting", text: renderLetter(new LetterStore(lettersDir).read("ltr_T1")!.letter) })
    expect(sent).toEqual([])
    expect(await writer.run("slugger", "mailbox_deliver", { letter: "L1" })).toEqual({ outcome: "done", state: "waiting", channel: "bluebubbles" })
    expect(sent).toEqual([{ agent: "slugger", handle: "+15551234567", text: preview.text }])
    expect(new LetterStore(lettersDir).read("ltr_T1")!.events).toEqual([
      { t: "delivered", at: new Date(NOW).toISOString(), via: "chat", channel: "bluebubbles", key: "iMessage;-;+15551234567", messageId: "msg-1" },
    ])
  })

  it("refuses to deliver a closed letter, without a chat, or when the send fails, and the letter stays waiting", async () => {
    const { writer, lettersDir } = setup()
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", know)
    await writer.run("slugger", "mailbox_send", know)
    expect((await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))).code).toBe("chat-unavailable")
    depsOf(writer).deliverChat = async () => { throw new Error("server down") }
    const failed = await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))
    expect([failed.code, failed.message]).toEqual(["send-failed", "L1 didn't send: server down. It stays waiting."])
    expect(new LetterStore(lettersDir).read("ltr_T1")!.events).toEqual([])
    await writer.run("slugger", "mailbox_withdraw", { letter: "L2", reason: "moot" })
    expect((await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L2" }))).code).toBe("not-waiting")
  })
})

describe("LettersWriter deliver, once", () => {
  const receipt = { channel: "bluebubbles", key: "k", messageId: "m" }

  it("sends a letter to the chat once, and refuses a second delivery", async () => {
    let sends = 0
    const { writer, lettersDir } = setup({ deliverChat: async () => { sends += 1; return receipt } })
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", know)
    await writer.run("slugger", "mailbox_deliver", { letter: "L1" })
    expect((await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))).code).toBe("already-delivered")
    expect(sends).toBe(1)
  })

  it("refuses a letter whose expiry has passed, even before Ouro has marked it expired", async () => {
    const { writer, lettersDir, clock } = setup({ deliverChat: async () => receipt })
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", { ...know, expiresAt: new Date(NOW + HOUR).toISOString() })
    clock.now = NOW + 2 * HOUR
    const refused = await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))
    expect([refused.code, refused.message]).toEqual(["not-waiting", `L1 expired at ${new Date(NOW + HOUR).toISOString()}, so there is nothing to deliver.`])
  })

  it("counts a send that may have reached the chat as delivered, so a retry never sends it twice", async () => {
    const { writer, lettersDir } = setup({ deliverChat: async () => { throw Object.assign(new Error("reply didn't parse"), { transportInvoked: true }) } })
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", know)
    const refused = await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))
    expect([refused.code, refused.message]).toEqual(["send-uncertain", "L1 may have reached the chat (reply didn't parse), so Ouro counts it as delivered and won't send it again."])
    expect(new LetterStore(lettersDir).read("ltr_T1")!.events).toEqual([{ t: "delivered", at: new Date(NOW).toISOString(), via: "chat", channel: "unconfirmed", key: "", messageId: "" }])
    expect((await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))).code).toBe("already-delivered")
  })

  it("answers before the door gives up when the chat is slow, counting the letter as delivered", async () => {
    const { writer, lettersDir } = setup({ deliverChat: () => new Promise(() => {}), deliverDeadlineMs: 10 })
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", know)
    const refused = await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))
    expect([refused.code, refused.message]).toEqual(["send-uncertain", "L1 may have reached the chat (no answer from the chat within 0 seconds), so Ouro counts it as delivered and won't send it again."])
    expect(DELIVER_DEADLINE_MS).toBe(25_000)
  })

  it("says a sent letter it couldn't record went out, so the agent doesn't send it again", async () => {
    const { writer, lettersDir } = setup({ deliverChat: async () => receipt })
    writeAnsweringHandle(lettersDir, "friend-ari", "+15551234567")
    await writer.run("slugger", "mailbox_send", know)
    const append = LetterStore.prototype.append
    LetterStore.prototype.append = () => { throw new Error("disk full") }
    try {
      const refused = await refusal(writer.run("slugger", "mailbox_deliver", { letter: "L1" }))
      expect([refused.code, refused.message]).toEqual(["sent-unrecorded", "L1 went to the chat, but writing its delivered event failed (disk full), so the mailbox doesn't show it as delivered. Don't deliver it again."])
    } finally {
      LetterStore.prototype.append = append
    }
  })
})

describe("LettersWriter wait", () => {
  it("returns at once when the letter has left waiting, with a cursor", async () => {
    const { writer } = setup()
    await writer.run("slugger", "mailbox_send", know)
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "moot" })
    expect(await writer.run("slugger", "mailbox_wait", { letter: "L1" })).toEqual({ outcome: "done", state: "withdrawn", cursor: 1 })
  })

  it("times out with the cursor when nothing changes", async () => {
    const { writer } = setup()
    await writer.run("slugger", "mailbox_send", know)
    expect(await writer.run("slugger", "mailbox_wait", { letter: "L1", timeout: 1 })).toEqual({ outcome: "timeout", state: "waiting", cursor: 0 })
  })

  it("wakes when the letter leaves waiting, and when an event passes the cursor", async () => {
    const { writer } = setup({ waitUnitMs: 1000 })
    await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })
    const waiting = writer.run("slugger", "mailbox_wait", { letter: "L1", timeout: 30 })
    const other = writer.run("slugger", "mailbox_wait", { letter: "L1", cursor: 0, timeout: 30 })
    await writer.run("slugger", "mailbox_send", { ...know, dedupeKey: "k" })
    expect(await other).toEqual({ outcome: "done", state: "waiting", cursor: 1 })
    await writer.run("slugger", "mailbox_withdraw", { letter: "L1", reason: "moot" })
    expect(await waiting).toEqual({ outcome: "done", state: "withdrawn", cursor: 2 })
  })

  it("keeps the timeout between 1 and 300 seconds and ignores a cursor that isn't a count", async () => {
    const { writer } = setup({ waitUnitMs: 1 })
    await writer.run("slugger", "mailbox_send", know)
    expect((await writer.run("slugger", "mailbox_wait", { letter: "L1", timeout: 0, cursor: -1 })).outcome).toBe("timeout")
    expect((await writer.run("slugger", "mailbox_wait", { letter: "L1", timeout: 9999, cursor: "x" })).outcome).toBe("timeout")
  })
})

describe("LettersWriter agents", () => {
  it("refuses an agent with no bundle, or a name that could leave the bundles folder", async () => {
    const { writer } = setup()
    expect((await refusal(writer.run("nobody", "mailbox_list", {}))).code).toBe("no-agent")
    expect((await refusal(writer.run("../slugger", "mailbox_list", {}))).code).toBe("no-agent")
  })

  it("refuses an action it doesn't have", async () => {
    expect((await refusal(setup().writer.run("slugger", "mailbox_answer", {}))).code).toBe("unknown-door")
  })
})

describe("LettersWriter defaults", () => {
  it("uses the real clock, ULID ids and one-second waits", async () => {
    const { bundles } = setup()
    const writer = new LettersWriter({ bundlesRoot: bundles, listFriends: async () => [friend("friend-ari", "family", "ari")], ownerUsername: () => "ari" })
    const sent = await writer.run("slugger", "mailbox_send", know)
    expect(sent.id).toMatch(/^ltr_[0-9A-Z]{26}$/)
    const started = Date.now()
    expect((await writer.run("slugger", "mailbox_wait", { letter: "L1", timeout: 1 })).outcome).toBe("timeout")
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })
})

describe("ownerFriendIds", () => {
  it("reads the family records naming this machine's owner from the bundle's friends folder", async () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "letters-friends-"))
    roots.push(bundle)
    const store = new FileFriendStore(path.join(bundle, "friends"))
    await store.put("friend-ari", friend("friend-ari", "family", "ari"))
    await store.put("friend-guest", friend("friend-guest", "acquaintance", "ari"))
    await store.put("friend-other", friend("friend-other", "family", "someone"))
    expect(await ownerFriendIds(bundle, "ari")).toEqual(["friend-ari"])
    expect(await ownerFriendIds(bundle, null)).toEqual([])
  })

  it("is the writer's default", async () => {
    const { writer } = setup({ listFriends: undefined, ownerUsername: () => "nobody-here" })
    expect((await refusal(writer.run("slugger", "mailbox_send", know))).code).toBe("no-person")
    // With no owner given it asks the machine; a family record for an owner that isn't this machine's never matches.
    const machine = setup({ listFriends: async () => [friend("friend-x", "family", "no-such-user-c21")], ownerUsername: undefined })
    expect((await refusal(machine.writer.run("slugger", "mailbox_send", know))).code).toBe("no-person")
  })
})

describe("answerLettersCommand", () => {
  it("answers the daemon's socket command with the result, a coded refusal, or a failure", async () => {
    const { writer } = setup()
    expect(await answerLettersCommand(writer, { kind: "letters.action", agent: "slugger", action: "mailbox_list", input: {} })).toEqual({ ok: true, data: { outcome: "done", count: 0, listing: "" } })
    expect(await answerLettersCommand(writer, { kind: "letters.action", agent: "slugger", action: "mailbox_send", input: know, dryRun: true })).toMatchObject({ ok: true, data: { outcome: "preview" } })
    expect(await answerLettersCommand(writer, { kind: "letters.action", agent: "nobody", action: "mailbox_list", input: {} })).toEqual({ ok: false, error: "No agent bundle nobody.ouro is on this machine.", data: { code: "no-agent", message: "No agent bundle nobody.ouro is on this machine." } })
    const broken = new LettersWriter({ ...depsOf(writer), listFriends: async () => { throw new Error("disk gone") } })
    expect(await answerLettersCommand(broken, { kind: "letters.action", agent: "slugger", action: "mailbox_send", input: know })).toEqual({ ok: false, error: "disk gone" })
  })
})
