import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FriendRecord } from "@ouro.bot/friends"
import type { HostSession, ShepherdHost } from "../../../senses/shepherd/host"
import { openFeedbackStore, type FeedbackStore } from "../../../senses/shepherd/feedback-store"
import { executeFeedbackCommand, shepherdFeedbackStatus, submitShepherdFeedback, type FeedbackSubmitDeps } from "../../../senses/shepherd/feedback-submit"
import * as surface from "../../../senses/shepherd/surface"
import { getAgentRoot, resetIdentity } from "../../../heart/identity"
import { feedbackStorePath } from "../../../senses/shepherd/feedback-store"

const opened: FeedbackStore[] = []
afterEach(() => { for (const store of opened.splice(0)) store.close() })
const source = { id: "11111111-1111-4111-8111-111111111111", ref: "surface:1", workspace: "workspace:1",
  title: "Implement the task", agent: "Copilot", cwd: "/project", tty: "/dev/ttys001", focused: true }
const friend: FriendRecord = {
  id: "owner", name: "Owner", role: "friend", trustLevel: "family", connections: [],
  externalIds: [{ provider: "aad", externalId: "owner-aad", tenantId: "owner-tenant", linkedAt: "2026-10-15" }],
  tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-10-15", updatedAt: "2026-10-15", schemaVersion: 1,
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-submit-"))
  const store = openFeedbackStore(path.join(root, "feedback", "queue.sqlite"))
  opened.push(store)
  let sessions: HostSession[] = [source]
  let owner = friend
  let screen = "Plan written. Want me to proceed?"
  let unavailable = false
  const actions: string[] = []
  const host: ShepherdHost = {
    name: "cmux",
    list: async () => { if (unavailable) throw new Error("host unavailable"); return sessions },
    read: async id => { actions.push(`read:${id}`); return screen },
    prompt: async () => { actions.push("FORBIDDEN prompt") },
    key: async () => { actions.push("FORBIDDEN key") },
    signal: async () => { actions.push("FORBIDDEN signal") },
    watch: () => ({ close() {} }),
  }
  const deps: FeedbackSubmitDeps = {
    agentRoot: root, store, host: () => host, friendStore: { get: async () => owner },
    resolveOwner: async () => "owner",
    presentation: () => ({ name: "Orchid One", aliases: ["Orchid One", "orchid"] }),
    returns: () => [],
    now: () => "2026-10-15T20:00:00.000Z",
  }
  const request = { agent: "orchid", friendId: "owner", origin: { tty: "/dev/ttys001" },
    submission: { requestId: randomUUID(), feedback: "You should have caught this.", context: "The plan isn't the deliverable." } }
  return { deps, request, store, actions,
    sessions: (next: HostSession[]) => { sessions = next },
    friend: (next: FriendRecord) => { owner = next },
    screen: (next: string) => { screen = next },
    unavailable: () => { unavailable = true },
  }
}

describe("bound native feedback submission", () => {
  it("uses the actual configured-owner/default-store composition without a model or real user state", async () => {
    const fixture = setup()
    const previous = process.env.HOME
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-feedback-home-"))
    process.env.HOME = home
    resetIdentity()
    const host = vi.spyOn(surface, "machineShepherdHost").mockReturnValue(fixture.deps.host())
    try {
      const root = getAgentRoot("orchid")
      fs.mkdirSync(path.join(root, "friends"), { recursive: true })
      fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ displayName: "Orchid One" }))
      fs.writeFileSync(path.join(root, "friends", "owner.json"), JSON.stringify({
        ...friend, externalIds: [...friend.externalIds, { provider: "local", externalId: os.userInfo().username, linkedAt: "2026-10-15" }],
      }))
      const accepted = await executeFeedbackCommand({ kind: "agent.shepherdFeedback", ...fixture.request })
      expect(accepted.ok).toBe(true)
      expect(accepted.message).toContain("Orchid One")
      expect(fs.existsSync(feedbackStorePath(root))).toBe(true)
      const status = await executeFeedbackCommand({ kind: "agent.shepherdFeedbackStatus", agent: "orchid", friendId: "owner",
        requestId: fixture.request.submission.requestId })
      expect(status).toMatchObject({ ok: true, data: { review: "pending", delivery: "pending" } })
      expect(fixture.actions).toEqual([`read:${source.id}`])
      const missing = await executeFeedbackCommand({ kind: "agent.shepherdFeedbackStatus", agent: "orchid", friendId: "owner", requestId: randomUUID() })
      expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("unknown request") })
      const absent = await executeFeedbackCommand({ kind: "agent.shepherdFeedbackStatus", agent: "other", friendId: "owner", requestId: randomUUID() })
      expect(absent.ok).toBe(false)
      expect(fs.existsSync(feedbackStorePath(getAgentRoot("other")))).toBe(false)
    } finally {
      host.mockRestore()
      if (previous === undefined) delete process.env.HOME
      else process.env.HOME = previous
      resetIdentity()
    }
  })

  it("binds context to the caller's own TTY, not the selected GUI terminal, and returns only a small receipt", async () => {
    const fixture = setup()
    fixture.sessions([source, { ...source, id: "22222222-2222-4222-8222-222222222222", tty: "/dev/ttys002", selected: true }])
    const receipt = await submitShepherdFeedback(fixture.request, fixture.deps)
    expect(receipt.receipt).toContain("Orchid One")
    expect(receipt.receipt).toContain("Teams")
    expect(receipt.state).toBe("pending")
    const stored = fixture.store.read(receipt.id, "owner")!
    expect(stored.source).toMatchObject({ id: source.id, tty: "/dev/ttys001", cwd: "/project" })
    expect(stored.recipient).toEqual({ friendId: "owner", aadObjectId: "owner-aad", tenantId: "owner-tenant" })
    expect(stored.packet.screen).toContain("Plan written")
    expect(fixture.actions).toEqual([`read:${source.id}`])
    expect(JSON.stringify(receipt)).not.toContain("Plan written")
  })

  it("returns the original receipt without touching a now-unavailable host or recapturing changed evidence", async () => {
    const fixture = setup()
    const original = await submitShepherdFeedback(fixture.request, fixture.deps)
    fixture.unavailable()
    fixture.screen("different evidence")
    expect(await submitShepherdFeedback(fixture.request, fixture.deps)).toEqual(original)
    expect(fixture.actions).toHaveLength(1)
    await expect(submitShepherdFeedback({
      ...fixture.request, submission: { ...fixture.request.submission, feedback: "different instruction" },
    }, fixture.deps)).rejects.toThrow("different")
  })

  it("redacts untrusted evidence without claiming a historical judgment exists", async () => {
    const fixture = setup()
    fixture.screen(`failure token=abc123secret\n\u001b[31mretrying`)
    const receipt = await submitShepherdFeedback(fixture.request, fixture.deps)
    const packet = fixture.store.read(receipt.id, "owner")!.packet
    expect(packet.screen).not.toContain("abc123secret")
    expect(packet.screen).not.toContain("\u001b")
    expect(packet.previousReturn).toBeNull()
  })

  it("refuses a mismatched local identity before reading any terminal", async () => {
    const fixture = setup()
    await expect(submitShepherdFeedback({ ...fixture.request, friendId: "someone-else" }, fixture.deps)).rejects.toThrow("local")
    expect(fixture.actions).toEqual([])
  })

  it.each([
    { label: "missing", sessions: [] },
    { label: "ambiguous", sessions: [source, { ...source, id: "22222222-2222-4222-8222-222222222222" }] },
    { label: "plain shell", sessions: [{ ...source, agent: null }] },
  ])("refuses a $label source rather than guessing another session", async ({ sessions }) => {
    const fixture = setup()
    fixture.sessions(sessions)
    await expect(submitShepherdFeedback(fixture.request, fixture.deps)).rejects.toThrow("terminal")
    expect(fixture.actions).toEqual([])
  })

  it("does not accept a promise of Teams follow-up without a unique existing family Teams identity", async () => {
    const fixture = setup()
    for (const replacement of [
      { ...friend, trustLevel: "stranger" as const },
      { ...friend, admissionState: "revoked" as const },
      { ...friend, externalIds: [] },
      { ...friend, externalIds: [...friend.externalIds, { provider: "aad" as const, externalId: "another", tenantId: "another", linkedAt: "2026-10-15" }] },
    ]) {
      fixture.friend(replacement)
      await expect(submitShepherdFeedback(fixture.request, fixture.deps)).rejects.toThrow()
      expect(fixture.store.pending()).toEqual([])
    }
  })

  it("reports lookup/authority/status failures without fabricating acceptance or leaking raw credentials", async () => {
    const fixture = setup()
    await expect(shepherdFeedbackStatus({ agent: "orchid", friendId: "owner", requestId: "bad" }, fixture.deps)).rejects.toThrow("ID")
    await expect(shepherdFeedbackStatus({ agent: "orchid", friendId: "other", requestId: randomUUID() }, fixture.deps)).rejects.toThrow("local")
    await expect(shepherdFeedbackStatus({ agent: "orchid", friendId: "owner", requestId: randomUUID() }, fixture.deps)).rejects.toThrow("unknown")
    fixture.deps.resolveOwner = async () => { throw "token=abc123secret" }
    const failed = await executeFeedbackCommand({ kind: "agent.shepherdFeedback", ...fixture.request }, fixture.deps)
    expect(failed.ok).toBe(false)
    expect(failed.error).not.toContain("abc123secret")
    expect(failed.error).toContain("original request status")
  })

  it("keeps a genuine previous judgment historical and binds only its actual current project", async () => {
    const fixture = setup()
    fixture.sessions([{ ...source, tty: "ttys001", workspaceTitle: "Work" }])
    fixture.deps.returns = () => [{
      at: "2026-10-15T19:00:00.000Z", host: "cmux", session: source.id, transition: "turn-1",
      agent: "Copilot", cwd: "/project", task: "track/task", kind: "done", action: "let_through",
      reason: "It said it was done.", reply: null, latencyMs: 1, inputTokens: 1,
    }]
    const result = await submitShepherdFeedback(fixture.request, fixture.deps)
    expect(fixture.store.read(result.id, "owner")).toMatchObject({
      source: { task: "track/task" }, packet: { previousReturn: { transition: "turn-1", kind: "done" } },
    })
  })

  it("refuses unsupported hosts, invalid origins, untrusted metadata and oversized evidence before persistence", async () => {
    const fixture = setup()
    await expect(submitShepherdFeedback({ ...fixture.request, origin: { tty: "/elsewhere" } }, fixture.deps)).rejects.toThrow("origin")
    const host = fixture.deps.host()
    fixture.deps.host = () => ({ ...host, name: "herdr" })
    await expect(submitShepherdFeedback(fixture.request, fixture.deps)).rejects.toThrow("unsupported")
    fixture.deps.host = () => host
    fixture.sessions([{ ...source, cwd: "/project/token=abc123secret" }])
    await expect(submitShepherdFeedback(fixture.request, fixture.deps)).rejects.toThrow("metadata")
    fixture.sessions([source])
    fixture.screen("界".repeat(10_000))
    await expect(submitShepherdFeedback(fixture.request, fixture.deps)).rejects.toThrow("byte limit")
    expect(fixture.store.pending()).toEqual([])
  })

  it("rejects malformed submission fields before accessing a host or private store", async () => {
    const fixture = setup()
    for (const submission of [
      { ...fixture.request.submission, requestId: "not-a-UUID" },
      { ...fixture.request.submission, feedback: "" },
      { ...fixture.request.submission, feedback: "x".repeat(2001) },
      { ...fixture.request.submission, context: "x".repeat(9000) },
      { ...fixture.request.submission, target: "a-model-selected-terminal" },
    ]) {
      await expect(submitShepherdFeedback({ ...fixture.request, submission }, fixture.deps)).rejects.toThrow("invalid")
    }
    await expect(submitShepherdFeedback({ ...fixture.request, friendId: "self" }, fixture.deps)).rejects.toThrow("local")
    expect(fixture.actions).toEqual([])
  })
})
