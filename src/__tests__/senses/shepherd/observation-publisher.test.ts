import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readMailboxSupervision } from "../../../heart/mailbox/mailbox-supervision"
import { createShepherdObservationPublisher } from "../../../senses/shepherd/observation-publisher"
import { appendReturn, returnsLogPath, type ReturnRecord } from "../../../senses/shepherd/returns"
import { enqueueNotice, declareNoticeTargets, recordNoticeDelivery } from "../../../senses/shepherd/notice-outbox"
import { checkInStorePath, openCheckInStore } from "../../../senses/shepherd/checkin-store"
import { updateShepherdMandate } from "../../../heart/shepherd/mandates"
import { setShepherdSessionPause } from "../../../senses/shepherd/guidance"
import { readCheckInSnapshot, reconcileShepherdDispatch } from "../../../senses/shepherd/recovery"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { ShepherdManagedIdentity } from "../../../heart/shepherd/custody-types"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), readSync: vi.fn(actual.readSync), renameSync: vi.fn(actual.renameSync) }
})

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
beforeEach(async () => {
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(actual.fstatSync)
  vi.mocked(fs.readSync).mockReset().mockImplementation(actual.readSync)
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync)
  vi.spyOn(Date, "now").mockReturnValue(now)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-observation-")))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe("sense-owned observation publisher", () => {
  it.each(["sent", "not_sent"] as const)("reports actual managed %s stages without calling them paste, Enter or task completion", state => {
    const identity: ShepherdManagedIdentity = {
      kind: "agent_session", hostInstance: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", surfaceId: "11111111-1111-4111-8111-111111111111",
      provider: "copilot", providerSessionId: "provider-session", backendPid: 314, backendStartSeconds: 12345,
      backendStartMicroseconds: 6789, surfaceGeneration: 7, executableSha256: "b".repeat(64), profileSha256: "a".repeat(64),
    }
    const instance = `agent_session:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`
    const store = openCheckInStore(checkInStorePath(root))
    try {
      const claim = store.claimDispatch({
        host: "cmux", session: identity.surfaceId, instance, screenFingerprint: "screen", guidanceRevision: "guidance",
        reply: "Continue authorized work.", trigger: "immediate", transition: "return", at: new Date(now).toISOString(),
        nativeTarget: { kind: "agent_session", identity },
      }, "worker")!
      store.completeDispatch(claim.id, "worker", { state, nativeRequestId: claim.nativeRequestId,
        receipt: { kind: "agent_session", receiptVersion: 1, requestId: claim.id, nativeRequestId: claim.nativeRequestId!,
          identity, editorInserted: state === "sent", backendWriteAdmitted: state === "sent",
          providerAcknowledged: state === "sent", providerInputId: state === "sent" ? "server-ack" : null } })
    } finally { store.close() }
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    expect(publisher.refresh()).toBe(true)
    const event = readMailboxSupervision("slugger", { agentRoot: root }).timeline.items.find(item => item.kind === (state === "sent" ? "input_admitted" : "observation"))
    expect(event?.summary).toBe(state === "sent"
      ? "Managed editor insertion, complete backend write and exact provider acknowledgement; not proof of task completion"
      : "Input refused; no managed editor insertion or backend input")
    expect(event?.summary).not.toMatch(/paste|Enter|submit key/i)
  })

  it("distinguishes absent host state, unavailable host state, and an idempotently stopped empty publisher", () => {
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    expect(publisher.refresh()).toBe(true)
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sessions.totalCount).toBeNull()
    expect(publisher.observe({ at: now, sessions: [], error: "host_unavailable" })).toBe(true)
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sourceErrors).toContainEqual(
      expect.objectContaining({ source: "host", code: "host_unavailable" }))
    const empty = createShepherdObservationPublisher({ agentRoot: root, agentName: "empty", host: "cmux" })
    empty.stop()
    empty.stop()
    expect(empty.refresh()).toBe(false)
    expect(readMailboxSupervision("empty", { agentRoot: root }).sourceErrors).toContainEqual(
      expect.objectContaining({ source: "host", code: "sense_stopped" }))
  })

  it("assesses active, ambiguous and paused stored policy without claiming effective enforcement", async () => {
    const context = (requestId: string) => ({ kind: "local_owner_administration" as const, actorId: "owner", requestId })
    const target = { host: "cmux", session: session.id, cwd: root, task: null }
    await updateShepherdMandate(root, {
      operation: "grant", expectedRevision: 0, context: context("broad"), target: { project: root },
      task: "Finish approved tests", expiresAt: new Date(now + 60_000).toISOString(),
    })
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    const observe = () => publisher.observe({ at: now, sessions: [{ session: { ...session, cwd: root }, activity: "idle", observedAt: now }] })
    observe()
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({ authority: "active", capability: "unsupported" })
    await updateShepherdMandate(root, {
      operation: "grant", expectedRevision: 1, context: context("specific"),
      target: { project: root, host: "cmux", session: session.id, instance: session.instance },
      task: "Finish approved tests", expiresAt: new Date(now + 60_000).toISOString(),
    })
    observe()
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({
      authority: "ambiguous", withheldReason: expect.stringContaining("Multiple stored mandates"),
    })
    await setShepherdSessionPause(root, { actorId: "owner", requestId: "pause", expectedRevision: 0, target, paused: true }, [target])
    observe()
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({
      authority: "paused", withheldReason: "Stored terminal pause is set",
    })
  })

  it("retains no current policy assessment when either policy source is corrupt", () => {
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    publisher.refresh()
    const directory = path.join(root, "state/senses/shepherd")
    fs.writeFileSync(path.join(directory, "guidance.json"), "{", { mode: 0o600 })
    fs.writeFileSync(path.join(directory, "mandates.json"), "{", { mode: 0o600 })
    fs.writeFileSync(path.join(directory, "notice-outbox.json"), "{", { mode: 0o600 })
    fs.mkdirSync(path.dirname(checkInStorePath(root)), { mode: 0o700 })
    fs.writeFileSync(checkInStorePath(root), "not a database", { mode: 0o600 })
    expect(publisher.observe({ at: now, sessions: [{ session, activity: "idle", observedAt: now }] })).toBe(true)
    const view = readMailboxSupervision("slugger", { agentRoot: root })
    expect(view.sourceHealth).toMatchObject({ guidance: "error", mandates: "error", notices: "error", custody: "error" })
    expect(view.sessions.items[0].authority).toBe("unknown")
  })

  it("normalizes absent identities, blank labels and tied judgments without leaking controls", () => {
    appendReturn(root, record)
    appendReturn(root, { ...record, transition: "stop:2", kind: "working", action: "respond" })
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    const bare = { ...session, id: "other", title: "", ref: "", cwd: null, instance: null, agent: null }
    expect(publisher.observe({ at: now, sessions: [
      { session: bare, activity: "shell", observedAt: null },
      { session: { ...bare, id: " ", ref: " " }, activity: "shell", observedAt: now },
      { session: { ...session, title: "", instance: undefined }, activity: "idle", observedAt: now },
    ] })).toBe(true)
    const view = readMailboxSupervision("slugger", { agentRoot: root })
    expect(view.sessions.items[0]).toMatchObject({ label: "other", project: null, instance: null, harness: null, authority: "unknown" })
    expect(view.sessions.items[1].label).toBe("(unnamed)")
    expect(view.sessions.items[2].label).toBe(session.ref)
    const count = view.timeline.totalCount
    publisher.observe({ at: now, sessions: [{ session: bare, activity: "shell", observedAt: null }] })
    expect(readMailboxSupervision("slugger", { agentRoot: root }).timeline.totalCount).toBe(count)
  })

  it.each([
    null, { ...record, at: "not a date" }, { ...record, host: "" }, { ...record, session: "" }, { ...record, transition: "" },
    { ...record, kind: "invented" }, { ...record, action: "invented" }, { ...record, reason: 7 },
    ...["at", "host", "session", "transition", "kind"].map(key => ({ ...record, [key]: null })),
  ])("marks malformed returns unavailable rather than healthy empty history: %j", input => {
    appendReturn(root, record)
    fs.writeFileSync(returnsLogPath(root), `${JSON.stringify(input)}\n`)
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    expect(publisher.refresh()).toBe(true)
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sourceHealth.returns).toBe("error")
  })

  it.each(["hardlink", "directory", "oversized", "changed", "growth"] as const)("rejects an unsafe %s returns source", async fault => {
    appendReturn(root, record)
    const file = returnsLogPath(root)
    if (fault === "hardlink") fs.linkSync(file, `${file}.link`)
    else if (fault === "directory") { fs.renameSync(file, `${file}.saved`); fs.mkdirSync(file) }
    else if (fault === "oversized") fs.writeFileSync(file, " ".repeat(2 * 1024 * 1024 + 1))
    else if (fault === "growth") vi.mocked(fs.readSync).mockImplementation(() => 2 * 1024 * 1024 + 1)
    else {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
      vi.mocked(fs.fstatSync).mockImplementation(fd => { const stat = actual.fstatSync(fd); stat.ino++; return stat })
    }
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    expect(publisher.refresh()).toBe(true)
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync)
    vi.mocked(fs.readSync).mockImplementation(actual.readSync)
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sourceHealth.returns).toBe("error")
  })

  it.each(["invalid", "oversized", "write", "assembly"] as const)("refuses %s publication without refreshing the last good replica", fault => {
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    publisher.refresh()
    const file = path.join(root, "state/senses/shepherd/supervision-observation.json")
    const before = fs.readFileSync(file)
    if (fault === "write") vi.mocked(fs.renameSync).mockImplementation(() => { throw new Error("synthetic rename failure") })
    const oversized = "x".repeat(2000)
    const failing = createShepherdObservationPublisher({
      agentRoot: root, agentName: fault === "invalid" ? "" : "slugger",
      host: fault === "oversized" ? oversized : "cmux", now: () => fault === "assembly" ? NaN : now,
    })
    const result = fault === "oversized" ? failing.observe({
      at: now, sessions: Array.from({ length: 200 }, (_, index) => ({
        session: { ...session, id: `${index}${oversized}`, title: oversized, cwd: oversized, agent: oversized, instance: oversized },
        activity: "idle", observedAt: now,
      })),
    }) : failing.refresh()
    expect(result).toBe(false)
    expect(fs.readFileSync(file)).toEqual(before)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.shepherd_observation_failed" }))
  })

  it("reports refused input, reconciled history and pending versus unknown owner deliveries separately", async () => {
    const store = openCheckInStore(checkInStorePath(root))
    let id: string
    try {
      const claim = store.claimDispatch({
        host: "cmux", session: "SF-1", instance: null, screenFingerprint: "screen", guidanceRevision: "0",
        reply: "Continue", trigger: "immediate", transition: "stop", at: record.at,
      }, "owner")!
      id = claim.id
      store.completeDispatch(id, "owner", { state: "unknown", reason: "unconfirmed" })
      const refused = store.claimDispatch({
        host: "cmux", session: "other", instance: null, screenFingerprint: "screen", guidanceRevision: "0",
        reply: "Continue", trigger: "immediate", transition: "stop", at: record.at,
      }, "owner")!
      store.completeDispatch(refused.id, "owner", { state: "not_sent" })
    } finally { store.close() }
    await reconcileShepherdDispatch(root, {
      id, expectedRevision: readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).revision!,
      requestId: "retire", actor: { kind: "local_owner_administration", actorId: "owner" },
      evidence: { kind: "host_process_inventory", host: "cmux", session: "SF-1", instance: null, checkedAt: record.at, gone: true, wholeSessionRetired: true },
    })
    const noticeId = await enqueueNotice(root, record)
    await declareNoticeTargets(root, [noticeId], ["pending", "unknown"], record.at)
    await recordNoticeDelivery(root, [noticeId], "unknown", { state: "unknown", at: record.at })
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    expect(publisher.refresh()).toBe(true)
    const view = readMailboxSupervision("slugger", { agentRoot: root })
    expect(view.timeline.items.map(event => event.kind)).toEqual(expect.arrayContaining(["recovery", "observation", "notification_unknown", "notification_queued"]))
    expect(view.timeline.items).toContainEqual(expect.objectContaining({ summary: "Input refused; no terminal input" }))
  })

  it("marks timeline totals unknown when custody has an undisplayed page", () => {
    const store = openCheckInStore(checkInStorePath(root))
    try {
      for (let index = 0; index < 201; index++) store.claimDispatch({
        host: "cmux", session: `terminal-${index}`, instance: null, screenFingerprint: "screen", guidanceRevision: "0",
        reply: "Continue", trigger: "immediate", transition: "stop", at: record.at,
      }, "owner")
    } finally { store.close() }
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux" })
    expect(publisher.refresh()).toBe(true)
    expect(readMailboxSupervision("slugger", { agentRoot: root }).timeline).toMatchObject({ totalCount: null, truncated: true })
  })

  it("never upgrades a legacy sent report into bound native admission evidence", () => {
    const store = openCheckInStore(checkInStorePath(root))
    const ids: string[] = []
    try {
      for (const qualified of [false, true]) {
        const sessionId = qualified ? "bound-terminal" : "legacy-terminal"
        const claim = store.claimDispatch({
          host: "cmux", session: sessionId, instance: session.instance, screenFingerprint: "screen",
          guidanceRevision: "0", reply: "Continue.", trigger: "immediate", transition: sessionId, at: record.at,
        }, "owner")!
        ids.push(claim.id)
        store.completeDispatch(claim.id, "owner", {
          state: "sent", ...(qualified ? { receipt: {
            requestId: claim.id, surfaceId: sessionId, workspaceId: "workspace-1", processInstance: session.instance,
            pasteAdmitted: true, submitAdmitted: true,
          } } : {}),
        })
      }
    } finally { store.close() }
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => now })
    publisher.observe({ at: now, sessions: [{ session, activity: "idle", observedAt: now }] })
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.timeline.items.find(event => event.id === `input:${ids[0]}`))
      .toMatchObject({ kind: "legacy_input_reported", summary: expect.stringContaining("no qualified") })
    expect(view.timeline.items.find(event => event.id === `input:${ids[1]}`)).toMatchObject({ kind: "input_admitted" })
  })

  it("publishes private whitelisted rows from the existing host observation without storing screens or replies", () => {
    appendReturn(root, record)
    const publisher = createShepherdObservationPublisher({ agentRoot: root, agentName: "slugger", host: "cmux", now: () => now })
    expect(publisher.observe({ at: now, sessions: [{ session, activity: "idle", observedAt: now }] })).toBe(true)
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.counts?.idle).toBe(1)
    expect(view.sessions.items[0]).toMatchObject({
      session: "SF-1", instance: "process:1:2", label: "token=[redacted]",
      lastDecisionLabel: "Agent reports finished", authority: "absent", capability: "unsupported",
      lastAction: "let_through", lastReason: "token=[redacted]", lastActionAt: record.at,
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
