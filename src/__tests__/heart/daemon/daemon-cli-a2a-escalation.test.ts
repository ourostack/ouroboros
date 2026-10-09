import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ready, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { startA2AServer, type A2AServerHandle } from "../../../a2a/server"
import { loadOrMintA2AIdentityFile } from "../../../a2a/identity"
import { escalationGrantsPath, readEscalationGrants } from "../../../a2a/escalation-grants"
import { operatorTrustDir } from "../../../a2a/operator-trust"
import { FileOutboxStore } from "../../../a2a/outbox-store"
import { fileFailureReport } from "../../../heart/failure-reports"

let sodium: Sodium
let server: A2AServerHandle | null = null
const roots: string[] = []
beforeAll(async () => { sodium = await ready() })
afterEach(async () => {
  if (server) { await server.close(); server = null }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  // The trust directory is keyed by agent name and shared by every test here; each starts without the last one's grants.
  rmSync(operatorTrustDir("/x/sanctuary.ouro"), { recursive: true, force: true })
})
function root(): string { const dir = mkdtempSync(join(tmpdir(), "ouro-escalation-cli-")); roots.push(dir); return dir }
function deps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock", sendCommand: vi.fn().mockResolvedValue({ ok: true, summary: "ok" }), startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
    writeStdout: vi.fn(), checkSocketAlive: vi.fn().mockResolvedValue(true), cleanupStaleSocket: vi.fn(), fallbackPendingMessage: vi.fn().mockReturnValue("pending"), ownA2ADid: () => "did:key:zOwn", ...overrides,
  }
}
function bundle(bundlesRoot: string, agent = "sanctuary"): string {
  const agentRoot = join(bundlesRoot, `${agent}.ouro`)
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, "agent.json"), JSON.stringify({ version: 1, enabled: true, provider: "anthropic", senses: { cli: { enabled: true }, a2a: { enabled: true } } }))
  return agentRoot
}

describe("outbox and escalation CLI parsing", () => {
  it("parses every outbox action with its flags", () => {
    expect(parseOuroCommand(["a2a", "outbox", "list", "--to", "http://c", "--since", "1760-aaa", "--identity-file", "/id.json", "--json"])).toEqual({ kind: "a2a.outbox", action: "list", to: "http://c", since: "1760-aaa", identityFile: "/id.json", json: true })
    expect(parseOuroCommand(["a2a", "outbox", "list", "--to", "http://c"])).toEqual({ kind: "a2a.outbox", action: "list", to: "http://c" })
    expect(parseOuroCommand(["a2a", "outbox", "ack", "--to", "http://c", "--ids", "a, b,,c"])).toEqual({ kind: "a2a.outbox", action: "ack", to: "http://c", ids: ["a", "b", "c"] })
    expect(parseOuroCommand(["a2a", "outbox", "resolve", "--to", "http://c", "--report", "r1", "--version", "0.1.0-alpha.9", "--note", "Fixed it."])).toEqual({ kind: "a2a.outbox", action: "resolve", to: "http://c", reportId: "r1", version: "0.1.0-alpha.9", note: "Fixed it." })
  })

  it("refuses an outbox command with a missing, unknown or misplaced flag", () => {
    for (const args of [[], ["wat"], ["list"], ["list", "--to"], ["list", "--to", "u", "--ids", "a"], ["list", "--to", "u", "--nope"], ["ack", "--to", "u"], ["ack", "--to", "u", "--ids", " , "],
      ["resolve", "--to", "u", "--report", "r", "--version", "v"], ["resolve", "--to", "u", "--note", "n"], ["ack", "--to", "u", "--ids", "a", "--since", "x"]]) {
      expect(() => parseOuroCommand(["a2a", "outbox", ...args]), args.join(" ")).toThrow("Usage")
    }
  })

  it("parses escalation grant, revoke and list and refuses bad combinations", () => {
    expect(parseOuroCommand(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", "f-1", "--did", "did:key:zX", "--source", "Ari, 2026-10-08"])).toEqual({ kind: "a2a.escalation", action: "grant", agent: "sanctuary", friendId: "f-1", did: "did:key:zX", source: "Ari, 2026-10-08" })
    expect(parseOuroCommand(["a2a", "escalation", "revoke", "--friend", "f-1"])).toEqual({ kind: "a2a.escalation", action: "revoke", friendId: "f-1" })
    expect(parseOuroCommand(["a2a", "escalation", "list", "--agent", "sanctuary"])).toEqual({ kind: "a2a.escalation", action: "list", agent: "sanctuary" })
    for (const args of [[], ["bless"], ["grant"], ["grant", "--friend", "f"], ["list", "--friend", "f"], ["revoke", "--friend", "f", "--source", "s"], ["revoke", "--friend", "f", "--did", "did:key:z"], ["list", "--did", "did:key:z"], ["grant", "--friend"], ["grant", "--friend", "f", "--did", "d", "--nope"]]) {
      expect(() => parseOuroCommand(["a2a", "escalation", ...args]), args.join(" ")).toThrow("Usage")
    }
    expect(() => parseOuroCommand(["a2a", "wat"])).toThrow("outbox|escalation")
  })
})

describe("delegated-commands CLI", () => {
  it("parses grant, revoke and list and refuses bad combinations", () => {
    expect(parseOuroCommand(["a2a", "delegated-commands", "grant", "--agent", "sanctuary", "--friend", "f-1", "--did", "did:key:zX", "--expires", "2027-01-01", "--source", "Ari"])).toEqual({ kind: "a2a.delegatedCommands", action: "grant", agent: "sanctuary", friendId: "f-1", did: "did:key:zX", expires: "2027-01-01", source: "Ari" })
    expect(parseOuroCommand(["a2a", "delegated-commands", "revoke", "--friend", "f-1"])).toEqual({ kind: "a2a.delegatedCommands", action: "revoke", friendId: "f-1" })
    expect(parseOuroCommand(["a2a", "delegated-commands", "list", "--json"])).toEqual({ kind: "a2a.delegatedCommands", action: "list", json: true })
    for (const args of [[], ["bless"], ["grant"], ["grant", "--friend", "f"], ["grant", "--did", "d"], ["revoke"], ["revoke", "--friend", "f", "--did", "d"], ["list", "--friend", "f"], ["grant", "--friend", "f", "--did", "d", "--json"], ["grant", "--friend", "f", "--did", "d", "--nope"], ["grant", "--friend"]]) {
      expect(() => parseOuroCommand(["a2a", "delegated-commands", ...args]), args.join(" ")).toThrow("Usage")
    }
  })

  it("runs grant, list, revoke through the CLI and refuses a non-root caller", async () => {
    const bundlesRoot = root()
    const agentRoot = bundle(bundlesRoot)
    const store = new FileFriendStore(join(agentRoot, "friends"))
    const peer = await upsertAgentPeer(store, { name: "Claude Code", agentId: "did:key:zX", trustLevel: "family", a2a: { did: "did:key:zX", agentId: "did:key:zX", endpointUrl: "https://x.example/a2a" } })
    await store.put(peer.id, { ...peer, admissionState: "active" })
    const d = deps({ bundlesRoot, isRoot: () => true, ownA2ADid: () => "did:key:zOwn", now: () => Date.parse("2026-10-08T12:00:00.000Z") })
    const granted = await runOuroCli(["a2a", "delegated-commands", "grant", "--agent", "sanctuary", "--friend", peer.id, "--did", "did:key:zX", "--source", "Ari, test"], d)
    expect(granted).toContain("did:key:zX")
    const listed = JSON.parse(await runOuroCli(["a2a", "delegated-commands", "list", "--agent", "sanctuary", "--json"], d))
    expect(JSON.stringify(listed)).toContain(peer.id)
    expect(await runOuroCli(["a2a", "delegated-commands", "revoke", "--agent", "sanctuary", "--friend", peer.id], d)).toContain("revoked")
    await expect(runOuroCli(["a2a", "delegated-commands", "grant", "--agent", "sanctuary", "--friend", peer.id, "--did", "did:key:zX"], deps({ bundlesRoot, isRoot: () => false }))).rejects.toThrow("must run as root")
  })
})

describe("escalation CLI execution", () => {
  async function withFriend(trust: "family" | "friend" = "family", admission: "active" | "unverified" = "active") {
    const bundlesRoot = root()
    const agentRoot = bundle(bundlesRoot)
    const store = new FileFriendStore(join(agentRoot, "friends"))
    const peer = await upsertAgentPeer(store, { name: "Claude Code", agentId: "did:key:zX", trustLevel: trust, a2a: { did: "did:key:zX", agentId: "did:key:zX", endpointUrl: "https://x.example/a2a" } })
    await store.put(peer.id, { ...peer, admissionState: admission })
    return { bundlesRoot, agentRoot, friendId: peer.id }
  }

  it("grants, reports, lists and revokes, keeping a backup", async () => {
    const { bundlesRoot, agentRoot, friendId } = await withFriend()
    const d = deps({ bundlesRoot, isRoot: () => true, now: () => Date.parse("2026-10-08T12:00:00.000Z") })
    expect(await runOuroCli(["a2a", "escalation", "list", "--agent", "sanctuary"], d)).toBe("no escalation grants")
    const granted = await runOuroCli(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", friendId, "--did", "did:key:zX", "--source", "Ari, test"], d)
    expect(granted).toBe(`granted escalation: Claude Code (${friendId})\npinned DID: did:key:zX`)
    expect(readEscalationGrants(agentRoot)[friendId]).toMatchObject({ scope: "escalation", grantedAt: "2026-10-08T12:00:00.000Z", source: "Ari, test", did: "did:key:zX" })
    expect(await runOuroCli(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", friendId, "--did", "did:key:zX"], d)).toBe(`granted escalation: Claude Code (${friendId}) (no change)\npinned DID: did:key:zX`)
    expect(await runOuroCli(["a2a", "escalation", "list", "--agent", "sanctuary"], d)).toBe(`${friendId}  granted 2026-10-08T12:00:00.000Z  did:key:zX  Ari, test`)
    const revoked = await runOuroCli(["a2a", "escalation", "revoke", "--agent", "sanctuary", "--friend", friendId], d)
    expect(revoked).toContain(`revoked escalation: Claude Code (${friendId})`)
    expect(revoked).toContain(`backup: ${escalationGrantsPath(agentRoot)}.bak-`)
    expect(readEscalationGrants(agentRoot)).toEqual({})
    expect(JSON.parse(readFileSync(escalationGrantsPath(agentRoot), "utf8")).grants).toEqual({})
    expect(escalationGrantsPath(agentRoot)).not.toContain(".ouro/")
  })

  it("refuses to grant a friend whose record has no DID", async () => {
    const { bundlesRoot, agentRoot, friendId } = await withFriend()
    const store = new FileFriendStore(join(agentRoot, "friends"))
    const friend = (await store.get(friendId))!
    await store.put(friendId, { ...friend, agentMeta: undefined })
    await expect(runOuroCli(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", friendId, "--did", "did:key:zX"], deps({ bundlesRoot, isRoot: () => true }))).rejects.toThrow("has no DID on record")
    expect(readEscalationGrants(agentRoot)).toEqual({})
  })

  it("refuses to grant or revoke unless run as root, and writes nothing", async () => {
    const { bundlesRoot, friendId } = await withFriend()
    for (const args of [["grant", "--friend", friendId, "--did", "did:key:zX"], ["revoke", "--friend", friendId]]) {
      await expect(runOuroCli(["a2a", "escalation", ...args, "--agent", "sanctuary"], deps({ bundlesRoot, isRoot: () => false }))).rejects.toThrow("must run as root")
    }
  })

  it("defaults the grant source and timestamp, warns when the friend is not active family, and refuses an unknown friend", async () => {
    const { bundlesRoot, agentRoot, friendId } = await withFriend("friend", "unverified")
    const granted = await runOuroCli(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", friendId, "--did", "did:key:zX"], deps({ bundlesRoot, isRoot: () => true }))
    expect(granted).toContain("only holds the grant while it is active family (now friend, unverified)")
    expect(readEscalationGrants(agentRoot)[friendId]!.source).toMatch(/^ouro a2a escalation grant, \d{4}-/u)
    await expect(runOuroCli(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", "nobody", "--did", "did:key:zX"], deps({ bundlesRoot, isRoot: () => true }))).rejects.toThrow("friend not found: nobody")
  })

  it("warns when the written grant will not be honoured because it is not root-owned", async () => {
    const { overrideOwnerForTests } = await import("../../../a2a/trusted-files")
    const { bundlesRoot, friendId } = await withFriend("family", "active")
    overrideOwnerForTests((target) => (target.endsWith("escalation-grants.json") ? process.getuid!() + 1 : undefined))
    try {
      const granted = await runOuroCli(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", friendId, "--did", "did:key:zX"], deps({ bundlesRoot, isRoot: () => true }))
      expect(granted).toContain("WARNING: the grant is written but will not be honoured")
      expect(granted).toContain("owned by root")
    } finally {
      overrideOwnerForTests(undefined)
    }
  })

  it("does not warn when the grant is trusted", async () => {
    const { bundlesRoot, friendId } = await withFriend("family", "active")
    expect(await runOuroCli(["a2a", "escalation", "grant", "--agent", "sanctuary", "--friend", friendId, "--did", "did:key:zX"], deps({ bundlesRoot, isRoot: () => true }))).not.toContain("WARNING")
  })
})

describe("outbox CLI execution against a live server", () => {
  it("lists, acks and resolves as the verified client and prints JSON", async () => {
    const bundlesRoot = root()
    const agentRoot = bundle(bundlesRoot)
    const store = new FileFriendStore(join(agentRoot, "friends"))
    const identityFile = join(bundlesRoot, "client.json")
    const client = await loadOrMintA2AIdentityFile({ filePath: identityFile, sodium })
    const peer = await upsertAgentPeer(store, { name: "Claude Code", agentId: client.did, trustLevel: "family", a2a: { did: client.did, agentId: client.did, endpointUrl: "https://x.example/a2a" } })
    await store.put(peer.id, { ...peer, admissionState: "active", capabilityProfileId: "sanctuary-agent-peer" })
    const agentIdentity = await loadOrMintA2AIdentityFile({ filePath: join(bundlesRoot, "agent.json"), sodium })
    server = await startA2AServer({ agentName: "sanctuary", agentRoot, port: 0, identity: agentIdentity, turnRunner: async () => ({ response: "ok" }) })
    const cardUrl = new URL("/.well-known/agent-card.json", server.url).toString()
    const entry = new FileOutboxStore(agentRoot).append(peer.id, { kind: "await_outcome", body: "done" })
    const written: string[] = []
    const d = deps({ writeStdout: (text: string) => { written.push(text) } })
    const listed = JSON.parse(await runOuroCli(["a2a", "outbox", "list", "--to", cardUrl, "--identity-file", identityFile, "--json"], d))
    expect(listed).toMatchObject({ entries: [{ id: entry.id, body: "done" }], nextCursor: entry.id, more: false })
    expect(await runOuroCli(["a2a", "outbox", "list", "--to", cardUrl, "--identity-file", identityFile, "--since", entry.id], d)).toContain('"entries": []')
    expect(JSON.parse(await runOuroCli(["a2a", "outbox", "ack", "--to", cardUrl, "--ids", entry.id, "--identity-file", identityFile, "--json"], d))).toEqual({ acked: [entry.id], unknown: [] })
    const { setEscalationGrant } = await import("../../../a2a/escalation-grants")
    setEscalationGrant(agentRoot, peer.id, { grant: true, source: "test", did: client.did })
    const filed = await fileFailureReport(agentRoot, store, { ariWords: "a", tried: "b", error: "c", severity: "low", origin: { friendId: null, channel: null, key: null } })
    if (!filed.ok) throw new Error("setup failed")
    expect(JSON.parse(await runOuroCli(["a2a", "outbox", "resolve", "--to", cardUrl, "--report", filed.id, "--version", "0.1.0-alpha.9", "--note", "Fixed.", "--identity-file", identityFile, "--json"], d))).toEqual({ id: filed.id, status: "resolved" })
    expect(written.length).toBeGreaterThan(0)
  })
})
