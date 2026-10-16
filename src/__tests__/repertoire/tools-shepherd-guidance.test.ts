import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shepherdGuidanceToolDefinitions } from "../../repertoire/tools-shepherd-guidance"
import type { ToolContext } from "../../repertoire/tools-base"
import { appendReturn, returnsLogPath, type ReturnRecord } from "../../senses/shepherd/returns"
import { readGuidance, shepherdReturnId } from "../../senses/shepherd/guidance"
import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import * as hostModule from "../../senses/shepherd/host"
import { startFakeCmux } from "../senses/shepherd/fake-cmux"
import { tree } from "../senses/shepherd/fixtures"
import { registerGlobalLogSink, type LogEvent } from "../../nerves"
import { enqueueNotice, readNoticeOutbox, recordNoticeDelivery } from "../../senses/shepherd/notice-outbox"

let root: string
const returned: ReturnRecord = { at: "2026-10-13", host: "cmux", session: "gone", transition: "t1", agent: "coding", cwd: "/code/app", task: null, kind: "premature", action: "respond", reason: "A plan", reply: "Continue.", latencyMs: 1, inputTokens: 2 }
function ctx(id = "ari", trustLevel = "family"): ToolContext {
  return { agentRoot: root, agentName: "guidancetools", signin: async () => undefined, context: { friend: { id, name: "Ari", trustLevel } } } as ToolContext
}
async function call(name: string, args: Record<string, unknown> = {}, context: ToolContext | undefined = ctx()) {
  const definition = shepherdGuidanceToolDefinitions.find(d => d.tool.function.name === name)!
  return JSON.parse(await definition.handler(args as Record<string, string>, context))
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-guidance-tools-"))
  appendReturn(root, returned)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetRuntimeCredentialConfigCache()
})
describe("family-only Shepherd guidance tools", () => {
  it("defaults bound feedback history/corrections/guidance to that session and refuses a different one", async () => {
    appendReturn(root, { ...returned, session: "other", transition: "t2" })
    const bound = { ...ctx(), currentShepherdSurface: { id: "gone", host: "cmux" as const, label: "selected" } }
    expect((await call("shepherd_history", {}, bound)).returns.map((record: ReturnRecord) => record.session)).toEqual(["gone"])
    expect((await call("shepherd_history", { session: "other" }, bound)).error).toContain("bound")
    const args = { request_id: "default-bound", feedback: "Do not stop at the plan.", principle: "Finish the requested implementation." }
    expect(await call("shepherd_correct", args, bound)).toMatchObject({ revision: 1 })
    const second = { ...bound, currentShepherdSurface: { id: "other", host: "cmux" as const, label: "other" } }
    expect((await call("shepherd_correct", args, second)).error).toContain("different body")
    expect(await call("shepherd_correct", { ...args, request_id: "second-source" }, second)).toMatchObject({ revision: 2 })
    const guidance = await call("shepherd_guidance", {}, bound)
    expect(guidance.principles).toHaveLength(1)
    expect(readGuidance(root).corrections.map(record => record.target.session)).toEqual(["gone", "other"])
    expect((await call("shepherd_history")).returns).toHaveLength(2)
  })

  it("provides a deterministic human label without changing the full correction identifier", async () => {
    const history = await call("shepherd_history")
    expect(history.returns[0].displayId).toBe("22e694c3")
    expect(history.returns[0].id).toBe(shepherdReturnId(returned))
  })

  it("does not let stored extra fields forge the canonical return identifier or display label", async () => {
    const value = { ...returned, transition: "forged", id: "untrusted-id", displayId: "untrusted-label" }
    appendReturn(root, value)
    const row = (await call("shepherd_history")).returns.at(-1)
    expect(row.id).toBe(shepherdReturnId(value))
    expect(row.displayId).not.toBe("untrusted-label")
    expect(row.displayId).toHaveLength(8)
  })

  it.each(["pending", "unknown", "sent"] as const)("reports the human's actual %s notice receipt without exposing another recipient's receipt", async state => {
    const value = { ...returned, transition: `notice-${state}`, noticeEligible: true }
    appendReturn(root, value)
    const id = await enqueueNotice(root, value)
    await recordNoticeDelivery(root, [id], "ari", { state, at: "now", ...(state === "sent" ? { messageId: "own-activity" } : { reason: "not confirmed" }) })
    await recordNoticeDelivery(root, [id], "other", { state: "sent", at: "now", messageId: "OTHER_PRIVATE_ACTIVITY" })
    const history = await call("shepherd_history", { session: "gone" })
    expect(history.returns.at(-1).ownerNotice).toMatchObject({ state, attempts: 1 })
    expect(JSON.stringify(history)).not.toContain("OTHER_PRIVATE_ACTIVITY")
    expect((await call("shepherd_history", { session: "gone" }, ctx("not-targeted"))).returns.at(-1).ownerNotice).toBeNull()
  })

  it("keeps archived acceptance inspectable without replaying transport", async () => {
    const value = { ...returned, transition: "archived-notice", noticeEligible: true }
    appendReturn(root, value)
    const id = await enqueueNotice(root, value)
    await recordNoticeDelivery(root, [id], "ari", { state: "sent", at: "now", messageId: "archived-activity" })
    const entry = readNoticeOutbox(root)[0]!
    const dir = path.join(root, "state", "senses", "shepherd")
    fs.mkdirSync(path.join(dir, "notice-receipts"))
    fs.writeFileSync(path.join(dir, "notice-receipts", `${id}.json`), JSON.stringify(entry))
    fs.writeFileSync(path.join(dir, "notice-outbox.json"), JSON.stringify({ schemaVersion: 1, entries: [] }))
    expect((await call("shepherd_history", { session: "gone" })).returns.at(-1).ownerNotice).toMatchObject({ state: "sent", messageId: "archived-activity" })
  })

  it("reports unavailable notice evidence without losing return history or claiming delivery", async () => {
    const dir = path.join(root, "state", "senses", "shepherd")
    fs.writeFileSync(path.join(dir, "notice-outbox.json"), "{invalid")
    const history = await call("shepherd_history", { session: "gone" })
    expect(history.returns).toEqual([{ id: shepherdReturnId(returned), displayId: "22e694c3", ...returned }])
    expect(history.ownerNoticeError).toMatch(/malformed JSON/)
  })

  it("redacts even a non-Error receipt read failure while retaining private return history", async () => {
    const noticeModule = await import("../../senses/shepherd/notice-outbox")
    vi.spyOn(noticeModule, "readNoticeOutbox").mockImplementationOnce(() => { throw "token=abc123secret failed" })
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      const history = await call("shepherd_history")
      expect(history.ownerNoticeError).toBe("token=[redacted] failed")
      expect(history.returns).toEqual([{ id: shepherdReturnId(returned), displayId: "22e694c3", ...returned }])
      expect(JSON.stringify(events)).not.toMatch(/\btoken\b["']?\s*[:=]/)
    } finally { unregister() }
  })

  it("traces an executed guidance tool without the private human instruction", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      expect(await call("shepherd_correct", { session: "gone", request_id: "traced", feedback: "PRIVATE_HUMAN_INSTRUCTION" })).toMatchObject({ revision: 1 })
      expect(events).toContainEqual(expect.objectContaining({ event: "repertoire.shepherd_guidance_tool", meta: { tool: "shepherd_correct", mutates: true } }))
      expect(JSON.stringify(events)).not.toContain("PRIVATE_HUMAN_INSTRUCTION")
    } finally { unregister() }
  })

  it("refuses steering mutations outside the composer's bound UUID without modifying guidance", async () => {
    const bound = { ...ctx(), currentShepherdSurface: { id: "other", host: "cmux", label: "selected" } } as ToolContext
    for (const name of ["shepherd_pause", "shepherd_resume", "shepherd_correct"]) {
      expect((await call(name, { host: "cmux", session: "gone", request_id: name, feedback: "Leave it alone", principle: "Do not nudge" }, bound)).error).toMatch(/bound/)
    }
    expect((await call("shepherd_correct", { return_id: shepherdReturnId(returned), request_id: "historical", feedback: "wrong" }, bound)).error).toMatch(/bound/)
    expect(readGuidance(root).revision).toBe(0)
    const current = { ...bound, currentShepherdSurface: { id: "gone", host: "cmux" as const, label: "selected" } }
    expect(await call("shepherd_pause", { session: "gone", request_id: "same" }, current)).toMatchObject({ paused: true })
    expect((await call("shepherd_resume", { host: "herdr", session: "gone", request_id: "wrong-host" }, current)).error).toMatch(/bound/)
    expect(readGuidance(root).revision).toBe(1)
  })

  it("refuses every private operation without a real family conversation", async () => {
    for (const definition of shepherdGuidanceToolDefinitions) {
      for (const context of [ctx("self"), ctx("", "family"), ctx("stranger", "stranger"), ctx("friend", "friend"), { ...ctx(), context: undefined }, { ...ctx(), agentRoot: undefined }, { ...ctx(), agentName: undefined }]) {
        const result = await call(definition.tool.function.name, {}, context)
        expect(result.error).toMatch(/family|runtime/)
      }
    }
    expect(readGuidance(root).revision).toBe(0)
    expect(JSON.parse(await shepherdGuidanceToolDefinitions[0]!.handler({}, undefined)).error).toMatch(/family/)
  })
  it("reads vanished-terminal history with stable IDs without resolving or sending to a host", async () => {
    const result = await call("shepherd_history")
    expect(result.returns).toEqual([{ id: shepherdReturnId(returned), displayId: "22e694c3", ...returned }])
    expect(await call("shepherd_history", { session: "else" })).toEqual({ returns: [] })
    expect(await call("shepherd_history", { host: "other" })).toEqual({ returns: [] })
  })
  it("learns from the human, inspects, changes, forgets, pauses and resumes a recorded session", async () => {
    const target = { host: "cmux", session: "gone" }
    const receipt = await call("shepherd_correct", { ...target, request_id: "c1", return_id: shepherdReturnId(returned), feedback: "Review is external.", principle: "Wait for review." })
    expect(receipt).toMatchObject({ revision: 1, principleId: expect.any(String) })
    expect((await call("shepherd_guidance", target)).principles).toHaveLength(1)
    expect(await call("shepherd_update_principle", { request_id: "u1", principle_id: receipt.principleId, text: "Report the dependency." })).toMatchObject({ revision: 2 })
    expect(await call("shepherd_pause", { ...target, request_id: "p1" })).toMatchObject({ revision: 3 })
    expect((await call("shepherd_guidance", target)).paused).toBe(true)
    expect(await call("shepherd_resume", { ...target, request_id: "r1" })).toMatchObject({ revision: 4 })
    expect(await call("shepherd_forget_principle", { request_id: "f1", principle_id: receipt.principleId })).toMatchObject({ revision: 5 })
    expect((await call("shepherd_guidance", target)).principles).toEqual([])
    expect(readGuidance(root).corrections[0]!.provenance.actorId).toBe("ari")
  })
  it("returns explicit errors for invalid mutation requests and missing session", async () => {
    expect((await call("shepherd_correct", { host: "cmux", session: "gone", feedback: "wrong" })).error).toMatch(/request/)
    expect((await call("shepherd_pause")).error).toMatch(/session/)
    expect((await call("shepherd_correct", { host: "cmux", session: "gone", request_id: "r", return_id: "invented", feedback: "wrong" })).error).toMatch(/return/)
    for (const mismatch of [{ host: "wrong" }, { session: "wrong" }]) {
      expect((await call("shepherd_correct", { ...mismatch, request_id: "r", return_id: shepherdReturnId(returned), feedback: "wrong" })).error).toMatch(/target/)
    }
    appendReturn(root, { ...returned, host: "herdr" })
    expect((await call("shepherd_guidance", { session: "gone" })).error).toMatch(/ambiguous/)
  })

  it("requires existing machine credentials for unknown sessions rather than falling back to global scope", async () => {
    expect((await call("shepherd_correct", { session: "unknown", request_id: "r", feedback: "wrong", scope: "global" })).error).toMatch(/cmux|host|connect/)
    expect(readGuidance(root).revision).toBe(0)
  })

  it("resolves a live ref to its stable identity and never sends, even when pausing or resuming", async () => {
    const server = await startFakeCmux({ capability: "v1.t.s" })
    cacheMachineRuntimeCredentialConfig("guidancetools", { cmux: { socketCapability: "v1.t.s", socketPath: server.socketPath } })
    server.respond("system.tree", () => tree([{ id: "live-uuid", ref: "surface:9" }]))
    try {
      expect(await call("shepherd_correct", { session: "surface:9", request_id: "live", feedback: "Leave this alone", principle: "Do not nudge this session." })).toMatchObject({ revision: 1 })
      expect(readGuidance(root).principles[0]!.target).toEqual({ host: "cmux", session: "live-uuid", cwd: null, task: null })
      expect(await call("shepherd_pause", { host: "cmux", session: "surface:9", request_id: "pause" })).toMatchObject({ paused: true })
      expect(await call("shepherd_resume", { session: "surface:9", request_id: "resume" })).toMatchObject({ paused: false })
      expect((await call("shepherd_guidance", { session: "live-uuid" })).paused).toBe(false)
      expect((await call("shepherd_guidance", { session: "missing" })).error).toMatch(/unknown session/)
      expect((await call("shepherd_guidance", { session: "live-uuid", host: "wrong" })).error).toMatch(/unknown session/)
      expect(server.methods.every(m => m.method === "system.tree")).toBe(true)
    } finally { await server.close() }
  })

  it("uses canonical live cwd for project learning and keeps terminal failures private and redacted", async () => {
    cacheMachineRuntimeCredentialConfig("guidancetools", { cmux: { socketCapability: "v1.t.s", socketPath: "/synthetic.sock" } })
    const create = hostModule.createShepherdHost
    vi.spyOn(hostModule, "createShepherdHost").mockImplementation((...args) => ({
      ...create(...args),
      list: async () => [{ id: "live", ref: "surface:8", workspace: null, title: "", agent: null, focused: false, cwd: "/code/app" }],
    }))
    expect(await call("shepherd_correct", { session: "live", request_id: "project", feedback: "Future instruction", principle: "Wait for review.", scope: "project" })).toMatchObject({ revision: 1 })
    expect(readGuidance(root).principles[0]!.scope).toBe("project")
    vi.mocked(hostModule.createShepherdHost).mockImplementation((...args) => ({ ...create(...args), list: async () => { throw "token=abc123secret failed" } }))
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      expect((await call("shepherd_guidance", { session: "unrecorded" })).error).toBe("token=[redacted] failed")
      expect(JSON.stringify(events)).not.toMatch(/\btoken\b["']?\s*[:=]/)
    } finally { unregister() }
  })

  it("keeps malformed argument types from recording invented preferences", async () => {
    const target = { host: "cmux", session: "gone", request_id: "bad" }
    for (const invalid of [{ feedback: 5 }, { feedback: "x", principle: 5 }, { feedback: "x", scope: "bad" }, { feedback: "x", return_id: "" }]) {
      expect((await call("shepherd_correct", { ...target, ...invalid })).error).toBeTruthy()
    }
    const receipt = await call("shepherd_correct", { ...target, request_id: "valid", feedback: "x", principle: "y" })
    expect((await call("shepherd_update_principle", { request_id: "update", principle_id: receipt.principleId, text: 2 })).error).toMatch(/principle/)
    expect((await call("shepherd_guidance", { session: 3 })).error).toMatch(/session/)
  })

  it("replays the same human request after session coordinates change or return history rotates away", async () => {
    const args = { host: "cmux", session: "gone", request_id: "prospective", feedback: "Do not nudge a review.", principle: "Wait for outside review." }
    const receipt = await call("shepherd_correct", args)
    appendReturn(root, { ...returned, transition: "next", cwd: "/code/else", task: "other" })
    expect(await call("shepherd_correct", args)).toEqual(receipt)
    fs.renameSync(returnsLogPath(root), `${returnsLogPath(root)}.retained-fixture`)
    expect(await call("shepherd_correct", args)).toEqual(receipt)
    expect((await call("shepherd_correct", { ...args, feedback: "Different human request" })).error).toMatch(/different body/)
    expect((await call("shepherd_pause", { ...args })).error).toMatch(/different body/)
    expect(readGuidance(root).revision).toBe(1)
  })

  it("answers what it learned without requiring a session or hiding unrelated active scopes", async () => {
    await call("shepherd_correct", { host: "cmux", session: "gone", request_id: "learn", feedback: "Future", principle: "Outside reviews are dependencies." })
    await call("shepherd_pause", { host: "cmux", session: "gone", request_id: "pause" })
    const state = await call("shepherd_guidance")
    expect(state).toMatchObject({ revision: 2, principles: [{ text: "Outside reviews are dependencies.", scope: "session", target: { session: "gone" }, provenance: { actorId: "ari" } }], pauses: [{ session: "gone", paused: true }] })
    await call("shepherd_forget_principle", { request_id: "forget", principle_id: state.principles[0].id })
    await call("shepherd_resume", { host: "cmux", session: "gone", request_id: "resume" })
    expect(await call("shepherd_guidance")).toMatchObject({ revision: 4, principles: [], pauses: [] })
  })
})
