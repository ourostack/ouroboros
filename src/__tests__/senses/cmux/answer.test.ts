import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readStewardPolicy, updateStewardPolicy } from "../../../heart/steward-policy"
import { answerOnce, CMUX_GRANT_ACTION, CMUX_GRANT_KEY, cmuxStateDir, feedItemStatus, judgeFeedItem, recordDecision, type AnswerContext } from "../../../senses/cmux/answer"
import type { CmuxPendingFeedItem } from "../../../senses/cmux/attention"
import { addCase, appendDecision, cmuxCasebookPath, cmuxDecisionLogPath, readDecisions, storeShape } from "../../../senses/cmux/casebook"
import type { CmuxClient } from "../../../senses/cmux/client"

const NOW = Date.parse("2026-10-10T20:00:00.000Z")
let base = ""
let repo = ""
let agentRoot = ""
let version: string | null = "0.65.0"

/**
 * A fake cmux Feed: `pending` items are waiting; a `feed.permission.reply` resolves the item the way
 * cmux does (or as `resolveAs` says, to simulate the human or a timeout winning), and an unfiltered
 * `feed.list` shows status and decision.
 */
let feed: Array<Record<string, unknown>> = []
let calls: Array<{ method: string; params: Record<string, unknown> }> = []
let resolveAs: ((entry: Record<string, unknown>) => void) | null = null
let failOn: { method: string; pendingOnly?: boolean } | null = null

const client: CmuxClient = {
  call: async (method, params = {}) => {
    calls.push({ method, params })
    if (failOn && failOn.method === method && (failOn.pendingOnly === undefined || failOn.pendingOnly === (params.pending_only === true))) throw new Error(`${method} failed`)
    if (method === "feed.list") return { items: params.pending_only ? feed.filter((entry) => entry.status === "pending") : feed }
    const entry = feed.find((candidate) => candidate.request_id === params.request_id)
    if (entry && resolveAs) resolveAs(entry)
    else if (entry) Object.assign(entry, { status: "resolved", decision: { kind: "permission", mode: params.mode } })
    return { delivered: true }
  },
  command: async () => "OK",
  stream: () => ({ close: () => undefined }),
}

function ctx(): AnswerContext {
  return { agentRoot, stateDir: cmuxStateDir(agentRoot), client, now: () => NOW, cmuxVersion: () => version }
}

function item(command: string, overrides: Partial<CmuxPendingFeedItem> = {}): CmuxPendingFeedItem {
  return {
    requestId: "req-1", kind: "permissionRequest", source: "claude", toolName: "Bash", cwd: repo, workstreamId: "claude-s1",
    createdAt: "2026-10-10T19:59:59Z", toolInput: JSON.stringify({ command }), toolInputTruncated: false, ...overrides,
  }
}

function wire(entry: CmuxPendingFeedItem): Record<string, unknown> {
  return { kind: entry.kind, status: "pending", request_id: entry.requestId, source: entry.source, tool_name: entry.toolName, cwd: entry.cwd, workstream_id: entry.workstreamId, created_at: entry.createdAt, tool_input: entry.toolInput, tool_input_truncated: entry.toolInputTruncated }
}

function grant(targets: string[], maxCount = 2): void {
  updateStewardPolicy(agentRoot, {
    expectedVersion: readStewardPolicy(agentRoot).version,
    actor: { friendId: "ari", trustLevel: "family", sessionEventId: `evt-${maxCount}-${targets.join(",")}`, authorization: { profileId: "sanctuary-owner", profileVersion: 1, requestId: "req-grant", sessionKey: "cli", receiptId: "auth-1" } },
    now: "2026-10-10T10:00:00.000Z",
    mutation: { kind: "grant_routine_action", key: CMUX_GRANT_KEY, action: CMUX_GRANT_ACTION, targets, maxCount, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
  })
}

const log = () => readDecisions(cmuxDecisionLogPath(cmuxStateDir(agentRoot)))
const replies = () => calls.filter((call) => call.method === "feed.permission.reply")

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmux-answer-")))
  repo = path.join(base, "repo")
  agentRoot = path.join(base, "agent.ouro")
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n\tbare = false\n")
  fs.mkdirSync(agentRoot)
  feed = []
  calls = []
  resolveAs = null
  failOn = null
  version = "0.65.0"
})

afterEach(() => {
  // Whatever a test did, the only reply the code ever sent is `once`, one per request.
  for (const reply of replies()) expect(reply.params).toEqual({ request_id: expect.any(String), mode: "once" })
  const ids = replies().map((reply) => reply.params.request_id)
  expect(new Set(ids).size).toBe(ids.length)
  fs.rmSync(base, { recursive: true, force: true })
})

describe("judging a Feed permission request", () => {
  it("never answers what the floor escalates, even with a grant", () => {
    grant([repo])
    expect(judgeFeedItem(ctx(), item("rm -rf src"))).toMatchObject({ reply: false, shape: null, reason: "floor: rm is never answered for the human" })
  })

  it("needs cmux 0.65.0 or later and a standing grant for the repository", () => {
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: "would answer once (floor: git status only reads), but standing grant is missing" })
    grant(["/elsewhere"])
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: expect.stringContaining("target is not covered") })
    version = "0.64.22"
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: "would answer once (floor: git status only reads), but cmux 0.64.22 is older than 0.65.0" })
    version = null
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: expect.stringContaining("cmux of unknown version is older than 0.65.0") })
  })

  it("answers allowlisted requests under the grant's count cap, counting every reply sent", () => {
    grant([repo], 1)
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: true, authority: "standing grant v1 (1 per 60 min); floor: git status only reads" })
    appendDecision(cmuxDecisionLogPath(cmuxStateDir(agentRoot)), {
      at: "2026-10-10T19:30:00.000Z", requestId: "old", source: "claude", tool: "Bash", cwd: repo, outcome: "reply_sent",
      floor: { verdict: "allow", reason: "x" }, shape: null, precedent: null, authority: "x", detail: "",
    })
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: expect.stringContaining("count cap reached") })
  })

  it("answers a soft request only with the human's exact once precedent, and an ask precedent always wins", () => {
    grant([repo])
    const casebook = cmuxCasebookPath(cmuxStateDir(agentRoot))
    expect(judgeFeedItem(ctx(), item("make build"))).toMatchObject({ reply: false, reason: "floor: make is not on the allowlist, and the human has not answered this exact request before" })
    const once = addCase(casebook, { verdict: "once", shape: storeShape({ repoRoot: repo, tool: "Bash", tokens: ["make", "build"] }), requestId: "r0", note: "fine", at: "2026-10-10T19:00:00.000Z" })
    expect(judgeFeedItem(ctx(), item("make build"))).toMatchObject({ reply: true, authority: expect.stringContaining(`precedent ${once.id}`) })
    expect(judgeFeedItem(ctx(), item("make build release"))).toMatchObject({ reply: false })
    addCase(casebook, { verdict: "ask", shape: storeShape({ repoRoot: repo, tool: "Bash", tokens: ["git", "status"] }), requestId: "r1", note: "ask me", at: "2026-10-10T19:10:00.000Z" })
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: "the human asked to be asked about this exact request" })
  })
})

describe("answering once", () => {
  function judged(command = "git status", maxCount = 2) {
    grant([repo], maxCount)
    const entry = item(command)
    const judgment = judgeFeedItem(ctx(), entry)
    if (!judgment.reply) throw new Error("expected a reply judgment")
    return { entry, judgment }
  }

  it("re-checks, reserves, sends once and confirms from the resolved item", async () => {
    const { entry, judgment } = judged()
    feed = [wire(entry)]
    expect(await answerOnce(ctx(), entry, judgment)).toBe("replied_once")
    expect(calls.map((call) => call.method)).toEqual(["feed.list", "feed.permission.reply", "feed.list"])
    expect(calls[2]!.params).toEqual({})
    expect(log().map((record) => record.outcome)).toEqual(["reply_sent", "replied_once"])
    expect(replies()).toHaveLength(1)
  })

  it("logs a race when the human answered first and sends nothing", async () => {
    const { entry, judgment } = judged()
    expect(await answerOnce(ctx(), entry, judgment)).toBe("race")
    expect(replies()).toEqual([])
    expect(log()[0]).toMatchObject({ outcome: "race" })
  })

  it("logs a race when the item ends up resolved some other way, and stays unconfirmed when it is not resolved", async () => {
    const { entry, judgment } = judged("git status", 10)
    feed = [wire(entry)]
    resolveAs = (row) => Object.assign(row, { status: "resolved", decision: { kind: "permission", mode: "deny" } })
    expect(await answerOnce(ctx(), entry, judgment)).toBe("race")
    expect(log().at(-1)).toMatchObject({ outcome: "race", detail: "after the reply the request was resolved (deny)" })

    feed = [wire({ ...entry, requestId: "req-2" })]
    resolveAs = (row) => Object.assign(row, { status: "expired" })
    expect(await answerOnce(ctx(), { ...entry, requestId: "req-2" }, judgment)).toBe("race")
    expect(log().at(-1)).toMatchObject({ detail: "after the reply the request was expired" })

    feed = [wire({ ...entry, requestId: "req-3" })]
    resolveAs = () => undefined
    expect(await answerOnce(ctx(), { ...entry, requestId: "req-3" }, judgment)).toBe("unconfirmed")
    expect(log().at(-1)).toMatchObject({ outcome: "reply_failed", detail: "the request is still pending after the reply" })

    feed = [wire({ ...entry, requestId: "req-4" })]
    resolveAs = () => { feed = [] }
    expect(await answerOnce(ctx(), { ...entry, requestId: "req-4" }, judgment)).toBe("unconfirmed")
    expect(log().at(-1)).toMatchObject({ detail: "cmux no longer lists the request" })

    feed = [wire({ ...entry, requestId: "req-5" })]
    resolveAs = (row) => Object.assign(row, { status: "resolved", decision: "odd" })
    expect(await answerOnce(ctx(), { ...entry, requestId: "req-5" }, judgment)).toBe("race")
  })

  it("does not reply when the pending request changed after it was judged", async () => {
    const { entry, judgment } = judged()
    for (const changed of [{ toolInput: JSON.stringify({ command: "rm -rf ." }) }, { toolName: "Write" }, { cwd: "/" }, { toolInputTruncated: true }]) {
      feed = [wire({ ...entry, ...changed })]
      expect(await answerOnce(ctx(), entry, judgment)).toBe("not_sent")
    }
    expect(replies()).toEqual([])
  })

  it("re-checks the cap under the lock, so two replies cannot both pass it", async () => {
    const { entry, judgment } = judged("git status", 1)
    feed = [wire(entry), wire({ ...entry, requestId: "req-2" })]
    expect(await answerOnce(ctx(), entry, judgment)).toBe("replied_once")
    expect(await answerOnce(ctx(), { ...entry, requestId: "req-2" }, judgment)).toBe("not_sent")
    expect(log().at(-1)).toMatchObject({ outcome: "reply_failed", detail: "standing grant count cap reached" })
    expect(replies()).toHaveLength(1)
  })

  it("records failures to re-check, to reply or to confirm", async () => {
    const { entry, judgment } = judged("git status", 10)
    feed = [wire(entry)]
    failOn = { method: "feed.list", pendingOnly: true }
    expect(await answerOnce(ctx(), entry, judgment)).toBe("not_sent")
    failOn = { method: "feed.permission.reply" }
    expect(await answerOnce(ctx(), entry, judgment)).toBe("not_sent")
    calls = []
    feed = [wire({ ...entry, requestId: "req-2" })]
    failOn = { method: "feed.list", pendingOnly: false }
    expect(await answerOnce(ctx(), { ...entry, requestId: "req-2" }, judgment)).toBe("unconfirmed")
    expect(log().map((record) => record.detail).filter((detail) => detail.includes("failed"))).toEqual([
      "could not re-check the request: feed.list failed",
      "feed.permission.reply failed",
      "could not confirm the reply: feed.list failed",
    ])
  })
})

describe("decision records and Feed status", () => {
  it("records the precedent used, a digest instead of command words, and no authority for an escalation", () => {
    grant([repo])
    const casebook = cmuxCasebookPath(cmuxStateDir(agentRoot))
    const once = addCase(casebook, { verdict: "once", shape: storeShape({ repoRoot: repo, tool: "Bash", tokens: ["make", "build"] }), requestId: "r0", note: "fine", at: "2026-10-10T19:00:00.000Z" })
    const soft = item("make build")
    recordDecision(ctx(), soft, judgeFeedItem(ctx(), soft), "shadow", "x".repeat(3_000))
    const hard = item("rm -rf .", { requestId: "req-2" })
    recordDecision(ctx(), hard, judgeFeedItem(ctx(), hard), "escalated", "floor")
    const [first, second] = log()
    expect(first).toMatchObject({ precedent: { id: once.id, verdict: "once" }, outcome: "shadow", shape: { preview: "make build", digest: expect.stringMatching(/^[0-9a-f]{64}$/) } })
    expect(first!.detail).toHaveLength(2_000)
    expect(second).toMatchObject({ precedent: null, authority: "none", shape: null, floor: { verdict: "hard" } })
  })

  it("reads an item's status and decision from the unfiltered Feed", async () => {
    feed = [{ request_id: "a", status: "resolved", decision: { kind: "permission", mode: "always" } }, { request_id: "b" }, null as unknown as Record<string, unknown>]
    expect(await feedItemStatus(client, "a")).toEqual({ status: "resolved", mode: "always", kind: "permission" })
    expect(await feedItemStatus(client, "b")).toEqual({ status: "unknown", mode: null, kind: null })
    expect(await feedItemStatus(client, "c")).toBeNull()
    const empty: CmuxClient = { ...client, call: async () => ({}) }
    expect(await feedItemStatus(empty, "a")).toBeNull()
  })
})
