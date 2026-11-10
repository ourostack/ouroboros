import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FriendRecord } from "@ouro.bot/friends"
import { deliverOrdinaryOwnerDecision, resolveOrdinaryOwner, type OrdinaryOwnerDecisionDeps } from "../../senses/ordinary-owner-decision"

const roots: string[] = []
function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-owner-"))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function friend(id: string, overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id, name: id, trustLevel: "family", admissionState: "active", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
    totalTokens: 0, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", schemaVersion: 1, ...overrides,
  } as FriendRecord
}
const local = (username: string) => [{ provider: "local" as const, externalId: username, linkedAt: "2026-11-10T00:00:00.000Z" }]

describe("resolveOrdinaryOwner", () => {
  it("prefers the active family friend who is this machine's user", () => {
    const ari = friend("ari", { externalIds: local("ari") })
    expect(resolveOrdinaryOwner([friend("rachel"), ari, friend("guest", { trustLevel: "friend" })], "ari")).toBe(ari)
  })

  it("falls back to the only active family friend", () => {
    const only = friend("only")
    expect(resolveOrdinaryOwner([only, friend("gone", { admissionState: "revoked" }), friend("pal", { trustLevel: "friend" })], "nobody")).toBe(only)
    expect(resolveOrdinaryOwner([only], null)).toBe(only)
  })

  it("names nobody when no single person is the owner", () => {
    expect(resolveOrdinaryOwner([], "ari")).toBeNull()
    expect(resolveOrdinaryOwner([friend("a"), friend("b")], "ari")).toBeNull()
    expect(resolveOrdinaryOwner([friend("a", { externalIds: local("ari") }), friend("b", { externalIds: local("ari") })], "ari")).toBeNull()
  })
})

describe("deliverOrdinaryOwnerDecision", () => {
  const input = { source: "housesitter", eventId: "peer-1", generation: 2, text: "The mini went dark; I restarted it.", relatedEvents: [{ source: "housesitter", eventId: "peer-2", generation: 1 }] }

  function deps(agentRoot: string, overrides: Partial<OrdinaryOwnerDecisionDeps> = {}): OrdinaryOwnerDecisionDeps {
    return {
      agentName: "plainagent",
      agentRoot,
      listFriends: async () => [friend("ari", { externalIds: local("ari") })],
      route: vi.fn(async () => ({ status: "queued" as const, detail: "for next interaction via teams" })),
      ownerUsername: "ari",
      ...overrides,
    }
  }

  it("sends once to the owner, covers the rest of the batch, and remembers both", async () => {
    const root = tempRoot()
    const d = deps(root)
    const sent = await deliverOrdinaryOwnerDecision(d, input)
    expect(sent.status).toBe("sent")
    expect(sent.effectKey).toMatch(/^ordinary-owner:[0-9a-f]{32}$/u)
    expect(d.route).toHaveBeenCalledWith("ari", "The mini went dark; I restarted it.")

    const again = deps(root)
    expect(await deliverOrdinaryOwnerDecision(again, input)).toEqual({ status: "already_sent", effectKey: sent.effectKey })
    expect(await deliverOrdinaryOwnerDecision(again, { ...input, eventId: "peer-2", generation: 1, relatedEvents: [] })).toEqual({ status: "covered", effectKey: sent.effectKey })
    expect(again.route).not.toHaveBeenCalled()
    const ledgerFile = path.join(root, "state", "external-events", "ordinary-owner-messages.json")
    expect(fs.statSync(ledgerFile).mode & 0o777).toBe(0o600)
  })

  it("fails when there is no single owner, or the message cannot be delivered, and records nothing", async () => {
    const root = tempRoot()
    await expect(deliverOrdinaryOwnerDecision(deps(root, { listFriends: async () => [] }), input)).rejects.toThrow("this agent has no single owner to tell")
    await expect(deliverOrdinaryOwnerDecision(deps(root, { route: async () => ({ status: "failed" }) }), input)).rejects.toThrow(/^the owner message could not be delivered$/u)
    await expect(deliverOrdinaryOwnerDecision(deps(root, { route: async () => ({ status: "failed", detail: "Teams is down" }) }), input)).rejects.toThrow("the owner message could not be delivered: Teams is down")
    expect(fs.existsSync(path.join(root, "state", "external-events", "ordinary-owner-messages.json"))).toBe(false)
  })

  it("treats an unreadable or malformed ledger as empty", async () => {
    for (const content of ["not json", "[]", "null"]) {
      const root = tempRoot()
      fs.mkdirSync(path.join(root, "state", "external-events"), { recursive: true })
      fs.writeFileSync(path.join(root, "state", "external-events", "ordinary-owner-messages.json"), content)
      expect((await deliverOrdinaryOwnerDecision(deps(root), input)).status).toBe("sent")
    }
  })

  it("uses this machine's OS user when no username is given", async () => {
    const root = tempRoot()
    const { machineOwnerUsername } = await import("@ouro.bot/friends")
    const me = machineOwnerUsername() ?? "nobody"
    const route = vi.fn(async () => ({ status: "deferred" as const }))
    const d = deps(root, { ownerUsername: undefined, listFriends: async () => [friend("other"), friend("me", { externalIds: local(me) })], route })
    if (machineOwnerUsername()) {
      expect((await deliverOrdinaryOwnerDecision(d, input)).status).toBe("sent")
      expect(route).toHaveBeenCalledWith("me", input.text)
    } else {
      await expect(deliverOrdinaryOwnerDecision(d, input)).rejects.toThrow("no single owner")
    }
  })
})
