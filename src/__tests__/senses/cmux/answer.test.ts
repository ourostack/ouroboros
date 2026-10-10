import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readStewardPolicy, updateStewardPolicy } from "../../../heart/steward-policy"
import { answerOnce, CMUX_GRANT_ACTION, CMUX_GRANT_KEY, cmuxStateDir, judgeFeedItem, recordDecision, type AnswerContext } from "../../../senses/cmux/answer"
import type { CmuxPendingFeedItem } from "../../../senses/cmux/attention"
import { addCase, appendDecision, cmuxCasebookPath, cmuxDecisionLogPath, readDecisions } from "../../../senses/cmux/casebook"
import type { CmuxClient } from "../../../senses/cmux/client"

const NOW = Date.parse("2026-10-10T20:00:00.000Z")
let base = ""
let repo = ""
let agentRoot = ""
let calls: Array<{ method: string; params: Record<string, unknown> }> = []
let pending: unknown[] = []
let replyError: Error | null = null
let listError: Error | null = null

const client: CmuxClient = {
  call: async (method, params = {}) => {
    calls.push({ method, params })
    if (method === "feed.list") {
      if (listError) throw listError
      return { items: pending }
    }
    if (replyError) throw replyError
    return { delivered: true }
  },
  command: async () => "OK",
  stream: () => ({ close: () => undefined }),
}

function ctx(): AnswerContext {
  return { agentRoot, stateDir: cmuxStateDir(agentRoot), client, now: () => NOW }
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

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmux-answer-")))
  repo = path.join(base, "repo")
  agentRoot = path.join(base, "agent.ouro")
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
  fs.mkdirSync(agentRoot)
  calls = []
  pending = []
  replyError = null
  listError = null
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe("judging a Feed permission request", () => {
  it("never answers what the floor escalates, even with a once precedent and a grant", () => {
    grant([repo])
    const judgment = judgeFeedItem(ctx(), item("rm -rf src"))
    expect(judgment).toMatchObject({ reply: false, shape: null, reason: "floor: rm is never answered for the human" })
  })

  it("needs a standing grant for the repository even for allowlisted requests", () => {
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: "would answer once (floor: git status only reads), but standing grant is missing" })
    grant(["/elsewhere"])
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: expect.stringContaining("target is not covered") })
  })

  it("answers allowlisted requests under the grant's count cap", () => {
    grant([repo], 1)
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: true, authority: "standing grant v1 (1 per 60 min); floor: git status only reads" })
    appendDecision(cmuxDecisionLogPath(cmuxStateDir(agentRoot)), {
      at: "2026-10-10T19:30:00.000Z", requestId: "old", source: "claude", tool: "Bash", cwd: repo, outcome: "replied_once",
      floor: { verdict: "allow", reason: "x" }, shape: null, precedent: null, authority: "x", detail: "",
    })
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: expect.stringContaining("count cap reached") })
  })

  it("answers a soft request only with the human's exact once precedent, and an ask precedent always wins", () => {
    grant([repo])
    const casebook = cmuxCasebookPath(cmuxStateDir(agentRoot))
    expect(judgeFeedItem(ctx(), item("make build"))).toMatchObject({ reply: false, reason: "floor: make is not on the allowlist, and the human has not answered this exact request before" })
    const once = addCase(casebook, { verdict: "once", shape: { repoRoot: repo, tool: "Bash", tokens: ["make", "build"] }, requestId: "r0", note: "fine", at: "2026-10-10T19:00:00.000Z" })
    expect(judgeFeedItem(ctx(), item("make build"))).toMatchObject({ reply: true, authority: expect.stringContaining(`precedent ${once.id}`) })
    expect(judgeFeedItem(ctx(), item("make build release"))).toMatchObject({ reply: false })
    addCase(casebook, { verdict: "ask", shape: { repoRoot: repo, tool: "Bash", tokens: ["git", "status"] }, requestId: "r1", note: "ask me", at: "2026-10-10T19:10:00.000Z" })
    expect(judgeFeedItem(ctx(), item("git status"))).toMatchObject({ reply: false, reason: "the human asked to be asked about this exact request" })
  })
})

describe("answering once", () => {
  async function judged(command = "git status") {
    grant([repo])
    const entry = item(command)
    const judgment = judgeFeedItem(ctx(), entry)
    if (!judgment.reply) throw new Error("expected a reply judgment")
    return { entry, judgment }
  }

  it("re-checks the request and sends only once", async () => {
    const { entry, judgment } = await judged()
    pending = [wire(entry)]
    expect(await answerOnce(ctx(), entry, judgment)).toBe("replied_once")
    expect(calls).toEqual([
      { method: "feed.list", params: { pending_only: true } },
      { method: "feed.permission.reply", params: { request_id: "req-1", mode: "once" } },
    ])
    expect(readDecisions(cmuxDecisionLogPath(cmuxStateDir(agentRoot)))).toEqual([expect.objectContaining({ outcome: "replied_once", requestId: "req-1", authority: judgment.authority })])
  })

  it("logs a race when the human answered first and sends nothing", async () => {
    const { entry, judgment } = await judged()
    expect(await answerOnce(ctx(), entry, judgment)).toBe("race")
    expect(calls.map((call) => call.method)).toEqual(["feed.list"])
    expect(readDecisions(cmuxDecisionLogPath(cmuxStateDir(agentRoot)))[0]).toMatchObject({ outcome: "race" })
  })

  it("does not reply when the pending request changed after it was judged", async () => {
    const { entry, judgment } = await judged()
    for (const changed of [{ toolInput: JSON.stringify({ command: "rm -rf ." }) }, { toolName: "Write" }, { cwd: "/" }, { toolInputTruncated: true }]) {
      pending = [wire({ ...entry, ...changed })]
      expect(await answerOnce(ctx(), entry, judgment)).toBe("reply_failed")
    }
    expect(calls.some((call) => call.method === "feed.permission.reply")).toBe(false)
  })

  it("records failures to re-check or to reply", async () => {
    const { entry, judgment } = await judged()
    listError = new Error("socket gone")
    expect(await answerOnce(ctx(), entry, judgment)).toBe("reply_failed")
    listError = null
    pending = [wire(entry)]
    replyError = new Error("reply refused")
    expect(await answerOnce(ctx(), entry, judgment)).toBe("reply_failed")
    expect(readDecisions(cmuxDecisionLogPath(cmuxStateDir(agentRoot))).map((record) => record.detail)).toEqual(["could not re-check the request: socket gone", "reply refused"])
  })
})

describe("decision records", () => {
  it("records the precedent used and no authority for an escalation", () => {
    grant([repo])
    const casebook = cmuxCasebookPath(cmuxStateDir(agentRoot))
    const once = addCase(casebook, { verdict: "once", shape: { repoRoot: repo, tool: "Bash", tokens: ["make", "build"] }, requestId: "r0", note: "fine", at: "2026-10-10T19:00:00.000Z" })
    const soft = item("make build")
    recordDecision(ctx(), soft, judgeFeedItem(ctx(), soft), "shadow", "x".repeat(3_000))
    const hard = item("rm -rf .", { requestId: "req-2" })
    recordDecision(ctx(), hard, judgeFeedItem(ctx(), hard), "escalated", "floor")
    const [first, second] = readDecisions(cmuxDecisionLogPath(cmuxStateDir(agentRoot)))
    expect(first).toMatchObject({ precedent: { id: once.id, verdict: "once" }, outcome: "shadow" })
    expect(first!.detail).toHaveLength(2_000)
    expect(second).toMatchObject({ precedent: null, authority: "none", shape: null, floor: { verdict: "hard" } })
  })
})

describe("reply modes", () => {
  it("has no code path that sends always, all or bypass", async () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "..", "senses", "cmux", "answer.ts"), "utf-8")
    expect(source).not.toMatch(/mode:\s*"(?:always|all|bypass|deny)"/)
    expect(source.match(/feed\.permission\.reply/g)).toHaveLength(1)
    expect(vi.isMockFunction(client.call)).toBe(false)
  })
})
