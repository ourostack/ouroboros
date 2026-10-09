import * as fs from "node:fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args) }))

let agentRoot = ""
vi.mock("../../../heart/identity", () => ({ getAgentRoot: () => agentRoot }))

const mockSendTelegramOwnerNotice = vi.fn()
vi.mock("../../../senses/telegram", () => ({ sendTelegramOwnerNotice: (...args: any[]) => mockSendTelegramOwnerNotice(...args) }))

import { FileFriendStore } from "@ouro.bot/friends"
import { mockOwners } from "../../test-helpers/replay-owners"
import { replaySinkPath, replayWindowPath } from "../../../a2a/replay-harness"
import { FileOutboxStore } from "../../../a2a/outbox-store"
import { createA2AAwaitOwnerDeliverer } from "../../../heart/awaiting/a2a-await-delivery"

const request = { friendId: "peer", channel: "a2a", key: "conv-1", content: "release landed", requestId: "req-1", deliveryId: "await:release:resolved", intent: "generic_outreach" as const }

describe("A2A await owner delivery", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-await-delivery-"))
    await new FileFriendStore(path.join(agentRoot, "friends")).put("peer", { id: "peer", name: "Claude Code", trustLevel: "family", admissionState: "active", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", schemaVersion: 1 } as any)
  })
  afterEach(() => fs.rmSync(agentRoot, { recursive: true, force: true }))

  it("tells the owner as the agent, naming the peer and keyed by the delivery id", async () => {
    const notify = vi.fn(async () => undefined)
    await expect(createA2AAwaitOwnerDeliverer("sanctuary", notify)(request)).resolves.toMatchObject({ status: "delivered_now" })
    expect(notify).toHaveBeenCalledWith({ noticeId: "await:release:resolved", text: "Follow-up on a request from Claude Code: release landed" })
  })

  it("addresses the owner directly for a question, pointing at the request it is about", async () => {
    const notify = vi.fn(async () => undefined)
    await createA2AAwaitOwnerDeliverer("sanctuary", notify)({ ...request, content: "Keep waiting?\n\n- yes\n- no", noticeKind: "asked_owner" })
    expect(notify).toHaveBeenCalledWith({ noticeId: "await:release:resolved", text: "Keep waiting?\n\n- yes\n- no\n\n(about the request from Claude Code)" })
  })

  it("still tells the owner when the peer record is gone", async () => {
    const notify = vi.fn(async () => undefined)
    await createA2AAwaitOwnerDeliverer("sanctuary", notify)({ ...request, friendId: "gone" })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("a connected agent") }))
  })

  it.each([undefined, "x".repeat(513)])("blocks a delivery without a usable delivery id (%#)", async (deliveryId) => {
    const notify = vi.fn(async () => undefined)
    await expect(createA2AAwaitOwnerDeliverer("sanctuary", notify)({ ...request, deliveryId })).resolves.toMatchObject({ status: "blocked" })
    expect(notify).not.toHaveBeenCalled()
  })

  it.each([new Error("telegram down"), "plain failure"])("reports a failed owner notice and logs it (%#)", async (failure) => {
    const notify = vi.fn(async () => { throw failure })
    await expect(createA2AAwaitOwnerDeliverer("sanctuary", notify)(request)).resolves.toEqual({ status: "failed", detail: failure instanceof Error ? failure.message : failure })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.await_a2a_owner_notice_error", level: "error" }))
  })

  it("defaults to the Telegram owner notice with a timeout", async () => {
    mockSendTelegramOwnerNotice.mockResolvedValue(undefined)
    await expect(createA2AAwaitOwnerDeliverer("sanctuary")(request)).resolves.toMatchObject({ status: "delivered_now" })
    expect(mockSendTelegramOwnerNotice).toHaveBeenCalledWith("sanctuary", expect.objectContaining({ noticeId: "await:release:resolved", signal: expect.any(AbortSignal) }))
  })

  describe("plain peer awaits (no request id)", () => {
    const plainRequest = { friendId: "peer", channel: "a2a", key: "conv-1", content: "release landed", deliveryId: "await:release:resolved", intent: "generic_outreach" as const }

    it("posts the outcome to the peer's own outbox and leaves the owner alone", async () => {
      const notify = vi.fn(async () => undefined)
      await expect(createA2AAwaitOwnerDeliverer("sanctuary", notify)(plainRequest)).resolves.toEqual({ status: "delivered_now", detail: "posted to the peer's outbox" })
      expect(notify).not.toHaveBeenCalled()
      expect(new FileOutboxStore(agentRoot).list("peer").entries).toMatchObject([{ kind: "await_outcome", body: "release landed", meta: { outcome: "follow_up", dedupeKey: "await:release:resolved" } }])
      expect(new FileOutboxStore(agentRoot).list("someone-else").entries).toEqual([])
    })

    it("does not double-post when the same delivery is retried", async () => {
      const deliver = createA2AAwaitOwnerDeliverer("sanctuary", vi.fn(async () => undefined))
      await deliver(plainRequest)
      await deliver(plainRequest)
      expect(new FileOutboxStore(agentRoot).list("peer").entries).toHaveLength(1)
    })

    it("tells the peer a question is with the owner and still asks the owner, who alone can answer it", async () => {
      const notify = vi.fn(async () => undefined)
      await createA2AAwaitOwnerDeliverer("sanctuary", notify)({ ...plainRequest, content: "Keep waiting?", noticeKind: "asked_owner" })
      expect(notify).toHaveBeenCalledWith({ noticeId: "await:release:resolved", text: "Keep waiting?\n\n(about the request from Claude Code)" })
      expect(JSON.stringify(new FileOutboxStore(agentRoot).list("peer").entries)).not.toContain("Keep waiting")
      expect(new FileOutboxStore(agentRoot).list("peer").entries[0]).toMatchObject({ body: "I've asked my owner and will let you know.", meta: { outcome: "asked_owner" } })
    })

    it("posts to the peer's outbox during a replay window too, and keeps the owner question in the sink", async () => {
      const dir = path.dirname(replayWindowPath(agentRoot))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(replayWindowPath(agentRoot), JSON.stringify({ friends: { peer: { expiresAt: new Date(Date.now() + 600_000).toISOString() } } }))
      fs.chmodSync(dir, 0o755)
      fs.chmodSync(replayWindowPath(agentRoot), 0o644)
      mockOwners(fs, (file) => (file.startsWith(dir) ? 0 : fs.statSync(file).uid))
      const notify = vi.fn(async () => undefined)
      await createA2AAwaitOwnerDeliverer("sanctuary", notify)(plainRequest)
      await createA2AAwaitOwnerDeliverer("sanctuary", notify)({ ...plainRequest, deliveryId: "await:release:asked", noticeKind: "asked_owner" })
      expect(notify).not.toHaveBeenCalled()
      expect(new FileOutboxStore(agentRoot).list("peer").entries).toHaveLength(2)
      expect(fs.readFileSync(replaySinkPath(agentRoot), "utf8")).toContain("await:release:asked")
      vi.restoreAllMocks()
    })

    it("reports a failed outbox write as a failed delivery", async () => {
      fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
      fs.writeFileSync(path.join(agentRoot, "state", "outbox"), "not a directory")
      await expect(createA2AAwaitOwnerDeliverer("sanctuary", vi.fn(async () => undefined))(plainRequest)).resolves.toMatchObject({ status: "failed" })
    })
  })

  describe("replay window", () => {
    const openWindow = (uid = 0) => {
      const dir = path.dirname(replayWindowPath(agentRoot))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(replayWindowPath(agentRoot), JSON.stringify({ friends: { peer: { expiresAt: new Date(Date.now() + 600_000).toISOString() } } }))
      fs.chmodSync(dir, 0o755)
      fs.chmodSync(replayWindowPath(agentRoot), 0o644)
      mockOwners(fs, (file) => (file.startsWith(dir) ? uid : fs.statSync(file).uid))
    }
    afterEach(() => vi.restoreAllMocks())

    it("ignores a window in a Butler-owned replay directory", async () => {
      openWindow(10001)
      const notify = vi.fn(async () => undefined)
      await createA2AAwaitOwnerDeliverer("sanctuary", notify)(request)
      expect(notify).toHaveBeenCalled()
      expect(fs.existsSync(replaySinkPath(agentRoot))).toBe(false)
    })

    it("writes the follow-up to the sink instead of the owner's chat while the filing peer's window is open", async () => {
      openWindow()
      const notify = vi.fn(async () => undefined)
      await expect(createA2AAwaitOwnerDeliverer("sanctuary", notify)(request)).resolves.toMatchObject({ status: "delivered_now", detail: expect.stringContaining("replay") })
      expect(notify).not.toHaveBeenCalled()
      expect(fs.readFileSync(replaySinkPath(agentRoot), "utf8")).toContain('"noticeId":"await:release:resolved"')
    })

    it("still uses the owner's chat for a peer without an open window", async () => {
      openWindow()
      const notify = vi.fn(async () => undefined)
      await createA2AAwaitOwnerDeliverer("sanctuary", notify)({ ...request, friendId: "gone" })
      expect(notify).toHaveBeenCalled()
    })

    it("reports a failed sink write as a failed delivery", async () => {
      openWindow()
      fs.mkdirSync(replaySinkPath(agentRoot), { recursive: true })
      const notify = vi.fn(async () => undefined)
      await expect(createA2AAwaitOwnerDeliverer("sanctuary", notify)(request)).resolves.toMatchObject({ status: "failed" })
      expect(notify).not.toHaveBeenCalled()
    })
  })
})
