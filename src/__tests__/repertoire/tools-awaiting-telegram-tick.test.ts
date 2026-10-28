import * as fs from "node:fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

let agentRoot = ""
vi.mock("../../heart/identity", () => ({ getAgentRoot: () => agentRoot, getAgentName: () => "sanctuary" }))

// The one-shot Telegram send dedupes on the request and content, as the real sense's effect key does.
const telegram = vi.hoisted(() => ({ seen: new Set<string>(), sent: [] as Array<{ friendId: string; key: string; requestId?: string; content: string }>, status: "delivered_now" as string }))
vi.mock("../../senses/telegram", () => ({
  sendTelegramAwaitFollowUp: async (_agent: string, request: { friendId: string; key: string; requestId?: string; content: string }) => {
    if (telegram.status !== "delivered_now") return { status: telegram.status, detail: "telegram refused" }
    const id = `${request.requestId}:${request.content}`
    if (!telegram.seen.has(id)) {
      telegram.seen.add(id)
      telegram.sent.push(request)
    }
    return { status: "delivered_now", detail: "sent" }
  },
}))

vi.mock("../../mind/pending", async (original) => ({
  ...await original<object>(),
  getPrivateRuntimePendingDir: () => path.join(agentRoot, "state", "pending", "self", "inner", "dialog"),
}))

import { awaitingToolDefinitions, resetAwaitToolDeps } from "../../repertoire/tools-awaiting"

const fileAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "await_condition")!
const resolveAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "resolve_await")!

const OWNER_CHAT = { friendId: "owner", channel: "telegram", key: "telegram:tg_owner", sessionPath: "" }
const NAME = "bookshelf_config_fix"

function parse(result: unknown): Record<string, any> {
  return JSON.parse(result as string)
}

function pendingDir(): string {
  return path.join(agentRoot, "state", "pending", "self", "inner", "dialog")
}

describe("a Telegram watch resolved on its own private tick (2026-10-28: the book-app watch never told Ari and never closed)", () => {
  beforeEach(async () => {
    telegram.seen.clear()
    telegram.sent.length = 0
    telegram.status = "delivered_now"
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-tick-"))
    resetAwaitToolDeps()
    // Filed from the owner's Telegram chat, so the await is bound to that request.
    await fileAwaitDef.handler({ name: NAME, condition: "the book app's log is clean", cadence: "2h" }, { currentSession: OWNER_CHAT } as any)
    const filed = fs.readFileSync(path.join(agentRoot, "awaiting", `${NAME}.md`), "utf8")
    const withRequest = filed.replace(/^request_id: .*$/mu, "request_id: telegram-inbound:req-1")
    fs.writeFileSync(path.join(agentRoot, "awaiting", `${NAME}.md`), withRequest)
  })
  afterEach(() => {
    resetAwaitToolDeps()
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("tells the owner once in the chat that asked, archives the watch, and a second tick finds nothing left", async () => {
    // The private tick has no resident Telegram sense, so nothing injected a Telegram deliverer.
    const result = parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "the log is clean" }))

    expect(result).toMatchObject({ verdict: "yes", alert: { status: "delivered_now" } })
    expect(result.archived).toEqual(expect.stringContaining(`${NAME}.md`))
    expect(telegram.sent).toHaveLength(1)
    expect(telegram.sent[0]).toMatchObject({ friendId: "owner", key: "telegram:tg_owner", requestId: "telegram-inbound:req-1" })
    expect(fs.existsSync(path.join(agentRoot, "awaiting", `${NAME}.md`))).toBe(false)
    expect(fs.existsSync(pendingDir()) ? fs.readdirSync(pendingDir()) : []).toEqual([])

    const again = parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "the log is clean" }))
    expect(again.error).toMatch(/not found/u)
    expect(telegram.sent).toHaveLength(1)
  })

  it("tells the owner in the words the agent wrote for them, so the next turn does not disown the alert as unchecked (2026-10-28)", async () => {
    const message = "I just checked the book app's log: the download and indexer errors are gone, so it's ready to use."
    parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "the log is clean", message: `  ${message}  ` }))

    expect(telegram.sent.map((sent) => sent.content)).toEqual([message])
  })

  it("resends the first words after a refused send, because the Telegram effect key is the watch name and new words would be refused as a reused key", async () => {
    telegram.status = "blocked"
    parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "the log is clean", message: "first words" }))
    telegram.status = "delivered_now"
    const result = parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "still clean", message: "second words" }))

    expect(result.archived).toEqual(expect.stringContaining(`${NAME}.md`))
    expect(telegram.sent.map((sent) => sent.content)).toEqual(["first words"])
    expect(fs.existsSync(path.join(agentRoot, "state", "await-alerts", `${NAME}.json`))).toBe(false)
  })

  it("falls back to the condition and observation when the agent wrote no message", async () => {
    parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "the log is clean", message: "   " }))

    expect(telegram.sent.map((sent) => sent.content)).toEqual(["the book app's log is clean — ready. the log is clean"])
  })

  it("still queues the alert of a Telegram watch that no request is bound to, as before", async () => {
    const file = path.join(agentRoot, "awaiting", `${NAME}.md`)
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^request_id: .*$/mu, "request_id: null"))
    const result = parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "the log is clean" }))

    expect(result).toMatchObject({ verdict: "yes", alert: { status: "queued_for_later" } })
    expect(result.archived).toEqual(expect.stringContaining(`${NAME}.md`))
    expect(telegram.sent).toHaveLength(0)
    expect(fs.readdirSync(pendingDir())).toHaveLength(1)
  })
  it("keeps the watch open for the next tick when Telegram refuses the send", async () => {
    telegram.status = "blocked"
    const result = parse(await resolveAwaitDef.handler({ name: NAME, verdict: "yes", observation: "the log is clean" }))

    expect(result).toMatchObject({ verdict: "yes", archived: null, alert: { status: "blocked" } })
    expect(fs.existsSync(path.join(agentRoot, "awaiting", `${NAME}.md`))).toBe(true)
  })
})
