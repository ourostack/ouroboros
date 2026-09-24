import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

const merged = vi.hoisted(() => vi.fn())
vi.mock("../../../heart/runtime-credentials", async (original) => ({
  ...await original<typeof import("../../../heart/runtime-credentials")>(),
  mergeMachineRuntimeCredentialConfig: merged,
}))

const DID = "did:key:z6MknTWQuadcZcauk4oUdbQcbvgRqGFswDMuqacYHnC9UNao"
const roots: string[] = []
function root(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
afterEach(() => { vi.clearAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function deps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, summary: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 1 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

function agentBundle(bundlesRoot: string, agent = "slugger"): string {
  const agentRoot = join(bundlesRoot, `${agent}.ouro`)
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(join(agentRoot, "agent.json"), JSON.stringify({
    version: 1, enabled: true, provider: "anthropic",
    senses: { cli: { enabled: true }, a2a: { enabled: false } },
    phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
  }))
  return agentRoot
}

describe("A2A provisioning CLI parsing", () => {
  it("parses the machine bind flags only for connect a2a", () => {
    expect(parseOuroCommand(["connect", "a2a", "--agent", "sanctuary", "--host", "100.73.66.84", "--port", "18940", "--public-url", "http://100.73.66.84:18940/"])).toEqual({
      kind: "connect", agent: "sanctuary", target: "a2a", a2aHost: "100.73.66.84", a2aPort: 18940, a2aPublicUrl: "http://100.73.66.84:18940",
    })
    expect(() => parseOuroCommand(["connect", "a2a", "--port", "0"])).toThrow("A2A port")
    expect(() => parseOuroCommand(["connect", "a2a", "--public-url", "ftp://peer.example"])).toThrow("http(s)")
    expect(() => parseOuroCommand(["connect", "mail", "--host", "100.73.66.84"])).toThrow("require `ouro connect a2a`")
  })

  it("parses every relationship field of friend update and refuses bad ones", () => {
    expect(parseOuroCommand(["friend", "update", "f-1", "--agent", "sanctuary", "--admission", "active", "--initiative", "reactive_only", "--profile", "sanctuary-agent-peer"])).toEqual({
      kind: "friend.update", friendId: "f-1", agent: "sanctuary", admissionState: "active", initiativePolicy: "reactive_only", capabilityProfileId: "sanctuary-agent-peer",
    })
    for (const args of [["--admission", "maybe"], ["--initiative", "sometimes"], ["--profile"], ["--wat", "x"], []]) {
      expect(() => parseOuroCommand(["friend", "update", "f-1", ...args])).toThrow("Usage")
    }
  })

  it("parses a card-less client onboard by did:key and name", () => {
    expect(parseOuroCommand(["a2a", "onboard", "--agent", "sanctuary", "--did", DID, "--name", "Claude Code", "--trust", "family"])).toEqual({
      kind: "a2a.onboard", agent: "sanctuary", did: DID, name: "Claude Code", trustLevel: "family",
    })
    expect(() => parseOuroCommand(["a2a", "onboard", "--did", DID])).toThrow("Usage")
    expect(() => parseOuroCommand(["a2a", "onboard", "--did", DID, "--name", "x", "--card-url", "https://peer.example/card"])).toThrow("Usage")
  })
})

describe("A2A provisioning CLI execution", () => {
  it("stores the bind host, port and advertised URL in this machine's runtime config", async () => {
    const bundlesRoot = root("ouro-a2a-bind-")
    const homeDir = root("ouro-a2a-home-")
    agentBundle(bundlesRoot)
    merged.mockResolvedValue({ ok: true })
    const result = await runOuroCli(["connect", "a2a", "--agent", "slugger", "--host", "100.73.66.84", "--port", "18940", "--public-url", "http://100.73.66.84:18940"], deps({ bundlesRoot, homeDir, now: () => Date.parse("2026-09-24T12:00:00.000Z") }))
    expect(merged).toHaveBeenCalledWith("slugger", expect.any(String), { a2a: { host: "100.73.66.84", port: 18940, publicUrl: "http://100.73.66.84:18940" } }, new Date("2026-09-24T12:00:00.000Z"))
    expect(result).toContain("This machine's A2A listener: 100.73.66.84:18940, advertised as http://100.73.66.84:18940")
  })

  it("reports the loopback default when only a public URL is set, and writes nothing without flags", async () => {
    const bundlesRoot = root("ouro-a2a-bind2-")
    const homeDir = root("ouro-a2a-home2-")
    agentBundle(bundlesRoot)
    merged.mockResolvedValue({ ok: true })
    const url = await runOuroCli(["connect", "a2a", "--agent", "slugger", "--public-url", "https://butler.example"], deps({ bundlesRoot, homeDir }))
    expect(url).toMatch(/listener: 127\.0\.0\.1:\d+, advertised as https:\/\/butler\.example/u)
    const port = await runOuroCli(["connect", "a2a", "--agent", "slugger", "--port", "18999"], deps({ bundlesRoot, homeDir }))
    expect(port).toContain("listener: 127.0.0.1:18999 (applies")
    merged.mockClear()
    const plain = await runOuroCli(["connect", "a2a", "--agent", "slugger"], deps({ bundlesRoot, homeDir }))
    expect(merged).not.toHaveBeenCalled()
    expect(plain).not.toContain("This machine's A2A listener")
  })

  it("sets admission, initiative and profile with or without trust, and reports a missing friend", async () => {
    const existing = { id: "f-1", name: "Claude Code", trustLevel: "friend", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", schemaVersion: 1 }
    let record: Record<string, unknown> = { ...existing }
    const store = { get: vi.fn(async (id: string) => id === "f-1" ? record : null), put: vi.fn(async (_id: string, next: Record<string, unknown>) => { record = next }), delete: vi.fn(), findByExternalId: vi.fn(), listAll: vi.fn() }
    const d = deps({ friendStore: store as never })
    const relationship = await runOuroCli(["friend", "update", "f-1", "--agent", "slugger", "--admission", "active", "--initiative", "reactive_only", "--profile", "sanctuary-agent-peer"], d)
    expect(relationship).toBe("updated: f-1 → admission=active, initiative=reactive_only, profile=sanctuary-agent-peer")
    expect(record).toMatchObject({ trustLevel: "friend", admissionState: "active", initiativePolicy: "reactive_only", capabilityProfileId: "sanctuary-agent-peer" })
    const both = await runOuroCli(["friend", "update", "f-1", "--agent", "slugger", "--trust", "family", "--admission", "revoked"], d)
    expect(both).toBe("updated: f-1 → trust=family, admission=revoked")
    expect(record).toMatchObject({ trustLevel: "family", admissionState: "revoked", capabilityProfileId: "sanctuary-agent-peer" })
    expect(await runOuroCli(["friend", "update", "f-2", "--agent", "slugger", "--admission", "active"], d)).toBe("friend not found: f-2")
  })

  it("onboards a card-less client keyed on its did:key and refuses a malformed key", async () => {
    const bundlesRoot = root("ouro-a2a-did-")
    agentBundle(bundlesRoot)
    const result = await runOuroCli(["a2a", "onboard", "--agent", "slugger", "--did", DID, "--name", "Claude Code", "--trust", "family"], deps({ bundlesRoot }))
    expect(result).toContain("onboarded A2A client: Claude Code")
    expect(result).toContain("trust: family")
    expect(result).toContain(`did: ${DID}`)
    const friendsDir = join(bundlesRoot, "slugger.ouro", "friends")
    const saved = readdirSync(friendsDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(friendsDir, name), "utf8")))
    expect(saved).toHaveLength(1)
    expect(saved[0].agentMeta.a2a).toMatchObject({ did: DID, agentId: DID })
    const plain = await runOuroCli(["a2a", "onboard", "--agent", "slugger", "--did", DID, "--name", "Claude Code"], deps({ bundlesRoot }))
    expect(plain).toContain("onboarded A2A client: Claude Code")
    await expect(runOuroCli(["a2a", "onboard", "--agent", "slugger", "--did", "did:key:zNotAKey", "--name", "x"], deps({ bundlesRoot }))).rejects.toThrow("not a valid did:key")
  })
})
