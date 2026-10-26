import { afterEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileFriendStore, _setMachineOwnerUsernameForTest, type FriendRecord } from "@ouro.bot/friends"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

afterEach(() => _setMachineOwnerUsernameForTest(undefined))

function deps(bundlesRoot: string, overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, summary: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    bundlesRoot,
    ...overrides,
  }
}

function person(id: string, overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id, name: "Ari", trustLevel: "family", role: "family", connections: [],
    externalIds: [{ provider: "local", externalId: "ari@host.local", linkedAt: "2026-01-01T00:00:00.000Z" }],
    tenantMemberships: [], toolPreferences: {}, notes: { name: { value: "Ari", savedAt: "t" } }, totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1, kind: "human",
    ...overrides,
  }
}

async function bundle(records: FriendRecord[]): Promise<{ bundlesRoot: string; friendsDir: string; store: FileFriendStore }> {
  const bundlesRoot = mkdtempSync(join(tmpdir(), "friend-cli-"))
  const friendsDir = join(bundlesRoot, "slugger.ouro", "friends")
  const store = new FileFriendStore(friendsDir)
  for (const record of records) await store.put(record.id, record)
  return { bundlesRoot, friendsDir, store }
}

describe("friend link code, merge and dedupe parsing", () => {
  it("issues a code when link names no identity, and keeps the explicit link form", () => {
    expect(parseOuroCommand(["friend", "link", "--agent", "slugger", "--channel", "teams"])).toEqual({ kind: "friend.linkCode", agent: "slugger", channel: "teams" })
    expect(parseOuroCommand(["friend", "link", "--channel", "teams", "--friend", "f-1", "--ttl-minutes", "30"])).toEqual({ kind: "friend.linkCode", channel: "teams", friendId: "f-1", ttlMinutes: 30 })
    expect(parseOuroCommand(["friend", "link", "--agent", "slugger"])).toEqual({ kind: "friend.linkCode", agent: "slugger" })
    expect(parseOuroCommand(["friend", "link", "--agent", "slugger", "--friend", "f-1", "--provider", "aad", "--external-id", "x"])).toEqual({
      kind: "friend.link", agent: "slugger", friendId: "f-1", provider: "aad", externalId: "x",
    })
    expect(parseOuroCommand(["friend", "unlink", "--agent", "slugger", "--friend", "f-1", "--provider", "aad", "--external-id", "x"])).toMatchObject({ kind: "friend.unlink", agent: "slugger" })
    for (const args of [["--channel"], ["--channel", "fax"], ["--ttl-minutes", "0"], ["--wat", "x"]]) {
      expect(() => parseOuroCommand(["friend", "link", "--agent", "slugger", ...args])).toThrow("ouro friend link --agent")
    }
  })

  it("parses merge and dedupe, previewing unless --apply", () => {
    expect(parseOuroCommand(["friend", "merge", "--into", "a", "b", "c", "--agent", "slugger"])).toEqual({ kind: "friend.merge", agent: "slugger", targetId: "a", sourceIds: ["b", "c"], apply: false })
    expect(parseOuroCommand(["friend", "merge", "b", "--into", "a", "--apply"])).toEqual({ kind: "friend.merge", targetId: "a", sourceIds: ["b"], apply: true })
    for (const args of [["--into", "a"], ["b"], ["--into", "a", "b", "--force"]]) {
      expect(() => parseOuroCommand(["friend", "merge", ...args])).toThrow("ouro friend merge")
    }
    expect(parseOuroCommand(["friend", "dedupe", "--agent", "slugger"])).toEqual({ kind: "friend.dedupe", agent: "slugger", apply: false })
    expect(parseOuroCommand(["friend", "dedupe", "--apply"])).toEqual({ kind: "friend.dedupe", apply: true })
    expect(() => parseOuroCommand(["friend", "dedupe", "--yes"])).toThrow("ouro friend dedupe")
  })
})

describe("friend link code CLI", () => {
  it("issues a code for the machine owner's family record", async () => {
    _setMachineOwnerUsernameForTest("ari")
    const { bundlesRoot } = await bundle([person("family-ari"), person("someone", { trustLevel: "friend", externalIds: [] })])
    const output = await runOuroCli(["friend", "link", "--agent", "slugger", "--channel", "teams"], deps(bundlesRoot))
    expect(output).toMatch(/link code for Ari \(family\): OURO-[A-Z2-9]{4}-[A-Z2-9]{4}/)
    expect(output).toContain("Send exactly this code to slugger from your teams account, in a 1:1 chat, within 10 minutes")
    expect(readdirSync(join(bundlesRoot, "slugger.ouro", "state", "friend-link-codes", "pending"))).toHaveLength(1)
  })

  it("issues a code for a named friend with a custom lifetime and any channel", async () => {
    const { bundlesRoot } = await bundle([person("f-1", { name: "Sam", trustLevel: undefined })])
    const output = await runOuroCli(["friend", "link", "--agent", "slugger", "--friend", "f-1", "--ttl-minutes", "30"], deps(bundlesRoot))
    expect(output).toContain("link code for Sam (friend)")
    expect(output).toContain("from the account you want to link, in a 1:1 chat, within 30 minutes")
  })

  it("explains when it cannot tell who to issue the code for", async () => {
    _setMachineOwnerUsernameForTest("ari")
    const none = await bundle([person("other", { externalIds: [{ provider: "local", externalId: "sam@host", linkedAt: "t" }] })])
    expect(await runOuroCli(["friend", "link", "--agent", "slugger"], deps(none.bundlesRoot))).toContain("no family record names this machine's owner")
    const many = await bundle([person("a"), person("b")])
    expect(await runOuroCli(["friend", "link", "--agent", "slugger"], deps(many.bundlesRoot))).toContain("2 family records name this machine's owner. Run `ouro friend dedupe --apply` first")
    expect(await runOuroCli(["friend", "link", "--agent", "slugger", "--friend", "missing"], deps(many.bundlesRoot))).toBe("friend not found: missing")
  })

  it("finds no owner in a store that cannot list", async () => {
    _setMachineOwnerUsernameForTest("ari")
    const { bundlesRoot } = await bundle([])
    const store = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), findByExternalId: vi.fn() }
    expect(await runOuroCli(["friend", "link", "--agent", "slugger"], deps(bundlesRoot, { friendStore: store }))).toContain("no family record")
  })
})

describe("friend merge and dedupe CLI", () => {
  it("previews and applies a merge, and reports a refusal", async () => {
    const { bundlesRoot, friendsDir, store } = await bundle([
      person("a"),
      person("b", { notes: { name: { value: "Ari M", savedAt: "t" } }, externalIds: [{ provider: "aad", externalId: "x", tenantId: "t1", linkedAt: "2026-01-01T00:00:00.000Z" }] }),
      person("c", { externalIds: [{ provider: "local", externalId: "other", linkedAt: "2026-01-01T00:00:00.000Z" }] }),
    ])
    const preview = await runOuroCli(["friend", "merge", "--agent", "slugger", "--into", "a", "b", "c"], deps(bundlesRoot))
    expect(preview).toContain("would merge 2 record(s) into a (Ari, family)")
    expect(preview).toContain("would link aad:x (tenant t1)")
    expect(preview).toContain("would link local:other")
    expect(preview).toContain("kept conflicting notes as: name~b")
    expect(await store.get("b")).not.toBeNull()

    const applied = await runOuroCli(["friend", "merge", "--agent", "slugger", "--into", "a", "b", "--apply"], deps(bundlesRoot))
    expect(applied).toContain("merged 1 record(s) into a")
    expect(applied).toContain("retired b")
    expect(existsSync(join(friendsDir, "_retired", "b.json"))).toBe(true)

    expect(await runOuroCli(["friend", "merge", "--agent", "slugger", "--into", "a", "b"], deps(bundlesRoot))).toBe("error: friend not found: b")
  })

  it("dedupes duplicate local records", async () => {
    const { bundlesRoot, store } = await bundle([
      person("canonical", { notes: { name: { value: "Ari", savedAt: "t" }, work: { value: "Ouro", savedAt: "t" } } }),
      person("dup-1"),
      person("dup-2"),
    ])
    const preview = await runOuroCli(["friend", "dedupe", "--agent", "slugger"], deps(bundlesRoot))
    expect(preview).toContain("would merge 2 record(s) into canonical")
    expect(preview).toContain("dry run: nothing changed. Re-run with --apply to merge.")
    expect((await store.listAll()).length).toBe(3)

    const applied = await runOuroCli(["friend", "dedupe", "--agent", "slugger", "--apply"], deps(bundlesRoot))
    expect(applied).toContain("merged 2 record(s) into canonical")
    expect(applied).not.toContain("dry run")
    expect((await store.listAll()).map((record) => record.id)).toEqual(["canonical"])

    expect(await runOuroCli(["friend", "dedupe", "--agent", "slugger", "--apply"], deps(bundlesRoot))).toBe("no duplicate friend records found")
  })

  it("proposes merging a stale stranger that shares an iMessage handle into the family record", async () => {
    const handle = (externalId: string) => ({ provider: "imessage-handle" as const, externalId, linkedAt: "2026-01-01T00:00:00.000Z" })
    const { bundlesRoot } = await bundle([
      person("family-ari", { externalIds: [handle("+15551234567"), handle("ari@mendelow.me")] }),
      person("stale-stranger", { name: "ari@mendelow.me", trustLevel: "stranger", role: "stranger", notes: {}, externalIds: [handle("ari@mendelow.me")] }),
    ])
    const preview = await runOuroCli(["friend", "dedupe", "--agent", "slugger"], deps(bundlesRoot))
    expect(preview).toContain("would merge 1 record(s) into family-ari (Ari, family)")
    expect(preview).toContain("would retire stale-stranger")
  })
})
