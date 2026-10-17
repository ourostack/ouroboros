import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readMailboxSupervision } from "../../../heart/mailbox/mailbox-supervision"
import { createShepherdObservationPublisher } from "../../../senses/shepherd/observation-publisher"
import { appendReturn, returnsLogPath, type ReturnRecord } from "../../../senses/shepherd/returns"
import { enqueueNotice, declareNoticeTargets, recordNoticeDelivery } from "../../../senses/shepherd/notice-outbox"
import { checkInStorePath, openCheckInStore } from "../../../senses/shepherd/checkin-store"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

const now = Date.parse("2026-10-17T20:00:00.000Z")
let root: string
const session = {
  id: "SF-1", ref: "surface:1", workspace: "workspace:1", title: "token=synthetic-secret",
  agent: "Copilot", cwd: "/synthetic/project", instance: "process:1:2", focused: false,
}
const record: ReturnRecord = {
  at: new Date(now).toISOString(), host: "cmux", session: "SF-1", transition: "stop:1",
  agent: "Copilot", cwd: "/synthetic/project", task: "test task", kind: "done",
  action: "let_through", reason: "token=synthetic-secret", reply: null, latencyMs: 1, inputTokens: 1,
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-observation-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe("sense-owned observation publisher", () => {
  it("publishes private whitelisted rows from the existing host observation without storing screens or replies", () => {
    appendReturn(root, record)
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => now })
    expect(publisher.observe({ at: now, sessions: [{ session, activity: "idle", observedAt: now }] })).toBe(true)
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.counts?.idle).toBe(1)
    expect(view.sessions.items[0]).toMatchObject({
      session: "SF-1", instance: "process:1:2", label: "token=[redacted]",
      lastDecisionLabel: "Agent reports finished", authority: "absent", capability: "unsupported",
    })
    expect(view.timeline.items).toContainEqual(expect.objectContaining({ kind: "judgment", summary: "Agent reports finished" }))
    const file = path.join(root, "state/senses/shepherd/supervision-observation.json")
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(file, "utf8")).not.toContain("synthetic-secret")
    expect(fs.readFileSync(file, "utf8")).not.toContain('"reply"')
  })

  it("includes unreadable terminals once, with unknown observation rather than dropping them", () => {
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => now })
    publisher.observe({ at: now, sessions: [{ session, activity: "unknown", observedAt: null, error: "read_failed" }] })
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.sessions.items).toHaveLength(1)
    expect(view.counts).toEqual({ working: 0, idle: 0, shell: 0, unknown: 1 })
    expect(view.sourceErrors).toContainEqual(expect.objectContaining({ source: "host", code: "row_read_failed" }))
  })

  it("preserves known history when the canonical returns source fails and does not refresh old observations", () => {
    appendReturn(root, record)
    let clock = now
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => clock })
    publisher.observe({ at: now, sessions: [{ session, activity: "idle", observedAt: now }] })
    fs.appendFileSync(returnsLogPath(root), "{broken\n")
    clock += 40_000
    publisher.refresh()
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: clock })
    expect(view.sourceHealth.returns).toBe("error")
    expect(view.freshness.status).toBe("stale")
    expect(view.timeline.items.some(event => event.kind === "judgment")).toBe(true)
    expect(view.sessions.items[0].authority).toBe("unknown")
  })

  it("separates held input claims and transport acceptances from judgments", async () => {
    appendReturn(root, record)
    const store = openCheckInStore(checkInStorePath(root))
    const claim = store.claimDispatch({
      host: "cmux", session: "SF-1", instance: session.instance, screenFingerprint: "screen-hash",
      guidanceRevision: "0", reply: "private reply", trigger: "immediate", transition: "stop:1", at: record.at,
    }, "owner")
    expect(claim).not.toBeNull()
    store.close()
    const noticeId = await enqueueNotice(root, record)
    await declareNoticeTargets(root, [noticeId], ["private-recipient"], record.at)
    await recordNoticeDelivery(root, [noticeId], "private-recipient", { state: "sent", at: record.at })
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => now })
    publisher.observe({ at: now, sessions: [{ session, activity: "idle", observedAt: now }] })
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.custody.claims.items[0]).toMatchObject({ id: claim!.id, state: "claimed" })
    expect(view.custody.revision).toBeGreaterThanOrEqual(1)
    expect(view.timeline.items.map(event => event.kind)).toEqual(expect.arrayContaining([
      "judgment", "input_unknown", "notification_queued", "notification_delivered",
    ]))
    expect(JSON.stringify(view)).not.toMatch(/private-recipient|private reply|synthetic-secret/)
  })

  it("bounds a large inventory and records the exact undisplayed total", () => {
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => now })
    publisher.observe({ at: now, sessions: Array.from({ length: 220 }, (_, index) => ({
      session: { ...session, id: `SF-${index}` }, activity: "idle", observedAt: now,
    })) })
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.sessions).toMatchObject({ totalCount: 220, truncated: true })
    expect(view.sessions.items).toHaveLength(200)
    expect(view.counts?.idle).toBe(200)
  })

  it("marks stopped observation unavailable and ignores late callbacks", () => {
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => now })
    publisher.observe({ at: now, sessions: [{ session, activity: "idle", observedAt: now }] })
    publisher.stop()
    expect(publisher.observe({ at: now + 1, sessions: [] })).toBe(false)
    expect(publisher.refresh()).toBe(false)
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.counts).toBeNull()
    expect(view.sessions.items).toHaveLength(1)
    expect(view.sourceErrors).toContainEqual(expect.objectContaining({ code: "sense_stopped" }))
  })
})
