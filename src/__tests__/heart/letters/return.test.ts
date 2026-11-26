import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { FriendRecord } from "@ouro.bot/friends"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
import type { ServerMessage } from "../../../heart/letters/answer-reader"
import { writeAnsweringHandle } from "../../../heart/letters/answering"
import type { Letter, LetterEvent } from "../../../heart/letters/letter"
import { RETURN_BACKOFF_MAX_MS, answerReturnText, returnDue, returnSession } from "../../../heart/letters/return-to-session"
import { LettersWriter, answerLettersCommand, type WriterDeps } from "../../../heart/letters/writer"
import { resolveSessionPath } from "../../../heart/config"
import { getPendingDir } from "../../../mind/pending"
import { emitNervesEvent } from "../../../nerves/runtime"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const NOW = Date.parse("2026-11-26T12:00:00.000Z")
const ARI = "+15551234567"
const CHAT = { friendId: "friend-bo", channel: "teams", key: "thread-1" }
const DECIDE = { kind: "decide", subject: "Which name?", whyOnlyYou: "It is your product.", options: [{ label: "Orca", effect: "Ship as Orca." }, { label: "Ouro", effect: "Ship as Ouro." }] }

function friend(id: string, name: string): FriendRecord {
  return { id, name, trustLevel: "family", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "2026-01-01T00:00:00.000Z" }] } as unknown as FriendRecord
}

/** Slugger's letter L1, filed from `session` and delivered at NOW; the clock is the test's. */
async function filed(session: unknown, extra: Partial<WriterDeps> = {}) {
  const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "letters-return-"))
  roots.push(bundles)
  const agentRoot = path.join(bundles, "slugger.ouro")
  // The asking session has had turns, so it has its session file.
  fs.writeFileSync(resolveSessionPath(CHAT.friendId, CHAT.channel, CHAT.key, { agentRoot, ensureDir: true }), "{}")
  writeAnsweringHandle(path.join(agentRoot, "state", "letters"), "friend-ari", ARI)
  const clock = { now: NOW }
  let n = 0
  const writer = new LettersWriter({
    bundlesRoot: bundles, now: () => new Date(clock.now), newId: () => `ltr_T${++n}`, listFriends: async () => [friend("friend-ari", "Ari")], ownerUsername: () => "ari",
    deliverChat: async () => ({ channel: "bluebubbles", key: `iMessage;-;${ARI}`, messageId: "sent-1" }),
    ...extra,
  })
  await answerLettersCommand(writer, { kind: "letters.action", agent: "slugger", action: "mailbox_send", input: DECIDE, ...(session ? { session: session as never } : {}) })
  await writer.run("slugger", "mailbox_deliver", { letter: "L1" })
  clock.now = NOW + 60_000
  return { writer, clock, bundles, agentRoot }
}
const answer = (extra: Partial<ServerMessage> = {}): ServerMessage =>
  ({ guid: "m-1", text: "L1 2 — after lunch", isFromMe: false, sender: ARI, service: "iMessage", chatGuids: [`iMessage;-;${ARI}`], dateCreated: NOW + 30_000, ...extra })
const read = async (writer: LettersWriter) => JSON.parse(String((await writer.run("slugger", "mailbox_read", { letter: "L1" })).letter)) as Letter
/** The letter's events as its file holds them, after the letter line. */
const events = async (writer: LettersWriter) => {
  const { id } = await read(writer)
  const file = path.join(roots[roots.length - 1]!, "slugger.ouro", "state", "letters", `${id}.jsonl`)
  return fs.readFileSync(file, "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line) as LetterEvent)
}
const queued = (agentRoot: string, session = CHAT) => {
  const dir = getPendingDir("slugger", session.friendId, session.channel, session.key, agentRoot)
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : []
}

describe("the session a letter returns to", () => {
  it("is a turn's session whose parts each name one folder, never the private runtime or a voice call", () => {
    expect(returnSession(CHAT)).toEqual(CHAT)
    expect(returnSession({ ...CHAT, extra: 1 })).toEqual(CHAT)
    // The keys the senses really use.
    for (const key of ["chat:iMessage;-;+15551234567", "telegram:tg_42", "19:meeting_abc@thread.v2", "a..b"]) expect(returnSession({ ...CHAT, key })).toEqual({ ...CHAT, key })
    for (const bad of [undefined, null, "x", { ...CHAT, key: "../x" }, { ...CHAT, key: ".." }, { ...CHAT, key: "." }, { ...CHAT, channel: "a/b" }, { ...CHAT, key: "a\\b" }, { ...CHAT, key: "a\0b" },
      { ...CHAT, friendId: 7 }, { ...CHAT, key: "" }, { ...CHAT, key: "k".repeat(301) }, { friendId: "self", channel: "inner", key: "dialog" }, { ...CHAT, channel: "voice" }]) {
      expect(returnSession(bad)).toBeNull()
    }
  })

  it("must be a session the agent has had, when the agent's folder is given", () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "letters-return-root-"))
    roots.push(agentRoot)
    expect(returnSession(CHAT, agentRoot)).toBeNull()
    fs.writeFileSync(resolveSessionPath(CHAT.friendId, CHAT.channel, CHAT.key, { agentRoot, ensureDir: true }), "{}")
    expect(returnSession(CHAT, agentRoot)).toEqual(CHAT)
  })

  it("reads as the person's answer, with the note when there is one", () => {
    const letter = { code: "L7" } as Letter
    expect(answerReturnText("Ari", letter, { option: "2", label: "Ouro", note: "after lunch" })).toBe("Ari answered L7: 2 Ouro — after lunch")
    expect(answerReturnText("Ari", letter, { option: "1", label: "Orca" })).toBe("Ari answered L7: 1 Orca")
  })

  it("is due once answered, until a try succeeds, waiting a doubling minute after each failure, at most an hour", () => {
    const letter = { from: { agent: "slugger", session: CHAT } } as Letter
    const answered: LetterEvent = { t: "answered", at: new Date(NOW).toISOString(), option: "1", via: "chat" } as LetterEvent
    const failed = (minutes: number): LetterEvent => ({ t: "returned", at: new Date(NOW + minutes * 60_000).toISOString(), to: "session", ok: false })
    expect(returnDue(letter, [], NOW)).toBe(false)
    expect(returnDue({ from: { agent: "slugger" } } as Letter, [answered], NOW)).toBe(false)
    expect(returnDue(letter, [answered], NOW)).toBe(true)
    expect(returnDue(letter, [answered, failed(0)], NOW + 59_999)).toBe(false)
    expect(returnDue(letter, [answered, failed(0)], NOW + 60_000)).toBe(true)
    expect(returnDue(letter, [answered, failed(0), failed(1)], NOW + 2 * 60_000)).toBe(false)
    expect(returnDue(letter, [answered, failed(0), failed(1)], NOW + 3 * 60_000)).toBe(true)
    const many = [answered, ...Array.from({ length: 12 }, (_, i) => failed(i))]
    expect(returnDue(letter, many, NOW + 11 * 60_000 + RETURN_BACKOFF_MAX_MS - 1)).toBe(false)
    expect(returnDue(letter, many, NOW + 11 * 60_000 + RETURN_BACKOFF_MAX_MS)).toBe(true)
    expect(returnDue(letter, [answered, failed(0), { t: "returned", at: new Date(NOW).toISOString(), to: "session", ok: true }], NOW + RETURN_BACKOFF_MAX_MS)).toBe(false)
    expect(returnDue(letter, [answered, { t: "returned", at: new Date(NOW).toISOString(), to: "waiter", ok: true }], NOW)).toBe(true)
  })
})

describe("returning an answer", () => {
  it("files the letter with the turn's session, and queues the person's answer there once it is recorded", async () => {
    const { writer, agentRoot } = await filed(CHAT)
    expect((await read(writer)).from).toEqual({ agent: "slugger", session: CHAT })
    expect(await writer.recordAnswer("slugger", answer(), "separate")).toMatchObject({ recorded: true })
    await vi.waitFor(() => expect(queued(agentRoot)).toHaveLength(1))
    expect(queued(agentRoot)).toEqual([expect.objectContaining({ from: "mailbox", content: "Ari answered L1: 2 Ouro — after lunch", friendId: "friend-bo", channel: "teams", key: "thread-1", packetId: "letter-returned:ltr_T1" })])
    expect((await events(writer)).filter((event) => event.t === "returned")).toEqual([{ t: "returned", at: new Date(NOW + 60_000).toISOString(), to: "session", ok: true }])
    // A replay of the same message is the same answer, and its return isn't tried again.
    expect(await writer.recordAnswer("slugger", answer(), "separate")).toMatchObject({ recorded: true, already: true })
    expect(await writer.returnAnswers()).toBe(0)
    expect(queued(agentRoot)).toHaveLength(1)
  })

  it("files a letter without a session from a caller that has none, or from the private runtime, and returns nothing", async () => {
    for (const session of [undefined, { friendId: "self", channel: "inner", key: "dialog" }, { ...CHAT, key: "../../x" }, { ...CHAT, key: "never-had-a-turn" }]) {
      const { writer, agentRoot } = await filed(session)
      expect((await read(writer)).from).toEqual({ agent: "slugger" })
      await writer.recordAnswer("slugger", answer(), "separate")
      expect((await events(writer)).some((event) => event.t === "returned")).toBe(false)
      expect(fs.existsSync(path.join(agentRoot, "state", "pending", "friend-bo"))).toBe(false)
    }
  })

  it("names the person as 'my person' when their friend record can't be read", async () => {
    let reads = 0
    const { writer, agentRoot } = await filed(CHAT, { listFriends: async () => { if (++reads > 1) throw new Error("locked"); return [friend("friend-ari", "Ari")] } })
    await writer.recordAnswer("slugger", answer({ text: "L1 1" }), "separate")
    await vi.waitFor(() => expect(queued(agentRoot)[0]?.content).toBe("my person answered L1: 1 Orca"))
  })

  it("names the person from the bundle's own friend records by default", async () => {
    const { writer, agentRoot } = await filed(CHAT, {
      listFriends: async (bundle) => {
        // The first read files the letter; the friend record is then written where the default reader looks.
        const stamp = "2026-01-01T00:00:00.000Z"
        fs.mkdirSync(path.join(bundle, "friends"), { recursive: true })
        fs.writeFileSync(path.join(bundle, "friends", "friend-ari.json"), JSON.stringify({
          id: "friend-ari", name: "Ari M", trustLevel: "family", externalIds: [{ provider: "local", externalId: "ari", linkedAt: stamp }],
          tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: stamp, updatedAt: stamp, schemaVersion: 1,
        }))
        return [friend("friend-ari", "Ari")]
      },
    })
    ;(writer as unknown as { deps: WriterDeps }).deps.listFriends = undefined
    await writer.recordAnswer("slugger", answer({ text: "L1 1" }), "separate")
    await vi.waitFor(() => expect(queued(agentRoot)[0]?.content).toBe("Ari M answered L1: 1 Orca"))
  })

  it("records a return that fails, and tries it again when its wait is over, until it succeeds", async () => {
    const { writer, clock, bundles, agentRoot } = await filed(CHAT)
    // A file where the session's folder belongs makes the write fail.
    fs.mkdirSync(path.join(agentRoot, "state", "pending", "friend-bo"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "state", "pending", "friend-bo", "teams"), "")
    expect(await writer.recordAnswer("slugger", answer(), "separate")).toMatchObject({ recorded: true })
    await vi.waitFor(async () => expect((await events(writer)).filter((event) => event.t === "returned")).toEqual([expect.objectContaining({ ok: false, detail: expect.any(String) })]))
    // Folders that aren't agents with letters are passed over.
    fs.mkdirSync(path.join(bundles, "notes"))
    fs.mkdirSync(path.join(bundles, "empty.ouro"))
    expect(await writer.returnAnswers()).toBe(0)
    clock.now += 60_000
    expect(await writer.returnAnswers()).toBe(1)
    fs.rmSync(path.join(agentRoot, "state", "pending", "friend-bo", "teams"))
    clock.now += 2 * 60_000
    expect(await writer.returnAnswers()).toBe(1)
    expect((await events(writer)).filter((event) => event.t === "returned").map((event) => (event as { ok: boolean }).ok)).toEqual([false, false, true])
    expect(queued(agentRoot)).toHaveLength(1)
    clock.now += RETURN_BACKOFF_MAX_MS
    expect(await writer.returnAnswers()).toBe(0)
  })
})

describe("when returning goes wrong", () => {
  const warned = (name: string) => vi.mocked(emitNervesEvent).mock.calls.filter(([event]) => event.event === name)

  it("keeps the recorded answer when even the failed try can't be written, and logs it", async () => {
    vi.mocked(emitNervesEvent).mockClear()
    const { writer, agentRoot } = await filed(CHAT)
    fs.mkdirSync(path.join(agentRoot, "state", "pending", "friend-bo"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "state", "pending", "friend-bo", "teams"), "")
    const { id } = await read(writer)
    const file = path.join(agentRoot, "state", "letters", `${id}.jsonl`)
    const store = (writer as unknown as { agents: Map<string, { store: { append: (id: string, event: LetterEvent) => void } }> }).agents.get("slugger")!.store
    const append = store.append.bind(store)
    store.append = (letterId, event) => { if (event.t === "returned") throw new Error("disk full"); append(letterId, event) }
    expect(await writer.recordAnswer("slugger", answer(), "separate")).toMatchObject({ recorded: true })
    await vi.waitFor(() => expect(warned("letters.return_step_failed")).toEqual([[expect.objectContaining({ meta: { code: "L1", reason: "disk full" } })]]))
    expect(fs.readFileSync(file, "utf8")).toContain('"t":"answered"')
  })

  it("passes over an agent whose letters don't read, and a bundles folder that is gone", async () => {
    vi.mocked(emitNervesEvent).mockClear()
    const { writer, bundles } = await filed(CHAT)
    fs.mkdirSync(path.join(bundles, "broken.ouro", "state", "letters", "ltr_X.jsonl"), { recursive: true })
    expect(await writer.returnAnswers()).toBe(0)
    expect(warned("letters.returns_failed")).toHaveLength(1)
    fs.rmSync(bundles, { recursive: true, force: true })
    expect(await writer.returnAnswers()).toBe(0)
    // Any other failure to list the bundles is the daemon's to log.
    fs.writeFileSync(bundles, "")
    await expect(writer.returnAnswers()).rejects.toThrow()
  })

  it("says where the answer goes when a second session refiles the letter", async () => {
    const { writer } = await filed(CHAT)
    const withKey = { kind: "letters.action" as const, agent: "slugger", action: "mailbox_send", input: { ...DECIDE, dedupeKey: "j" } }
    await answerLettersCommand(writer, { ...withKey, session: CHAT })
    expect(await answerLettersCommand(writer, withKey)).toMatchObject({ data: { message: expect.stringContaining("Its answer returns to the session that first filed it.") } })
    expect(await answerLettersCommand(writer, { ...withKey, session: CHAT })).toMatchObject({ data: { message: expect.not.stringContaining("first filed it") } })
  })
})
