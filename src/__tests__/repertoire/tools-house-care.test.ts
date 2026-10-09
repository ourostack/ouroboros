import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const replay = vi.hoisted(() => ({ identity: false, open: true, notices: [] as unknown[] }))
vi.mock("../../a2a/replay-harness", () => ({
  isReplayIdentity: () => replay.identity,
  isReplayWindowOpen: () => replay.open,
  appendReplayNotice: (_root: string, notice: unknown) => { replay.notices.push(notice) },
}))
vi.mock("../../heart/awaiting/a2a-await-delivery", () => ({ defaultNotifyOwner: () => async () => { throw new Error("default notifier used") } }))

import { DIGEST_MAX_CHARS, houseCareToolDefinitions, houseDigestToolDefinition, houseSweepToolDefinition, setHouseCareToolDeps } from "../../repertoire/tools-house-care"
import { lastReportPath, readLedger } from "../../repertoire/house-sweep"
import type { ToolContext } from "../../repertoire/tools-base"

let root: string
const NOW = Date.parse("2026-10-09T12:00:00.000Z")
const sent: { noticeId: string; text: string }[] = []

const ctx = (over: Record<string, unknown> = {}): ToolContext => ({ agentRoot: root, agentName: "sanctuary", ...over }) as unknown as ToolContext
const writeReport = (scope: "live" | "replay", findings: unknown[]) => {
  fs.mkdirSync(path.dirname(lastReportPath(root, scope)), { recursive: true })
  fs.writeFileSync(lastReportPath(root, scope), JSON.stringify({ findings }))
}
const digest = (args: Record<string, unknown>, c = ctx()) => houseDigestToolDefinition.handler(args as never, c).then((r) => JSON.parse(r as string))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "house-care-"))
  replay.identity = false
  replay.open = true
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
    const unknown = await digest({ finding_ids: ["x"] })
    expect(unknown.error).toContain("unknown finding ids: x")
    expect(sent).toHaveLength(0)
  })
  it("refuses over-long text", async () => {
    writeReport("live", [finding])
    const result = await digest({ finding_ids: [finding.id], text: "x".repeat(DIGEST_MAX_CHARS + 1) })
    expect(result.error).toContain("too long")
    expect(sent).toHaveLength(0)
  })
  it("sends a scheduled digest, records the ledger, and dedupes ids", async () => {
    writeReport("live", [finding])
    const result = await digest({ finding_ids: [finding.id, finding.id] }, ctx({ autonomousTurnKind: "await" }))
    expect(result).toEqual({ sent: true, destination: "owner", findings: 1 })
    expect(sent[0].text).toBe("- Show is stuck")
    expect(sent[0].noticeId).toMatch(/^house-sweep:scheduled:2026-10-09:[0-9a-f]{12}$/u)
    expect(readLedger(root)[finding.id].fingerprint).toBe("fp1")
  })
  it("sends supplied text on demand", async () => {
    writeReport("live", [finding])
    await digest({ finding_ids: [finding.id], text: "  Plain version  " })
    expect(sent[0].text).toBe("Plain version")
    expect(sent[0].noticeId).toContain("house-sweep:ondemand:")
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
  it("treats a missing last report as no known findings", async () => {
    expect((await digest({ finding_ids: ["x"] })).error).toContain("unknown finding ids")
  })
})
