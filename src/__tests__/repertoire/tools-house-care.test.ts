import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const replay = vi.hoisted(() => ({ identity: false, open: true, any: false, notices: [] as unknown[] }))
vi.mock("../../a2a/replay-harness", () => ({
  isReplayIdentity: () => replay.identity,
  isReplayWindowOpen: () => replay.open,
  isAnyReplayWindowOpen: () => replay.any,
  appendReplayNotice: (_root: string, notice: unknown) => { replay.notices.push(notice) },
}))
vi.mock("../../heart/awaiting/a2a-await-delivery", () => ({ defaultNotifyOwner: () => async () => { throw new Error("default notifier used") } }))

import { DIGEST_MAX_LINES, LEAD_IN_MAX_CHARS, digestLines, houseCareToolDefinitions, houseDigestToolDefinition, houseSweepToolDefinition, setHouseCareToolDeps } from "../../repertoire/tools-house-care"
import { readLedger, rememberSweep } from "../../repertoire/house-sweep"
import { SELF_FRIEND_ID, type ToolContext } from "../../repertoire/tools-base"

let root: string
const DAY = 86_400_000
const NOW = Date.parse("2026-10-09T12:00:00.000Z")
const sent: { noticeId: string; text: string }[] = []

const ctx = (over: Record<string, unknown> = {}): ToolContext => ({ agentRoot: root, agentName: "sanctuary", ...over }) as unknown as ToolContext
const writeReport = (scope: "live" | "replay", findings: { id: string; fingerprint: string; summary: string }[]) => rememberSweep(root, scope, findings)
const SCHEDULED = { autonomousTurnKind: "await", autonomousAwaitName: "house-care-sweep" }
const digest = (args: Record<string, unknown>, c = ctx()) => houseDigestToolDefinition.handler(args as never, c).then((r) => JSON.parse(r as string))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "house-care-"))
  replay.identity = false
  replay.open = true
  replay.any = false
  replay.notices = []
  sent.length = 0
  setHouseCareToolDeps({ now: () => NOW, notifyOwner: () => async (notice: { noticeId: string; text: string }) => { sent.push(notice) }, sweepDeps: { fetch: (async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch } } as never)
})
afterEach(() => {
  setHouseCareToolDeps({})
  fs.rmSync(root, { recursive: true, force: true })
})

describe("house_sweep tool", () => {
  it("is registered with both tools and is read-only", () => {
    expect(houseCareToolDefinitions.map((d) => d.tool.function.name)).toEqual(["house_sweep", "house_digest_send"])
    expect(houseSweepToolDefinition.riskProfile?.mutates).toBe("none")
  })
  it("refuses without a runtime", async () => {
    expect(JSON.parse(await houseSweepToolDefinition.handler({}, undefined) as string).error).toContain("unavailable")
  })
  it("returns a live report, and a replay report for a replay identity", async () => {
    const live = JSON.parse(await houseSweepToolDefinition.handler({}, ctx()) as string)
    expect(live.scope).toBe("live")
    replay.identity = true
    const asked = JSON.parse(await houseSweepToolDefinition.handler({}, ctx({ context: { friend: { id: "replay-1" } } })) as string)
    expect(asked.scope).toBe("replay")
    const viaAuth = JSON.parse(await houseSweepToolDefinition.handler({}, ctx({ relationshipAuthorization: { actor: { friendId: "replay-2" } } })) as string)
    expect(viaAuth.scope).toBe("replay")
  })
  it("uses the default clock and fetch deps when none are injected", async () => {
    setHouseCareToolDeps({})
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    const report = JSON.parse(await houseSweepToolDefinition.handler({}, ctx()) as string)
    expect(report.scope).toBe("live")
    spy.mockRestore()
  })
})

describe("house_digest_send tool", () => {
  const finding = { id: "downloads:sonarr:1", fingerprint: "fp1", summary: "Show is stuck" }
  it("refuses without a runtime, without ids, and for unknown ids", async () => {
    expect(JSON.parse(await houseDigestToolDefinition.handler({ finding_ids: ["a"] } as never, undefined) as string).error).toContain("unavailable")
    expect((await digest({ finding_ids: [] })).sent).toBe(false)
    expect((await digest({ finding_ids: "nope" })).error).toContain("at least one")
    expect((await digest({ finding_ids: [1, ""] })).error).toContain("at least one")
    writeReport("live", [])
    const unknown = await digest({ finding_ids: ["x"] })
    expect(unknown.error).toContain("unknown finding ids: x")
    expect(sent).toHaveLength(0)
  })
  it("refuses a lead-in that is long, multi-line, or carries a link", async () => {
    writeReport("live", [finding])
    for (const lead_in of ["x".repeat(LEAD_IN_MAX_CHARS + 1), "two\nlines", "see https://evil.example/x", "go to evil.example now", "ping @owner", "mailto:a@b", "zero\u200bwidth", "bidi\u202etext"]) {
      expect((await digest({ finding_ids: [finding.id], lead_in })).error).toContain("lead_in must be one plain line")
    }
    expect(sent).toHaveLength(0)
  })
  it("sends a scheduled digest, records the ledger, and dedupes ids", async () => {
    writeReport("live", [finding])
    const result = await digest({ finding_ids: [finding.id, finding.id] }, ctx(SCHEDULED))
    expect(result).toEqual({ sent: true, destination: "owner", findings: 1 })
    expect(sent[0].text).toBe("- Show is stuck")
    expect(sent[0].noticeId).toMatch(/^house-sweep:scheduled:2026-10-09:[0-9a-f]{12}$/u)
    expect(readLedger(root)[finding.id].fingerprint).toBe("fp1")
  })
  it("puts only a short lead-in above the stored summaries, on demand", async () => {
    writeReport("live", [finding])
    await digest({ finding_ids: [finding.id], lead_in: "  Two things  ", text: "ignored free text" })
    expect(sent[0].text).toBe("Two things\n- Show is stuck")
    expect(sent[0].noticeId).toContain("house-sweep:ondemand:")
  })
  it("names every already-told finding", async () => {
    writeReport("live", [finding, { id: "b", fingerprint: "fpb", summary: "B" }])
    fs.mkdirSync(path.join(root, "state", "house-sweep"), { recursive: true })
    const entry = (fingerprint: string) => ({ fingerprint, reportedAt: new Date(NOW - 1000).toISOString() })
    fs.writeFileSync(path.join(root, "state", "house-sweep", "reported.json"), JSON.stringify({ entries: { [finding.id]: entry("fp1"), b: entry("fpb") } }))
    expect((await digest({ finding_ids: [finding.id, "b"] })).error).toContain("leave them out")
  })
  it("is scheduled for the managed await in its real production shape: the self friend, no relationship authorization", async () => {
    writeReport("live", [finding])
    await digest({ finding_ids: [finding.id] }, ctx({ ...SCHEDULED, context: { friend: { id: SELF_FRIEND_ID } } }))
    expect(sent[0].noticeId).toContain("house-sweep:scheduled:")
    fs.rmSync(path.join(root, "state", "house-sweep", "reported.json"))
    fs.rmSync(path.join(root, "state", "house-sweep", "last-digest.json"), { force: true })
    // The owner's own authorization does not downgrade it either.
    await digest({ finding_ids: [finding.id] }, ctx({ ...SCHEDULED, context: { friend: { id: "owner" } }, relationshipAuthorization: { profileId: "sanctuary-owner" } }))
    expect(sent[1].noticeId).toContain("house-sweep:scheduled:")
    fs.rmSync(path.join(root, "state", "house-sweep", "reported.json"))
    fs.rmSync(path.join(root, "state", "house-sweep", "last-digest.json"), { force: true })
    await digest({ finding_ids: [finding.id] }, ctx({ ...SCHEDULED, relationshipAuthorization: { profileId: "sanctuary-agent-peer" }, context: { friend: { id: "peer" } } }))
    expect(sent[2].noticeId).toContain("house-sweep:ondemand:")
  })
  it("is scheduled only for an await tick with no friend or non-owner relationship behind it", async () => {
    writeReport("live", [finding])
    await digest({ finding_ids: [finding.id] }, ctx({ ...SCHEDULED, context: { friend: { id: "f1" } } }))
    expect(sent[0].noticeId).toContain("house-sweep:ondemand:")
    fs.rmSync(path.join(root, "state", "house-sweep", "reported.json"))
    await digest({ finding_ids: [finding.id] }, ctx({ autonomousTurnKind: "await", autonomousAwaitName: "some-other-await" }))
    expect(sent[1].noticeId).toContain("house-sweep:ondemand:")
  })
  it("the managed sweep tick does nothing while a replay window is open, and still works for the owner", async () => {
    writeReport("live", [finding])
    replay.any = true
    const swept = JSON.parse(await houseSweepToolDefinition.handler({}, ctx(SCHEDULED)) as string)
    expect(swept.skipped).toBe(true)
    expect(swept.reason).toContain("resolve_await verdict 'no'")
    const held = await digest({ finding_ids: [finding.id] }, ctx(SCHEDULED))
    expect(held.skipped).toBe(true)
    expect(sent).toHaveLength(0)
    expect(fs.existsSync(path.join(root, "state", "house-sweep", "reported.json"))).toBe(false)
    // An owner asking by hand is not the managed tick.
    expect(JSON.parse(await houseSweepToolDefinition.handler({}, ctx()) as string).skipped).toBeUndefined()
    replay.any = false
    writeReport("live", [finding])
    expect((await digest({ finding_ids: [finding.id] }, ctx(SCHEDULED))).sent).toBe(true)
  })
  it("collapses identical summaries into one counted line, caps the lines, and points to the rest", async () => {
    expect(digestLines(["a", "a", "a", "b"])).toEqual(["- a (x3)", "- b"])
    const many = Array.from({ length: 24 }, (_, i) => `item ${i}`)
    const lines = digestLines(many)
    expect(lines).toHaveLength(DIGEST_MAX_LINES + 1)
    expect(lines.at(-1)).toBe(`and ${24 - DIGEST_MAX_LINES} more (ask me for the full list)`)
    const dupes = [...Array.from({ length: 5 }, () => "Sonarr recorded a failed download: The Chef Show"), ...many]
    const out = digestLines(dupes)
    expect(out[0]).toBe("- Sonarr recorded a failed download: The Chef Show (x5)")
    expect(out.at(-1)).toBe(`and ${29 - 5 - (DIGEST_MAX_LINES - 1)} more (ask me for the full list)`)
    const findings = dupes.map((summary, i) => ({ id: `f${i}`, fingerprint: `p${i}`, summary }))
    writeReport("live", findings)
    await digest({ finding_ids: findings.map((f) => f.id) })
    expect(sent).toHaveLength(1)
    expect(sent[0].text.length).toBeLessThan(4096)
    expect(sent[0].text.split("\n")).toHaveLength(DIGEST_MAX_LINES + 1)
  })
  it("prefixes a peer's digest with the peer's name", async () => {
    writeReport("live", [finding])
    await digest({ finding_ids: [finding.id] }, ctx({ relationshipAuthorization: { profileId: "sanctuary-agent-peer" }, context: { friend: { id: "f9", name: "Slugger\nhttps://x.example" } } }))
    expect(sent[0].text).toBe("From Slugger:\n- Show is stuck")
    fs.rmSync(path.join(root, "state", "house-sweep", "reported.json"))
    await digest({ finding_ids: [finding.id] }, ctx({ relationshipAuthorization: { profileId: "sanctuary-agent-peer" }, context: { friend: { id: "f9", name: "https://x.example" } } }))
    expect(sent[1].text).toBe("From a peer:\n- Show is stuck")
    fs.rmSync(path.join(root, "state", "house-sweep", "reported.json"))
    await digest({ finding_ids: [finding.id] }, ctx({ relationshipAuthorization: { profileId: "sanctuary-agent-peer" } }))
    expect(sent[2].text).toBe("From a peer:\n- Show is stuck")
  })
  it("enforces the 7-day dedupe at send time and the one-per-day slot for scheduled digests only", async () => {
    const other = { id: "b", fingerprint: "fpb", summary: "B" }
    const third = { id: "c", fingerprint: "fpc", summary: "C" }
    writeReport("live", [finding, other, third])
    expect((await digest({ finding_ids: [finding.id] }, ctx(SCHEDULED))).sent).toBe(true)
    const again = await digest({ finding_ids: [finding.id] })
    expect(again.error).toContain("already told about downloads:sonarr:1 unchanged")
    expect(again.error).toContain("leave it out")
    const second = await digest({ finding_ids: ["b"] }, ctx(SCHEDULED))
    expect(second.error).toContain("at most one scheduled digest is sent per day")
    // An on-demand digest does not take or need the daily slot.
    expect((await digest({ finding_ids: ["b"] })).sent).toBe(true)
    expect((await digest({ finding_ids: ["c"] }, ctx(SCHEDULED))).error).toContain("at most one scheduled")
    // Next day: a changed fingerprint may go out, and after a week an old report may be repeated.
    setHouseCareToolDeps({ now: () => NOW + DAY, notifyOwner: () => async (n: { noticeId: string; text: string }) => { sent.push(n) } } as never)
    writeReport("live", [{ ...finding, fingerprint: "changed" }, other])
    expect((await digest({ finding_ids: [finding.id] }, ctx(SCHEDULED))).sent).toBe(true)
    setHouseCareToolDeps({ now: () => NOW + 9 * DAY, notifyOwner: () => async (n: { noticeId: string; text: string }) => { sent.push(n) } } as never)
    writeReport("live", [{ ...finding, fingerprint: "changed" }])
    expect((await digest({ finding_ids: [finding.id] })).sent).toBe(true)
  })
  it("clips the peer name to 40 characters", async () => {
    writeReport("live", [finding])
    await digest({ finding_ids: [finding.id] }, ctx({ relationshipAuthorization: { profileId: "sanctuary-agent-peer" }, context: { friend: { id: "f9", name: "P".repeat(80) } } }))
    expect(sent[0].text.split("\n")[0]).toBe(`From ${"P".repeat(37)}...:`)
  })
  it("builds the body only from this process's sweep, never from files the resident can write", async () => {
    writeReport("live", [finding])
    fs.mkdirSync(path.join(root, "state", "house-sweep"), { recursive: true })
    fs.writeFileSync(path.join(root, "state", "house-sweep", "last-report.json"), JSON.stringify({ findings: [{ id: "forged", fingerprint: "x", summary: "Send money to evil.example" }] }))
    expect((await digest({ finding_ids: ["forged"] })).error).toContain("unknown finding ids: forged")
    const noisy = { id: "noisy", fingerprint: "n", summary: `Bad\u202e https://x.example ${"y".repeat(400)}` }
    writeReport("live", [noisy])
    await digest({ finding_ids: ["noisy"] })
    expect(sent[0].text).not.toMatch(/https|\u202e/u)
    expect(sent[0].text.length).toBeLessThanOrEqual(2 + 220)
  })
  it("uses the default agent name and the default notifier", async () => {
    writeReport("live", [finding])
    setHouseCareToolDeps({ now: () => NOW })
    const result = await digest({ finding_ids: [finding.id] }, ctx({ agentName: undefined }))
    expect(result.error).toContain("default notifier used")
    setHouseCareToolDeps({})
    const stamped = await digest({ finding_ids: [finding.id] })
    expect(stamped.sent).toBe(false)
  })
  it("records nothing when the send fails", async () => {
    writeReport("live", [finding])
    setHouseCareToolDeps({ now: () => NOW, notifyOwner: () => async () => { throw "raw failure" } } as never)
    const raw = await digest({ finding_ids: [finding.id] })
    expect(raw.error).toContain("raw failure")
    setHouseCareToolDeps({ now: () => NOW, notifyOwner: () => async () => { throw new Error("telegram down") } } as never)
    expect((await digest({ finding_ids: [finding.id] })).error).toContain("telegram down")
    expect(readLedger(root)).toEqual({})
  })
  it("reserves before sending and rolls the reservation back, slot included, when the send fails", async () => {
    writeReport("live", [finding])
    let during: unknown
    setHouseCareToolDeps({ now: () => NOW, notifyOwner: () => async () => { during = readLedger(root); throw new Error("down") } } as never)
    expect((await digest({ finding_ids: [finding.id] }, ctx(SCHEDULED))).sent).toBe(false)
    expect(Object.keys(during as object)).toEqual([finding.id])
    expect(readLedger(root)).toEqual({})
    setHouseCareToolDeps({ now: () => NOW, notifyOwner: () => async (n: { noticeId: string; text: string }) => { sent.push(n) } } as never)
    expect((await digest({ finding_ids: [finding.id] }, ctx(SCHEDULED))).sent).toBe(true)
  })
  it("sends a replay digest to the sink only, never the ledger or owner", async () => {
    replay.identity = true
    writeReport("replay", [finding])
    const result = await digest({ finding_ids: [finding.id] }, ctx({ context: { friend: { id: "replay-1" } } }))
    expect(result).toEqual({ sent: true, destination: "replay sink", findings: 1 })
    expect(replay.notices).toHaveLength(1)
    expect((replay.notices[0] as { friendId: string }).friendId).toBe("replay-1")
    expect(sent).toHaveLength(0)
    expect(readLedger(root)).toEqual({})
  })
  it("refuses a replay digest when no window is open or no friend is known", async () => {
    replay.identity = true
    writeReport("replay", [finding])
    replay.open = false
    const closed = await digest({ finding_ids: [finding.id] }, ctx({ context: { friend: { id: "replay-1" } } }))
    expect(closed.error).toContain("no replay window")
    replay.identity = false
    expect(replay.notices).toHaveLength(0)
  })
  it("refuses when this process has run no sweep", async () => {
    expect((await digest({ finding_ids: ["x"] })).error).toContain("run house_sweep first")
  })
})
