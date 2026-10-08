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

import { awaitingToolDefinitions, resetAwaitToolDeps, setAwaitToolDeps } from "../../repertoire/tools-awaiting"

const fileAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "await_condition")!
const resolveAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "resolve_await")!

const CHOICES = ["keep waiting", "look for another release", "give up"]
const QUESTION = "The Chef torrent has been stuck at 75.9% with no peers. What should I do?"

function parse(result: unknown): Record<string, any> {
  return JSON.parse(result as string)
}

function doneFile(name: string): string {
  return fs.readFileSync(path.join(agentRoot, "awaiting", ".done", `${name}.md`), "utf-8")
}

const telegramCtx = { currentSession: { friendId: "ari", channel: "telegram", key: "telegram:ari", sessionPath: "" } } as any
const a2aCtx = {
  currentSession: { friendId: "peer", channel: "a2a", key: "conv-1", sessionPath: "" },
  relationshipAuthorization: { requestId: "req-1", authorizedContextScopes: [], advertisedToolNames: ["await_condition", "resolve_await"], authorizeTool: vi.fn() },
} as any

describe("resolve_await ask_owner", () => {
  const notifyOwner = vi.fn(async (_input: { noticeId: string; text: string }) => undefined)
  const a2a = vi.fn(async (_request: any) => ({ status: "delivered_now" as const, detail: "ok" }))

  beforeEach(() => {
    vi.clearAllMocks()
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ask-owner-"))
    resetAwaitToolDeps()
    setAwaitToolDeps({
      notifyOwner: () => notifyOwner,
      buildDeliveryDeps: () => ({ agentName: "sanctuary", queuePending: vi.fn(), deliverers: { a2a } }),
    })
  })
  afterEach(() => {
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

  it("closes the await as asked_owner, recording the question and choices, and messages the owner once", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "Chef S2 landed", cadence: "30m", alert: "telegram" }, telegramCtx)
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "no_peers stall", question: QUESTION, choices: CHOICES }, telegramCtx))

    expect(result).toMatchObject({ verdict: "ask_owner", asked: true, archived: expect.stringContaining("chef.md") })
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(false)
    const archived = doneFile("chef")
    expect(archived).toContain("status: asked_owner")
    expect(archived).toContain(`ask_question: ${QUESTION}`)
    expect(archived).toContain("ask_choices: keep waiting | look for another release | give up")
    expect(archived).toContain("resolution_observation: no_peers stall")

    expect(notifyOwner).toHaveBeenCalledTimes(1)
    expect(notifyOwner).toHaveBeenCalledWith({
      noticeId: "await-ask-owner:chef",
      text: `${QUESTION}\n\n- keep waiting\n- look for another release\n- give up`,
    })
    expect(a2a).not.toHaveBeenCalled()
  })

  it("refuses a second ask_owner, whether the await is closed or missing", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, telegramCtx)
    await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx)
    const again = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx))
    expect(again.error).toMatch(/already asked the owner/u)
    expect(notifyOwner).toHaveBeenCalledTimes(1)

    expect(parse(await resolveAwaitDef.handler({ name: "nope", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx)).error).toMatch(/not found/u)
  })

  it("refuses when the await is already closed some other way", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, telegramCtx)
    await resolveAwaitDef.handler({ name: "chef", verdict: "yes", observation: "o" }, telegramCtx)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx)).error).toMatch(/not found/u)
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
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, telegramCtx)
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", ...extra }, telegramCtx))
    expect(result.error).toMatch(message)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
    expect(notifyOwner).not.toHaveBeenCalled()
  })

  it("collapses whitespace in the question and choices so the archive stays one line each", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, telegramCtx)
    await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: "Stuck\n again?", choices: ["keep\nwaiting", "give up"] }, telegramCtx)
    expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ text: "Stuck again?\n\n- keep waiting\n- give up" }))
  })

  it("leaves the await pending, and retryable, when the owner message cannot be sent", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, telegramCtx)
    notifyOwner.mockRejectedValueOnce(new Error("telegram down"))
    const failed = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx))
    expect(failed.error).toMatch(/could not be sent.*telegram down/u)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
    notifyOwner.mockRejectedValueOnce("plain failure")
    expect(parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx)).error).toMatch(/plain failure/u)

    const retried = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx))
    expect(retried.asked).toBe(true)
    expect(notifyOwner.mock.calls.map((call) => call[0].noticeId)).toEqual(["await-ask-owner:chef", "await-ask-owner:chef", "await-ask-owner:chef"])
  })

  it("for an A2A-filed await, delivers the question through the A2A owner path (status: owner asked) and does not message the owner twice", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "Chef S2 landed", cadence: "30m" }, a2aCtx)
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, a2aCtx))

    expect(result).toMatchObject({ verdict: "ask_owner", asked: true, alert: { attempted: true, status: "delivered_now" } })
    expect(a2a).toHaveBeenCalledTimes(1)
    const request = a2a.mock.calls[0]![0]
    expect(request).toMatchObject({ friendId: "peer", channel: "a2a", key: "conv-1", requestId: "req-1", deliveryId: "await:chef:asked_owner" })
    expect(request.content).toContain("I have asked the owner")
    expect(request.content).toContain(QUESTION)
    expect(request.content).toContain("- give up")
    expect(notifyOwner).not.toHaveBeenCalled()
    expect(doneFile("chef")).toContain("status: asked_owner")
  })

  it("for an A2A-filed await, falls back to the direct owner message when the A2A path did not deliver", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, a2aCtx)
    a2a.mockResolvedValueOnce({ status: "failed" as any, detail: "boom" })
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, a2aCtx))
    expect(result.asked).toBe(true)
    expect(notifyOwner).toHaveBeenCalledWith({ noticeId: "await-ask-owner:chef", text: expect.stringContaining(QUESTION) })
  })

  it("for an A2A-filed await, leaves it pending when neither path delivers", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, a2aCtx)
    a2a.mockResolvedValueOnce({ status: "failed" as any, detail: "boom" })
    notifyOwner.mockRejectedValueOnce(new Error("telegram down"))
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, a2aCtx))
    expect(result.error).toMatch(/could not be sent/u)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
  })

  it.each([new Error("a2a exploded"), "plain a2a failure"])("for an A2A-filed await, falls back to the direct owner message when the A2A path throws (%#)", async (failure) => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, a2aCtx)
    alertSpy.throwOnce = failure
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, a2aCtx))
    expect(result.asked).toBe(true)
    expect(notifyOwner).toHaveBeenCalledTimes(1)
  })

  it("reports a skipped A2A delivery and still asks the owner directly", async () => {
    const noFriend = { currentSession: { friendId: "", channel: "a2a", key: "conv-1", sessionPath: "" } } as any
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m" }, noFriend)
    const result = parse(await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, noFriend))
    expect(result).toMatchObject({ asked: true, alert: { attempted: false, status: null, skipped: "no friend id" } })
    expect(notifyOwner).toHaveBeenCalledTimes(1)
  })

  it("by default sends through the Butler's Telegram owner notice", async () => {
    resetAwaitToolDeps()
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, telegramCtx)
    await resolveAwaitDef.handler({ name: "chef", verdict: "ask_owner", observation: "o", question: QUESTION, choices: CHOICES }, telegramCtx)
    expect(mockSendTelegramOwnerNotice).toHaveBeenCalledWith("sanctuary", expect.objectContaining({ noticeId: "await-ask-owner:chef", text: expect.stringContaining(QUESTION) }))
  })

  it("leaves yes and no unchanged", async () => {
    await fileAwaitDef.handler({ name: "chef", condition: "c", cadence: "30m", alert: "telegram" }, telegramCtx)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", verdict: "no", observation: "still stalled" }, telegramCtx))).toEqual({ verdict: "no", recorded: true })
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef.md"))).toBe(true)
    expect(parse(await resolveAwaitDef.handler({ name: "chef", verdict: "maybe", observation: "x" }, telegramCtx)).error).toMatch(/"yes", "no", or "ask_owner"/u)
    expect(notifyOwner).not.toHaveBeenCalled()
  })

  it("scenario: a tick sees a confirmed no_peers stall, asks Ari, and the await closes", async () => {
    const mediaQueue = () => ({ downloads: [{ title: "Chef S2", percent: 75.9, stall: { kind: "no_peers", days: 4 } }] })
    await fileAwaitDef.handler({ name: "chef_show_s2_landed", condition: "Chef season 2 is in the library", cadence: "30m", alert: "telegram" }, telegramCtx)

    // The tick: look at the queue, and because the stall is confirmed, put the decision to the owner.
    const stall = mediaQueue().downloads[0]!.stall
    expect(stall.kind).toBe("no_peers")
    const result = parse(await resolveAwaitDef.handler({
      name: "chef_show_s2_landed",
      verdict: "ask_owner",
      observation: "Chef S2 stalled at 75.9% with no peers for 4 days",
      question: "Chef S2 has been stuck at 75.9% with no peers for 4 days.",
      choices: ["keep waiting", "look for another release", "give up"],
    }, telegramCtx))

    expect(result.asked).toBe(true)
    expect(notifyOwner).toHaveBeenCalledTimes(1)
    const sent = notifyOwner.mock.calls[0]![0]
    expect(sent.text).toBe("Chef S2 has been stuck at 75.9% with no peers for 4 days.\n\n- keep waiting\n- look for another release\n- give up")
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef_show_s2_landed.md"))).toBe(false)
    expect(doneFile("chef_show_s2_landed")).toContain("status: asked_owner")
  })
})
