import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

let agentRoot = ""
vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => agentRoot,
  getAgentName: () => "sanctuary",
}))

const alertSpy = vi.hoisted(() => ({ throwOnce: undefined as unknown }))
vi.mock("../../heart/awaiting/await-alert", async (original) => {
  const actual = await original<typeof import("../../heart/awaiting/await-alert")>()
  return {
    ...actual,
    deliverAwaitAlert: async (...args: Parameters<typeof actual.deliverAwaitAlert>) => {
      if (alertSpy.throwOnce !== undefined) {
        const failure = alertSpy.throwOnce
        alertSpy.throwOnce = undefined
        throw failure
      }
      return actual.deliverAwaitAlert(...args)
    },
  }
})

const mockSendTelegramOwnerNotice = vi.hoisted(() => vi.fn())
vi.mock("../../senses/telegram", () => ({ sendTelegramOwnerNotice: mockSendTelegramOwnerNotice }))

import { FileFriendStore } from "@ouro.bot/friends"
import { readVerifiedPendingObligations } from "../../arc/obligations"
import { awaitingToolDefinitions, readOwnerAskForAwait, resetAwaitToolDeps, setAwaitToolDeps } from "../../repertoire/tools-awaiting"

const fileAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "await_condition")!
const resolveAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "resolve_await")!

const CHOICES = ["keep waiting", "look for another release", "give up"]
const QUESTION = "The Chef torrent has been stuck at 75.9% with no peers. What should I do?"
const ASK = { verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }
const LIST = "\n\n- keep waiting\n- look for another release\n- give up"

function parse(result: unknown): Record<string, any> {
  return JSON.parse(result as string)
}

function doneFile(name: string): string {
  return fs.readFileSync(path.join(agentRoot, "awaiting", ".done", `${name}.md`), "utf-8")
}

function createdAt(name: string): string {
  return /created_at: (\S+)/u.exec(fs.readFileSync(path.join(agentRoot, "awaiting", `${name}.md`), "utf-8"))![1]!
}

async function putFriend(id: string, name: string, trustLevel: string, capabilityProfileId?: string, admissionState = "active"): Promise<void> {
  await new FileFriendStore(path.join(agentRoot, "friends")).put(id, { id, name, trustLevel, capabilityProfileId, admissionState, externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", schemaVersion: 1 } as any)
}

const ownerCtx = { currentSession: { friendId: "ari", channel: "telegram", key: "telegram:ari", sessionPath: "" } } as any
const requestCtx = (friendId: string, channel: string, key: string, requestId: string) => ({
  currentSession: { friendId, channel, key, sessionPath: "" },
  relationshipAuthorization: { requestId, authorizedContextScopes: [], advertisedToolNames: ["await_condition", "resolve_await"], authorizeTool: vi.fn() },
}) as any
const a2aCtx = requestCtx("peer", "a2a", "conv-1", "req-1")
const kimCtx = requestCtx("kim", "telegram", "telegram:kim", "req-kim")

describe("resolve_await ask_owner", () => {
  const notifyOwner = vi.fn(async (_input: { noticeId: string; text: string }) => undefined)
  const a2a = vi.fn(async (_request: any): Promise<{ status: any; detail: string }> => ({ status: "delivered_now", detail: "ok" }))
  const telegram = vi.fn(async (_request: any): Promise<{ status: any; detail: string }> => ({ status: "delivered_now", detail: "ok" }))

  beforeEach(async () => {
    vi.clearAllMocks()
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ask-owner-"))
    resetAwaitToolDeps()
    mockSendTelegramOwnerNotice.mockReset()
    setAwaitToolDeps({
      notifyOwner: () => notifyOwner,
      buildDeliveryDeps: () => ({ agentName: "sanctuary", queuePending: vi.fn(), deliverers: { a2a, telegram } }),
    })
    await putFriend("ari", "Ari", "family", "sanctuary-owner")
    await putFriend("peer", "Claude Code", "family")
    await putFriend("kim", "Kim", "friend", "sanctuary-household")
  })
  afterEach(() => {
    vi.useRealTimers()
    resetAwaitToolDeps()
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("declares ask_owner with a question and two to four choices, and says when to use it", () => {
    const fn = resolveAwaitDef.tool.function
    const props = (fn.parameters as any).properties
    expect(props.verdict.enum).toEqual(["yes", "no", "ask_owner"])
    expect(props.question.type).toBe("string")
    expect(props.choices).toMatchObject({ type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 })
    expect((fn.parameters as any).required).toEqual(["name", "verdict", "observation"])
    expect(fn.description).toMatch(/ask_owner/u)
    expect(fn.description).toMatch(/confirmed dead download/u)
    expect(fn.description).toMatch(/ask_owner for "not yet"/u)
  })

  it("closes the await as asked_owner, recording the question and choices, and messages the owner once, keyed to this await instance", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "Chef S2 landed", cadence: "30m", alert: "telegram" }, ownerCtx)
    const created = createdAt("chef")
    const result = parse(await resolveAwaitDef.handler({ name: "chef", ...ASK, observation: "no_peers stall" }, ownerCtx))

    expect(result).toMatchObject({ verdict: "ask_owner", asked: true, archived: expect.stringContaining("chef.md") })
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(false)
    const archived = doneFile("chef")
    expect(archived).toContain("status: asked_owner")
    expect(archived).toContain(`ask_question: ${QUESTION}`)
    expect(archived).toContain("ask_choices: keep waiting | look for another release | give up")
    expect(archived).toContain("resolution_observation: no_peers stall")

    expect(notifyOwner).toHaveBeenCalledTimes(1)
    expect(notifyOwner).toHaveBeenCalledWith({ noticeId: `await:chef:asked_owner:${created}`, text: `${QUESTION}${LIST}` })
    expect(a2a).not.toHaveBeenCalled()
    expect(telegram).not.toHaveBeenCalled()
  })

  it("asks again for a refiled await that reuses the name, because each instance has its own notice id", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"))
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)
    vi.setSystemTime(new Date("2026-10-08T11:00:00.000Z"))
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)).asked).toBe(true)

    const ids = notifyOwner.mock.calls.map((call) => call[0].noticeId)
    expect(ids).toEqual(["await:chef:asked_owner:2026-10-08T10:00:00.000Z", "await:chef:asked_owner:2026-10-08T11:00:00.000Z"])
  })

  it("refuses a second ask_owner, whether the await is closed or missing", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)).error).toMatch(/already asked the owner/u)
    expect(notifyOwner).toHaveBeenCalledTimes(1)
    expect(parse(await resolveAwaitDef.handler({ name: "nope", ...ASK }, ownerCtx)).error).toMatch(/not found/u)
  })

  it("sends once when two ask_owner calls race on the same await", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    const [first, second] = await Promise.all([
      resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx),
      resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx),
    ]).then((results) => results.map(parse))
    expect([first!.asked, second!.asked].filter(Boolean)).toHaveLength(1)
    expect([first!.error, second!.error].filter(Boolean)[0]).toMatch(/already being asked/u)
    expect(notifyOwner).toHaveBeenCalledTimes(1)
  })

  it("refuses when the await is already closed some other way", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    await resolveAwaitDef.handler({ name: "chef", verdict: "yes", observation: "o" }, ownerCtx)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)).error).toMatch(/not found/u)
    expect(notifyOwner).not.toHaveBeenCalled()
  })

  it.each([
    ["no question", { choices: CHOICES }, /question is required/u],
    ["blank question", { question: "  ", choices: CHOICES }, /question is required/u],
    ["no choices", { question: QUESTION }, /2 to 4 choices/u],
    ["one choice", { question: QUESTION, choices: ["a"] }, /2 to 4 choices/u],
    ["five choices", { question: QUESTION, choices: ["a", "b", "c", "d", "e"] }, /2 to 4 choices/u],
    ["blank choice", { question: QUESTION, choices: ["a", " "] }, /non-empty/u],
    ["non-string choice", { question: QUESTION, choices: ["a", 3] }, /non-empty/u],
    ["pipe in choice", { question: QUESTION, choices: ["a", "b|c"] }, /must not contain/u],
  ])("rejects %s and leaves the await pending", async (_label, extra, message) => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", ...extra }, ownerCtx))
    expect(result.error).toMatch(message)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
    expect(notifyOwner).not.toHaveBeenCalled()
  })

  it("collapses whitespace in the question and choices so the archive stays one line each", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: "Stuck\n again?", choices: ["keep\nwaiting", "give up"] }, ownerCtx)
    expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ text: "Stuck again?\n\n- keep waiting\n- give up" }))
  })

  it("leaves the await pending, and retryable, when the owner message cannot be sent", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    notifyOwner.mockRejectedValueOnce(new Error("telegram down"))
    expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)).error).toMatch(/could not be sent.*telegram down/u)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
    notifyOwner.mockRejectedValueOnce("plain failure")
    expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)).error).toMatch(/plain failure/u)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)).asked).toBe(true)
    expect(new Set(notifyOwner.mock.calls.map((call) => call[0].noticeId)).size).toBe(1)
  })

  describe("A2A-filed", () => {
    it("delivers through the A2A owner path under the await's notice id, with the plain question, and does not message the owner twice", async () => {
      await fileAwaitDef.handler({ name: "chef", condition: "Chef S2 landed", cadence: "30m" }, a2aCtx)
      const created = createdAt("chef")
      const result = parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, a2aCtx))

      expect(result).toMatchObject({ verdict: "ask_owner", asked: true, alert: { attempted: true, status: "delivered_now" } })
      expect(a2a).toHaveBeenCalledTimes(1)
      expect(a2a.mock.calls[0]![0]).toMatchObject({ friendId: "peer", channel: "a2a", key: "conv-1", requestId: "req-1", deliveryId: `await:chef:asked_owner:${created}`, noticeKind: "asked_owner", content: `${QUESTION}${LIST}` })
      expect(notifyOwner).not.toHaveBeenCalled()
      expect(doneFile("chef")).toContain("status: asked_owner")
      expect(readVerifiedPendingObligations(agentRoot)).toHaveLength(0)
    })

    it.each([["failed"], ["blocked"]])("falls back to the direct owner message under the same notice id when the A2A path is %s", async (status) => {
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, a2aCtx)
      const created = createdAt("chef")
      a2a.mockResolvedValueOnce({ status, detail: "boom" })
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, a2aCtx)).asked).toBe(true)
      expect(notifyOwner).toHaveBeenCalledWith({ noticeId: `await:chef:asked_owner:${created}`, text: `${QUESTION}${LIST}\n\n(about the request from Claude Code)` })
    })

    it("does not fall back when the A2A path queued the message", async () => {
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, a2aCtx)
      a2a.mockResolvedValueOnce({ status: "unavailable", detail: "later" })
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, a2aCtx))).toMatchObject({ asked: true, alert: { status: "queued_for_later" } })
      expect(notifyOwner).not.toHaveBeenCalled()
    })

    it.each([new Error("a2a exploded"), "plain a2a failure"])("falls back to the direct owner message when the A2A path throws (%#)", async (failure) => {
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, a2aCtx)
      alertSpy.throwOnce = failure
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, a2aCtx)).asked).toBe(true)
      expect(notifyOwner).toHaveBeenCalledTimes(1)
    })

    it("leaves it pending when neither path delivers", async () => {
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, a2aCtx)
      a2a.mockResolvedValueOnce({ status: "failed", detail: "boom" })
      notifyOwner.mockRejectedValueOnce(new Error("telegram down"))
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, a2aCtx)).error).toMatch(/could not be sent/u)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
    })

    it("names a peer that is not in the friend store generically", async () => {
      const stranger = requestCtx("stranger", "a2a", "conv-9", "req-9")
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, stranger)
      a2a.mockResolvedValueOnce({ status: "failed", detail: "boom" })
      await resolveAwaitDef.handler({ name: "chef", ...ASK }, stranger)
      expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("(about the request from a connected agent)") }))
    })

    it("reports a skipped A2A delivery and still asks the owner directly", async () => {
      const noFriend = { currentSession: { friendId: "", channel: "a2a", key: "conv-1", sessionPath: "" } } as any
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, noFriend)
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, noFriend))).toMatchObject({ asked: true, alert: { attempted: false, status: null, skipped: "no friend id" } })
      expect(notifyOwner).toHaveBeenCalledTimes(1)
    })
  })

  describe("friend-filed", () => {
    it("says whose request it is when the owner did not file it, and tells the filing friend the owner was asked", async () => {
      await fileAwaitDef.handler({ name: "chef", condition: "Chef S2 landed", cadence: "30m", alert: "telegram" }, kimCtx)
      const created = createdAt("chef")
      const result = parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, kimCtx))

      expect(result).toMatchObject({ asked: true, filerNotice: { attempted: true, status: "delivered_now" } })
      expect(notifyOwner).toHaveBeenCalledWith({ noticeId: `await:chef:asked_owner:${created}`, text: `${QUESTION}${LIST}\n\n(about the request from Kim)` })
      expect(telegram).toHaveBeenCalledTimes(1)
      expect(telegram.mock.calls[0]![0]).toMatchObject({ friendId: "kim", key: "telegram:kim", deliveryId: `await:chef:asked_owner:${created}:filer`, content: 'About "Chef S2 landed": I have asked the owner how to proceed and will let you know what they decide.' })
      expect(telegram.mock.calls[0]![0].content).not.toContain(QUESTION)
      expect(readVerifiedPendingObligations(agentRoot)).toHaveLength(0)
    })

    it("keeps the obligation open when the filing friend could not be told", async () => {
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, kimCtx)
      telegram.mockResolvedValueOnce({ status: "failed", detail: "boom" })
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, kimCtx))).toMatchObject({ asked: true, filerNotice: { status: "failed" } })
      expect(fs.existsSync(path.join(agentRoot, "awaiting", ".done", "chef.md"))).toBe(true)
      expect(readVerifiedPendingObligations(agentRoot)).toHaveLength(1)
    })

    it.each([new Error("down"), "plain down"])("keeps the obligation open when telling the filing friend throws (%#)", async (failure) => {
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, kimCtx)
      alertSpy.throwOnce = failure
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, kimCtx))).toMatchObject({ asked: true, filerNotice: null })
      expect(readVerifiedPendingObligations(agentRoot)).toHaveLength(1)
    })

    it("names the await itself when its condition is missing", async () => {
      fs.mkdirSync(path.join(agentRoot, "awaiting"), { recursive: true })
      fs.writeFileSync(path.join(agentRoot, "awaiting", "bare.md"), "---\nstatus: pending\nalert: telegram\nfiled_from: telegram\nfiled_for_friend_id: kim\nfiled_from_key: telegram:kim\ncreated_at: 2026-10-08T00:00:00.000Z\n---\n")
      await resolveAwaitDef.handler({ name: "bare", ...ASK }, undefined)
      expect(telegram.mock.calls[0]![0].content).toBe('About "bare": I have asked the owner how to proceed and will let you know what they decide.')
    })

    it("names an unknown filer generically", async () => {
      const stranger = requestCtx("stranger", "telegram", "telegram:s", "req-s")
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, stranger)
      await resolveAwaitDef.handler({ name: "chef", ...ASK }, stranger)
      expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("(about the request from a friend)") }))
    })

    it("sends a plain, unattributed message and no friend notice when the owner filed it", async () => {
      await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
      expect(parse(await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx))).not.toHaveProperty("filerNotice")
      expect(notifyOwner.mock.calls[0]![0].text).toBe(`${QUESTION}${LIST}`)
      expect(telegram).not.toHaveBeenCalled()
    })
  })

  describe("per-requester limit", () => {
    const askOnce = async (name: string, ctx: any) => {
      await fileAwaitDef.handler({ name, condition: "c", cadence: "30m", alert: "telegram" }, ctx)
      return parse(await resolveAwaitDef.handler({ name, ...ASK }, ctx))
    }

    it("allows three asks per requester per day, then tells the Butler to resolve no instead, without sending", async () => {
      for (const name of ["a", "b", "c"]) expect((await askOnce(name, kimCtx)).asked).toBe(true)
      await fileAwaitDef.handler({ name: "d", condition: "c", cadence: "30m", alert: "telegram" }, kimCtx)
      const refused = parse(await resolveAwaitDef.handler({ name: "d", ...ASK }, kimCtx))
      expect(refused.error).toMatch(/limit reached.*3 times in the last day/u)
      expect(refused.error).toMatch(/do not retry ask_owner, resolve with verdict 'no' with an observation/u)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "d.md"))).toBe(true)
      expect(notifyOwner).toHaveBeenCalledTimes(3)

      // The refused await stays pending and the tick can keep polling with 'no'.
      expect(parse(await resolveAwaitDef.handler({ name: "d", verdict: "no", observation: "still stalled" }, kimCtx))).toEqual({ verdict: "no", recorded: true })
      expect(notifyOwner).toHaveBeenCalledTimes(3)
    })

    it("counts asks by a requester that reuses one await name, even though the archive is overwritten", async () => {
      for (let round = 0; round < 3; round += 1) expect((await askOnce("same", kimCtx)).asked).toBe(true)
      await fileAwaitDef.handler({ name: "same", condition: "c", cadence: "30m", alert: "telegram" }, kimCtx)
      expect(parse(await resolveAwaitDef.handler({ name: "same", ...ASK }, kimCtx)).error).toMatch(/limit reached/u)
      expect(notifyOwner).toHaveBeenCalledTimes(3)
    })

    it("counts other requesters separately", async () => {
      for (const name of ["a", "b", "c"]) await askOnce(name, kimCtx)
      expect((await askOnce("e", requestCtx("peer", "a2a", "conv-1", "req-p"))).asked).toBe(true)
    })

    it("never limits the owner's own awaits", async () => {
      for (const name of ["a", "b", "c", "d", "e"]) expect((await askOnce(name, ownerCtx)).asked).toBe(true)
      expect(notifyOwner).toHaveBeenCalledTimes(5)
    })

    it("does not treat an inactive owner record as the owner", async () => {
      await putFriend("old", "Old Ari", "family", "sanctuary-owner", "revoked")
      const oldCtx = { currentSession: { friendId: "old", channel: "telegram", key: "telegram:old", sessionPath: "" } } as any
      for (const name of ["a", "b", "c"]) await askOnce(name, oldCtx)
      await fileAwaitDef.handler({ name: "d", condition: "c", cadence: "30m", alert: "telegram" }, oldCtx)
      expect(parse(await resolveAwaitDef.handler({ name: "d", ...ASK }, oldCtx)).error).toMatch(/limit reached/u)
    })

    it("treats an unreadable friend store as an unknown filer instead of failing the ask", async () => {
      fs.rmSync(path.join(agentRoot, "friends"), { recursive: true, force: true })
      fs.writeFileSync(path.join(agentRoot, "friends"), "not a directory")
      const result = await askOnce("a", ownerCtx)
      expect(result.asked).toBe(true)
      expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("(about the request from a friend)") }))
    })

    it("stops counting asks older than a day", async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"))
      for (const name of ["a", "b", "c"]) await askOnce(name, kimCtx)
      vi.setSystemTime(new Date("2026-10-09T00:00:01.000Z"))
      expect((await askOnce("d", kimCtx)).asked).toBe(true)
    })

    it("caps asks on behalf of everyone who is not the owner, across requesters, but not the owner's own", async () => {
      const ledger = path.join(agentRoot, "awaiting", ".asks.jsonl")
      fs.mkdirSync(path.dirname(ledger), { recursive: true })
      const at = new Date().toISOString()
      const lines = ["a", "b", "c", "d", "e", "f"].map((filer) => JSON.stringify({ filer, owner: false, name: filer, at }))
      fs.writeFileSync(ledger, `${lines.join("\n")}\n`)
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "30m", alert: "telegram" }, kimCtx)
      expect(parse(await resolveAwaitDef.handler({ name: "x", ...ASK }, kimCtx)).error).toMatch(/limit reached.*6 times today on behalf of other requesters/u)
      expect(notifyOwner).not.toHaveBeenCalled()
      expect((await askOnce("own", ownerCtx)).asked).toBe(true)
      expect(fs.readFileSync(ledger, "utf8")).toContain('"owner":true')
    })

    it("does not count older owner asks or older entries without an owner flag against the cap", async () => {
      const ledger = path.join(agentRoot, "awaiting", ".asks.jsonl")
      fs.mkdirSync(path.dirname(ledger), { recursive: true })
      const at = new Date().toISOString()
      const lines = ["a", "b", "c", "d", "e", "f"].map((filer, index) => JSON.stringify(index % 2 ? { filer, owner: true, name: filer, at } : { filer, name: filer, at }))
      fs.writeFileSync(ledger, `${lines.join("\n")}\n`)
      expect((await askOnce("fresh", kimCtx)).asked).toBe(true)
    })

    it("ignores unreadable ledger lines and other closures", async () => {
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "30m", alert: "telegram" }, kimCtx)
      await resolveAwaitDef.handler({ name: "x", verdict: "yes", observation: "o" }, kimCtx)
      fs.appendFileSync(path.join(agentRoot, "awaiting", ".asks.jsonl"), "not json\n{\"filer\":\"kim\"}\n{\"owner\":true,\"at\":\"2026-10-08T00:00:00.000Z\"}\n")
      expect((await askOnce("y", kimCtx)).asked).toBe(true)
    })
  })

  it("by default sends through the Butler's Telegram owner notice", async () => {
    resetAwaitToolDeps()
    setAwaitToolDeps({ buildDeliveryDeps: () => ({ agentName: "sanctuary", queuePending: vi.fn(), deliverers: { telegram } }) })
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)
    expect(mockSendTelegramOwnerNotice).toHaveBeenCalledWith("sanctuary", expect.objectContaining({ noticeId: expect.stringMatching(/^await:chef:asked_owner:/u), text: expect.stringContaining(QUESTION) }))
  })

  it("reads the ask for this await instance from the ledger, and not an earlier use of the name", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    const created = createdAt("chef")
    expect(readOwnerAskForAwait(agentRoot, "chef", created)).toBeNull()
    await resolveAwaitDef.handler({ name: "chef", ...ASK }, ownerCtx)
    const ask = readOwnerAskForAwait(agentRoot, "chef", created)
    expect(ask).toMatchObject({ question: QUESTION })
    expect(readOwnerAskForAwait(agentRoot, "other", created)).toBeNull()
    expect(readOwnerAskForAwait(agentRoot, "chef", new Date(Date.parse(ask!.at) + 1000).toISOString())).toBeNull()
    expect(readOwnerAskForAwait(agentRoot, "chef", null)).toMatchObject({ question: QUESTION })
  })

  it("skips unreadable ledger lines and keeps the latest ask when reading", () => {
    fs.mkdirSync(path.join(agentRoot, "awaiting"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "awaiting", ".asks.jsonl"), ["bad", JSON.stringify({ name: "x", at: "2026-10-08T02:00:00.000Z" }), JSON.stringify({ name: "x", at: "2026-10-08T01:00:00.000Z", question: "old" }), JSON.stringify({ name: "x", at: "nope" })].join("\n"))
    expect(readOwnerAskForAwait(agentRoot, "x", "2026-10-08T00:00:00.000Z")).toEqual({ at: "2026-10-08T02:00:00.000Z", question: null })
    expect(readOwnerAskForAwait(agentRoot, "missing", null)).toBeNull()
  })

  it("leaves yes and no unchanged", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, ownerCtx)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", verdict: "no", observation: "still stalled" }, ownerCtx))).toEqual({ verdict: "no", recorded: true })
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", verdict: "maybe", observation: "x" }, ownerCtx)).error).toMatch(/"yes", "no", or "ask_owner"/u)
    expect(notifyOwner).not.toHaveBeenCalled()
  })

  it("scenario: a tick sees a confirmed no_peers stall, asks Ari, and the await closes", async () => {
    const mediaQueue = () => ({ downloads: [{ title: "Chef S2", percent: 75.9, stall: { kind: "no_peers", days: 4 } }] })
    await fileAwaitDef.handler({ name: "chef_show_s2_landed", condition: "Chef season 2 is in the library", cadence: "30m", alert: "telegram" }, ownerCtx)

    expect(mediaQueue().downloads[0]!.stall.kind).toBe("no_peers")
    const result = parse(await resolveAwaitDef.handler({
      name: "chef_show_s2_landed",
      verdict: "ask_owner",
      observation: "Chef S2 stalled at 75.9% with no peers for 4 days",
      question: "Chef S2 has been stuck at 75.9% with no peers for 4 days.",
      choices: ["keep waiting", "look for another release", "give up"],
    }, ownerCtx))

    expect(result.asked).toBe(true)
    expect(notifyOwner).toHaveBeenCalledTimes(1)
    expect(notifyOwner.mock.calls[0]![0].text).toBe(`Chef S2 has been stuck at 75.9% with no peers for 4 days.${LIST}`)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef_show_s2_landed.md"))).toBe(false)
    expect(doneFile("chef_show_s2_landed")).toContain("status: asked_owner")
  })
})
