import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildA2AAgentCard } from "../../../a2a/card"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockResolvedValue({ ok: true, summary: "ok" }),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

describe("ouro A2A CLI parsing", () => {
  it("parses A2A card, onboard, and serve commands", () => {
    expect(parseOuroCommand(["a2a", "card", "--agent", "slugger", "--base-url", "https://agent.example", "--json"])).toEqual({
      kind: "a2a.card",
      agent: "slugger",
      baseUrl: "https://agent.example",
      json: true,
    })
    expect(parseOuroCommand([
      "a2a",
      "onboard",
      "--agent",
      "slugger",
      "--card-url",
      "https://peer.example/.well-known/agent-card.json",
      "--trust",
      "friend",
      "--name",
      "Peer",
    ])).toEqual({
      kind: "a2a.onboard",
      agent: "slugger",
      cardUrl: "https://peer.example/.well-known/agent-card.json",
      trustLevel: "friend",
      name: "Peer",
    })
    expect(parseOuroCommand([
      "a2a",
      "serve",
      "--agent",
      "slugger",
      "--host",
      "0.0.0.0",
      "--port",
      "19999",
      "--base-url",
      "https://agent.example",
      "--path",
      "agent-a2a",
    ])).toEqual({
      kind: "a2a.serve",
      agent: "slugger",
      host: "0.0.0.0",
      port: 19999,
      baseUrl: "https://agent.example",
      path: "agent-a2a",
    })
    expect(parseOuroCommand(["connect", "agent2agent", "--agent", "slugger"])).toEqual({
      kind: "connect",
      target: "a2a",
      agent: "slugger",
    })
    expect(parseOuroCommand(["a2a", "card"])).toEqual({ kind: "a2a.card" })
    expect(parseOuroCommand(["a2a", "onboard", "--card-url", "https://peer.example/card"])).toEqual({
      kind: "a2a.onboard",
      cardUrl: "https://peer.example/card",
    })
    expect(parseOuroCommand(["a2a", "serve"])).toEqual({ kind: "a2a.serve" })
  })

  it("rejects invalid A2A command shapes", () => {
    expect(() => parseOuroCommand(["a2a", "card", "--wat"])).toThrow(/Usage/)
    expect(() => parseOuroCommand(["a2a", "onboard"])).toThrow(/Usage/)
    expect(() => parseOuroCommand(["a2a", "onboard", "--card-url", "https://peer.example/card", "--trust", "cousin"])).toThrow(/Usage/)
    expect(() => parseOuroCommand(["a2a", "onboard", "--card-url", "https://peer.example/card", "--wat"])).toThrow(/Usage/)
    expect(() => parseOuroCommand(["a2a", "serve", "--port", "70000"])).toThrow("A2A port")
    expect(() => parseOuroCommand(["a2a", "serve", "--wat"])).toThrow(/Usage/)
    expect(() => parseOuroCommand(["a2a", "nope"])).toThrow(/Usage/)
  })
})

describe("ouro A2A CLI execution", () => {
  it("prints an A2A card", async () => {
    const stdout: string[] = []
    const result = await runOuroCli(["a2a", "card", "--agent", "slugger", "--base-url", "https://agent.example", "--json"], createMockDeps({
      writeStdout: (value) => { stdout.push(value) },
    }))
    const card = JSON.parse(result)
    expect(card.supportedInterfaces[0].url).toBe("https://agent.example/a2a")
    expect(stdout[0]).toBe(result)
  })

  it("prints a human-readable A2A card with default base URL", async () => {
    const stdout: string[] = []
    const result = await runOuroCli(["a2a", "card", "--agent", "slugger"], createMockDeps({
      writeStdout: (value) => { stdout.push(value) },
    }))
    expect(result).toContain("A2A agent card for slugger")
    expect(result).toContain("card URL: http://127.0.0.1:")
    expect(result).toContain("endpoint: http://127.0.0.1:")
    expect(stdout[0]).toBe(result)
  })

    it("connects A2A onboarding and enables the sense in agent.json", async () => {
    const bundlesRoot = mkdtempSync(join(tmpdir(), "ouro-a2a-connect-"))
    try {
      const agentRoot = join(bundlesRoot, "slugger.ouro")
      const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs")
      mkdirSync(agentRoot, { recursive: true })
      writeFileSync(join(agentRoot, "agent.json"), JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        senses: { cli: { enabled: true }, a2a: { enabled: false }, workbench: { enabled: false } },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      }), "utf-8")
      const stdout: string[] = []
      const result = await runOuroCli(["connect", "a2a", "--agent", "slugger"], createMockDeps({
        bundlesRoot,
        writeStdout: (value) => { stdout.push(value) },
      }))
      expect(result).toContain("A2A connected for slugger")
      expect(result).toContain("ouro a2a onboard")
      const saved = JSON.parse(readFileSync(join(agentRoot, "agent.json"), "utf-8"))
      expect(saved.senses.a2a.enabled).toBe(true)
      expect(stdout[0]).toBe(result)
    } finally {
      rmSync(bundlesRoot, { recursive: true, force: true })
    }
    })

    it("reports bundle sync from A2A onboarding when the bundle is sync-enabled", async () => {
      const bundlesRoot = mkdtempSync(join(tmpdir(), "ouro-a2a-connect-sync-"))
      try {
        const agentRoot = join(bundlesRoot, "slugger.ouro")
        const { mkdirSync, writeFileSync } = await import("node:fs")
        mkdirSync(agentRoot, { recursive: true })
        writeFileSync(join(agentRoot, "agent.json"), JSON.stringify({
          version: 1,
          enabled: true,
          provider: "anthropic",
          sync: { enabled: true, remote: "origin" },
          senses: { cli: { enabled: true }, a2a: { enabled: false }, workbench: { enabled: false } },
          phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
        }), "utf-8")
        const result = await runOuroCli(["connect", "a2a", "--agent", "slugger"], createMockDeps({ bundlesRoot }))
        expect(result).toContain("A2A connected for slugger")
        expect(result).toContain("bundle sync: could not push bundle changes")
      } finally {
        rmSync(bundlesRoot, { recursive: true, force: true })
      }
    })

    it("onboards an A2A peer through the friend store", async () => {
    const bundlesRoot = mkdtempSync(join(tmpdir(), "ouro-a2a-cli-"))
    const card = buildA2AAgentCard({ agentName: "remote", baseUrl: "https://remote.example" })
    try {
      const result = await runOuroCli(["a2a", "onboard", "--agent", "slugger", "--card-url", "https://remote.example/.well-known/agent-card.json", "--trust", "friend"], createMockDeps({
        bundlesRoot,
        fetchImpl: async () => new Response(JSON.stringify(card), {
          status: 200,
          headers: { "content-type": "application/json" },
        }) as Response,
      }))
      expect(result).toContain("onboarded A2A peer: remote")
      expect(result).toContain("trust: friend")
      expect(result).toContain("endpoint: https://remote.example/a2a")
    } finally {
      rmSync(bundlesRoot, { recursive: true, force: true })
    }
  })

  it("onboards an A2A peer with an explicit display name and default trust", async () => {
    const bundlesRoot = mkdtempSync(join(tmpdir(), "ouro-a2a-cli-name-"))
    const card = buildA2AAgentCard({ agentName: "remote", baseUrl: "https://remote.example" })
    try {
      const result = await runOuroCli([
        "a2a",
        "onboard",
        "--agent",
        "slugger",
        "--card-url",
        "https://remote.example/.well-known/agent-card.json",
        "--name",
        "Display Remote",
      ], createMockDeps({
        bundlesRoot,
        fetchImpl: async () => new Response(JSON.stringify(card), {
          status: 200,
          headers: { "content-type": "application/json" },
        }) as Response,
      }))
      expect(result).toContain("onboarded A2A peer: Display Remote")
      // @ouro.bot/friends alpha.7 hardened cold contact: a brand-new peer onboarded
      // with no explicit --trust now lands at `stranger` (safe-by-default), not
      // `acquaintance`. The owner raises trust explicitly via --trust or connect_to.
      expect(result).toContain("trust: stranger")
    } finally {
      rmSync(bundlesRoot, { recursive: true, force: true })
    }
  })
})
