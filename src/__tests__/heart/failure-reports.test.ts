import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { setEscalationGrant } from "../../a2a/escalation-grants"
import { FileOutboxStore } from "../../a2a/outbox-store"
import {
  confirmResolvedReports, errorClass, fileFailureReport, fixLiveNoticeText, failureFingerprint, listFailureReports, readFailureReport,
  reportBody, reportsDir, resolveFailureReport, REPORTS_PER_DAY, REPORTS_PER_HOUR, type FailureReportInput,
} from "../../heart/failure-reports"

const replay = vi.hoisted(() => ({ open: new Set<string>() }))
vi.mock("../../a2a/replay-harness", () => ({ isReplayWindowOpen: (_root: string, friendId: string) => replay.open.has(friendId) }))

let tmp: TmpBundleHandle | null = null
beforeEach(() => replay.open.clear())
afterEach(() => { tmp?.cleanup(); tmp = null })

const T0 = Date.parse("2026-10-08T12:00:00.000Z")
const NOW = "2026-10-08T00:00:00.000Z"
function friend(id: string, overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id, name: id, role: "friend", trustLevel: "family", admissionState: "active", initiativePolicy: "reactive_only", connections: [], externalIds: [],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: NOW, updatedAt: NOW, schemaVersion: 1, ...overrides,
  }
}
async function setup(holders: string[] = ["claude"]) {
  tmp = createTmpBundle({ agentName: `reports-${Date.now()}` })
  const store = new FileFriendStore(path.join(tmp.agentRoot, "friends"))
  for (const id of ["ari", "replay-principal", ...holders]) await store.put(id, friend(id))
  for (const id of holders) setEscalationGrant(tmp.agentRoot, id, { grant: true, source: "test" })
  return { agentRoot: tmp.agentRoot, store, outbox: new FileOutboxStore(tmp.agentRoot) }
}
const input = (overrides: Partial<FailureReportInput> = {}): FailureReportInput => ({
  ariWords: "turn the porch light on", tried: "searched the tool list for a lights tool", error: "no tool can control lights", failedTool: "hue_set", severity: "medium",
  origin: { friendId: "ari", channel: "telegram", key: "chat-1" }, ...overrides,
})

describe("fingerprints", () => {
  it("blanks ids, paths and numbers so a retry folds into the same fingerprint", () => {
    expect(errorClass("Request 123 failed at /var/lib/app/x.json for 3f2b8c10-aaaa-4bbb-8ccc-1234567890ab")).toBe("request <n> failed at <path> for <id>")
    expect(failureFingerprint("Hue_Set", "timeout after 30s")).toBe(failureFingerprint(" hue_set ", "Timeout after 45s"))
    expect(failureFingerprint(undefined, "timeout")).not.toBe(failureFingerprint("hue_set", "timeout"))
  })
})

describe("filing failure reports", () => {
  it("writes a report to every escalation holder's outbox and nobody else's", async () => {
    const { agentRoot, store, outbox } = await setup(["claude", "second"])
    const result = await fileFailureReport(agentRoot, store, input(), T0)
    expect(result).toMatchObject({ ok: true, duplicate: false, recipients: 2 })
    if (!result.ok) throw new Error("unreachable")
    for (const holder of ["claude", "second"]) {
      const [entry] = outbox.list(holder).entries
      expect(entry).toMatchObject({ kind: "failure_report", meta: { reportId: result.id, shortId: result.shortId, severity: "medium", failedTool: "hue_set" } })
      expect(entry!.body).toContain("Ari asked: turn the porch light on")
      expect(entry!.body).toContain("hue_set failed: no tool can control lights")
      expect(entry!.body).toContain("telegram/chat-1")
    }
    expect(outbox.list("ari").entries).toEqual([])
    expect(readFailureReport(agentRoot, result.id)).toMatchObject({ status: "open", replay: false, recipients: ["claude", "second"], occurrences: 1 })
    expect(readFailureReport(agentRoot, "not-an-id")).toBeNull()
    expect(readFailureReport(agentRoot, "00000000-0000-4000-8000-000000000000")).toBeNull()
  })

  it("describes a give-up without a failed tool and an unknown conversation", () => {
    const body = reportBody({ shortId: "abcd1234", severity: "high", ariWords: "a", tried: "b", error: "c", failedTool: null, origin: { friendId: null, channel: null, key: null } })
    expect(body).toContain("I gave up: c")
    expect(body).toContain("unknown/unknown")
  })

  it("refuses an incomplete report and says so when nobody holds the grant", async () => {
    const { agentRoot, store } = await setup([])
    expect(await fileFailureReport(agentRoot, store, input({ error: "   " }), T0)).toMatchObject({ ok: false, reason: "invalid" })
    expect(await fileFailureReport(agentRoot, store, input(), T0)).toMatchObject({ ok: false, reason: "no_escalation_peer", detail: "no friend holds the escalation grant" })
    expect(listFailureReports(agentRoot)).toEqual([])
  })

  it("folds a repeat of the same failure into the open report without a second outbox entry", async () => {
    const { agentRoot, store, outbox } = await setup()
    const first = await fileFailureReport(agentRoot, store, input({ error: "timeout after 30s" }), T0)
    const second = await fileFailureReport(agentRoot, store, input({ error: "Timeout after 45s" }), T0 + 1000)
    expect(second).toMatchObject({ ok: true, duplicate: true, id: first.ok ? first.id : "" })
    expect(outbox.list("claude").entries).toHaveLength(1)
    expect(listFailureReports(agentRoot)[0]).toMatchObject({ occurrences: 2 })
    // once the report is closed, the same failure is a new regression
    const record = listFailureReports(agentRoot)[0]!
    fs.writeFileSync(path.join(reportsDir(agentRoot), `${record.id}.json`), JSON.stringify({ ...record, status: "closed" }))
    const third = await fileFailureReport(agentRoot, store, input({ error: "timeout after 9s" }), T0 + 2000)
    expect(third).toMatchObject({ ok: true, duplicate: false })
  })

  it("rate limits new reports per hour and per day", async () => {
    const { agentRoot, store } = await setup()
    for (let i = 0; i < REPORTS_PER_HOUR; i += 1) expect(await fileFailureReport(agentRoot, store, input({ error: `distinct failure kind ${"x".repeat(i)}` }), T0 + i)).toMatchObject({ ok: true })
    const blocked = await fileFailureReport(agentRoot, store, input({ error: "yet another" }), T0 + 10)
    expect(blocked).toMatchObject({ ok: false, reason: "rate_limited" })
    expect(await fileFailureReport(agentRoot, store, input({ error: "an hour later one" }), T0 + 61 * 60_000)).toMatchObject({ ok: true })
    const day = await setup()
    for (let i = 0; i < REPORTS_PER_DAY; i += 1) {
      expect(await fileFailureReport(day.agentRoot, day.store, input({ error: `kind ${"y".repeat(i + 1)}` }), T0 + i * 61 * 60_000 / 1.1)).toMatchObject({ ok: true })
    }
    expect(await fileFailureReport(day.agentRoot, day.store, input({ error: "one too many" }), T0 + 20 * 60 * 60_000 + 1)).toMatchObject({ ok: false, reason: "rate_limited" })
  })

  it("keeps replay conversations and real escalation peers apart in both directions", async () => {
    const { agentRoot, store, outbox } = await setup(["claude", "replay-escalation"])
    replay.open.add("replay-principal")
    replay.open.add("replay-escalation")
    const gate = await fileFailureReport(agentRoot, store, input({ origin: { friendId: "replay-principal", channel: "a2a", key: "ctx" } }), T0)
    expect(gate).toMatchObject({ ok: true, recipients: 1 })
    expect(outbox.list("replay-escalation").entries).toHaveLength(1)
    expect(outbox.list("claude").entries).toEqual([])
    // a replay conversation never folds: every gate run leaves a fresh report
    expect(await fileFailureReport(agentRoot, store, input({ origin: { friendId: "replay-principal", channel: "a2a", key: "ctx" } }), T0 + 1)).toMatchObject({ ok: true, duplicate: false })
    const real = await fileFailureReport(agentRoot, store, input({ origin: { friendId: "ari", channel: "telegram", key: "c" } }), T0 + 2)
    expect(real).toMatchObject({ ok: true, recipients: 1 })
    expect(outbox.list("claude").entries).toHaveLength(1)
    expect(outbox.list("replay-escalation").entries).toHaveLength(2)
    // replay reports do not use up the real quota
    expect(listFailureReports(agentRoot).filter((record) => record.replay)).toHaveLength(2)
  })

  it("reports no replay escalation peer when a replay conversation has none open", async () => {
    const { agentRoot, store } = await setup(["claude"])
    replay.open.add("replay-principal")
    expect(await fileFailureReport(agentRoot, store, input({ origin: { friendId: "replay-principal", channel: "a2a", key: "ctx" } }), T0)).toMatchObject({ ok: false, reason: "no_escalation_peer", detail: "no replay escalation peer" })
  })

  it("files a report whose conversation has no friend", async () => {
    const { agentRoot, store } = await setup()
    expect(await fileFailureReport(agentRoot, store, input({ failedTool: undefined, origin: { friendId: null, channel: null, key: null } }), T0)).toMatchObject({ ok: true })
    expect(listFailureReports(path.join(agentRoot, "nowhere"))).toEqual([])
  })
})

describe("resolving and confirming", () => {
  async function filed() {
    const ctx = await setup()
    const result = await fileFailureReport(ctx.agentRoot, ctx.store, input(), T0)
    if (!result.ok) throw new Error("setup failed")
    return { ...ctx, id: result.id }
  }

  it("accepts a resolution only from a recipient, with a real version and a note", async () => {
    const { agentRoot, id } = await filed()
    expect(resolveFailureReport(agentRoot, { id: "00000000-0000-4000-8000-000000000000", version: "0.1.0-alpha.9", note: "n", byFriendId: "claude" })).toEqual({ ok: false, reason: "unknown_report" })
    expect(resolveFailureReport(agentRoot, { id, version: "0.1.0-alpha.9", note: "n", byFriendId: "ari" })).toEqual({ ok: false, reason: "not_recipient" })
    expect(resolveFailureReport(agentRoot, { id, version: "next week", note: "n", byFriendId: "claude" })).toEqual({ ok: false, reason: "bad_version" })
    expect(resolveFailureReport(agentRoot, { id, version: "0.1.0-alpha.9", note: "  ", byFriendId: "claude" })).toEqual({ ok: false, reason: "bad_note" })
    expect(resolveFailureReport(agentRoot, { id, version: "0.1.0-alpha.9", note: "Added a lights tool.", byFriendId: "claude" }, T0)).toEqual({ ok: true, id, status: "resolved" })
    expect(readFailureReport(agentRoot, id)).toMatchObject({ status: "resolved", resolution: { version: "0.1.0-alpha.9", note: "Added a lights tool.", by: "claude" } })
  })

  it("waits until the running version reaches the fix, then tells the owner once and closes the report", async () => {
    const { agentRoot, id } = await filed()
    resolveFailureReport(agentRoot, { id, version: "0.1.0-alpha.875", note: "Added a lights tool.", byFriendId: "claude" }, T0)
    const notices: { noticeId: string; text: string }[] = []
    const notifyOwner = async (notice: { noticeId: string; text: string }) => { notices.push(notice) }
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "0.1.0-alpha.874", notifyOwner })).toEqual({ closed: [], waiting: [id], failed: [] })
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "not-a-version", notifyOwner })).toEqual({ closed: [], waiting: [id], failed: [] })
    expect(notices).toEqual([])
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "0.1.0-alpha.876", notifyOwner }, T0)).toEqual({ closed: [id], waiting: [], failed: [] })
    expect(notices).toEqual([{ noticeId: `failure-fixed:${id}`, text: fixLiveNoticeText(readFailureReport(agentRoot, id)!) }])
    expect(notices[0]!.text).toContain("version 0.1.0-alpha.875")
    expect(notices[0]!.text).toContain("You asked: turn the porch light on")
    expect(readFailureReport(agentRoot, id)).toMatchObject({ status: "closed" })
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "0.1.0-alpha.876", notifyOwner })).toEqual({ closed: [], waiting: [], failed: [] })
    expect(resolveFailureReport(agentRoot, { id, version: "0.1.0-alpha.9", note: "n", byFriendId: "claude" })).toEqual({ ok: false, reason: "already_closed" })
  })

  it("keeps a report resolved when the owner cannot be told, so the next pass retries", async () => {
    const { agentRoot, id } = await filed()
    resolveFailureReport(agentRoot, { id, version: "0.1.0-alpha.1", note: "Done.", byFriendId: "claude" }, T0)
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "0.1.0-alpha.2", notifyOwner: async () => { throw new Error("telegram down") } })).toEqual({ closed: [], waiting: [], failed: [id] })
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "0.1.0-alpha.2", notifyOwner: async () => { throw "plain" } })).toEqual({ closed: [], waiting: [], failed: [id] })
    expect(readFailureReport(agentRoot, id)).toMatchObject({ status: "resolved" })
  })

  it("closes a replay report without telling the owner", async () => {
    const { agentRoot, store } = await setup(["replay-escalation"])
    replay.open.add("replay-principal")
    replay.open.add("replay-escalation")
    const result = await fileFailureReport(agentRoot, store, input({ origin: { friendId: "replay-principal", channel: "a2a", key: "c" } }), T0)
    if (!result.ok) throw new Error("setup failed")
    resolveFailureReport(agentRoot, { id: result.id, version: "0.1.0-alpha.1", note: "Done.", byFriendId: "replay-escalation" }, T0)
    const notifyOwner = vi.fn()
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "0.1.0-alpha.1", notifyOwner })).toEqual({ closed: [result.id], waiting: [], failed: [] })
    expect(notifyOwner).not.toHaveBeenCalled()
  })

  it("skips a report that is still open", async () => {
    const { agentRoot } = await filed()
    expect(await confirmResolvedReports(agentRoot, { runningVersion: "9.9.9", notifyOwner: vi.fn() })).toEqual({ closed: [], waiting: [], failed: [] })
  })
})

describe("unreadable report files", () => {
  it("lists only the reports it can read", async () => {
    const { agentRoot } = await setup()
    fs.mkdirSync(reportsDir(agentRoot), { recursive: true })
    fs.writeFileSync(path.join(reportsDir(agentRoot), "broken.json"), "{not json")
    fs.writeFileSync(path.join(reportsDir(agentRoot), "note.txt"), "ignored")
    expect(listFailureReports(agentRoot)).toEqual([])
  })
})
