import { describe, expect, it, vi } from "vitest"
import { EventEmitter, PassThrough } from "node:stream"
import type { ChildProcess, SpawnOptionsWithoutStdio } from "child_process"
import {
  createMcpStatusCanaryProbe,
  formatMcpStatusCanaryResult,
  parseMcpStatusText,
  runMcpStatusCanary,
} from "../../../heart/daemon/mcp-canary"

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(statusText: string): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    child.emit("close", 0, null)
    return true
  })

  let buffer = ""
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString()
    for (;;) {
      const idx = buffer.indexOf("\n")
      if (idx === -1) break
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      const request = JSON.parse(line) as { id?: number; method?: string }
      if (request.id === undefined) continue
      if (request.method === "initialize") {
        child.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "ouro-mcp-server", version: "1.0" },
            capabilities: { tools: {} },
          },
        }) + "\n")
        continue
      }
      if (request.method === "tools/call") {
        child.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: statusText }],
          },
        }) + "\n")
      }
    }
  })

  return child
}

function spawnFake(child: FakeChild) {
  return vi.fn((_command: string, _args: string[], _options: SpawnOptionsWithoutStdio) => child as unknown as ChildProcess)
}

function createManualChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    child.emit("close", 0, null)
    return true
  })
  return child
}

function createStatusResponseChild(response: Record<string, unknown>): FakeChild {
  const child = createManualChild()
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString().trim()) as { id?: number; method?: string }
    if (request.id === undefined) return
    if (request.method === "initialize") {
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n")
      return
    }
    if (request.method === "tools/call") {
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\n")
    }
  })
  return child
}

describe("mcp canary", () => {
  it("parses daemon and sense status lines", () => {
    const parsed = parseMcpStatusText([
      "",
      "agent=slugger\tinnerStatus=idle",
      "daemon=running\thealth=ok\tdaemonVersion=1\tmcpVersion=1\tmalformed-field",
      "sense=\tdetail=missing name",
      "sense=mail\tdetail=no explicit status",
      "sense=bluebubbles:running\tdetail=:18789\tproof=bluebubbles.checkHealth",
      "sense=teams:disabled\tdetail=not enabled",
    ].join("\n"))

    expect(parsed.daemon.health).toBe("ok")
    expect(parsed.senses.mail.status).toBe("unknown")
    expect(parsed.senses.bluebubbles.status).toBe("running")
    expect(parsed.senses.teams.status).toBe("disabled")
  })

  it("succeeds when fresh MCP status proves healthy daemon and senses", async () => {
    const child = createFakeChild([
      "agent=slugger\tinnerStatus=idle",
      "daemon=running\thealth=ok\tdaemonVersion=0.1.0-alpha.532\tmcpVersion=0.1.0-alpha.532",
      "worker=inner-dialog:running",
      "sense=bluebubbles:running\tdetail=:18789\tproof=bluebubbles.checkHealth\tpendingRecovery=0\tfailedRecovery=0",
      "sense=mail:running\tdetail=slugger@ouro.bot",
    ].join("\n"))

    const result = await runMcpStatusCanary({
      agent: "slugger",
      command: "node",
      commandArgs: ["ouro-bot-entry.js", "mcp-serve", "--agent", "slugger"],
      requiredSenses: ["bluebubbles", "mail"],
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain("mcp canary ok")
    expect(child.kill).toHaveBeenCalled()
  })

  it("fails when the MCP status reports degraded health", async () => {
    const child = createFakeChild([
      "daemon=running\thealth=warn\tdaemonVersion=1\tmcpVersion=1",
      "sense=bluebubbles:error\tdetail=listener down",
    ].join("\n"))

    const result = await runMcpStatusCanary({
      agent: "slugger",
      requiredSenses: ["bluebubbles"],
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("health=warn")
    expect(result.summary).toContain("sense=bluebubbles:error")
  })

  it("fails when the daemon is missing from status", async () => {
    const child = createFakeChild("sense=bluebubbles:running\tdetail=:18789")

    const result = await runMcpStatusCanary({
      agent: "slugger",
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("daemon=missing")
    expect(result.summary).toContain("health=missing")
  })

  it("reports missing required senses and version mismatches", async () => {
    const child = createFakeChild([
      "daemon=running\thealth=ok\tdaemonVersion=2\tmcpVersion=1",
      "sense=mail:disabled\tdetail=not enabled",
    ].join("\n"))

    const result = await runMcpStatusCanary({
      agent: "slugger",
      requiredSenses: ["bluebubbles", "mail"],
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("version mismatch daemon=2 mcp=1")
    expect(result.summary).toContain("required sense missing: bluebubbles")
    expect(result.summary).toContain("required sense unhealthy: mail:disabled")
  })

  it("uses the default node command and socket args when command args are omitted", async () => {
    const child = createFakeChild("daemon=running\thealth=ok")
    const spawnImpl = spawnFake(child)

    await runMcpStatusCanary({
      agent: "slugger",
      socketPath: "/tmp/ouro.sock",
      spawnImpl,
    })

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["mcp-serve", "--agent", "slugger", "--socket", "/tmp/ouro.sock"]),
      { stdio: ["pipe", "pipe", "pipe"] },
    )
  })

  it("fails when the status tool returns an MCP error result", async () => {
    const child = createManualChild()
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim()) as { id?: number; method?: string }
      if (request.method === "initialize") {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n")
      } else if (request.method === "tools/call") {
        child.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { isError: true, content: [{ type: "text", text: "status exploded" }] },
        }) + "\n")
      }
    })

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("status exploded")
  })

  it.each([
    [{}, "daemon=missing"],
    [{ result: { content: { bad: true } } }, "daemon=missing"],
    [{ result: { content: [] } }, "daemon=missing"],
    [{ result: { content: [null] } }, "daemon=missing"],
    [{ result: { content: [{ type: "text", text: 42 }] } }, "daemon=missing"],
  ])("falls back to raw JSON for unusual status responses %#", async (response, expected) => {
    const child = createStatusResponseChild(response)

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain(expected)
  })

  it("fails on malformed MCP stdout", async () => {
    const child = createManualChild()
    child.stdin.on("data", () => {
      child.stdout.write("{not json}\n")
    })

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("malformed JSON")
  })

  it("fails when stdin is not writable", async () => {
    const child = createManualChild()
    child.stdin.end()

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("stdin is not writable")
  })

  it("fails when the canary process closes before a response", async () => {
    const child = createManualChild()
    child.stdin.on("data", () => {
      child.stderr.write("bye")
      child.emit("close", 1, null)
    })

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("closed before response")
    expect(result.summary).toContain("bye")
  })

  it("fails when the canary process emits an error", async () => {
    const child = createManualChild()
    child.stdin.on("data", () => {
      child.emit("error", new Error("spawn failed"))
    })

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("spawn failed")
  })

  it("fails when the canary request times out", async () => {
    const child = createManualChild()

    const result = await runMcpStatusCanary({
      agent: "slugger",
      timeoutMs: 1,
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("timed out waiting for initialize")
  })

  it("cleans up pending requests when stdin write throws", async () => {
    const child = createManualChild()
    child.stdin.write = vi.fn(() => {
      throw "pipe boom"
    }) as unknown as typeof child.stdin.write

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("pipe boom")
    expect(child.kill).toHaveBeenCalled()
  })

  it("does not kill an already killed canary process during cleanup", async () => {
    const child = createManualChild()
    child.killed = true
    child.stdin.end()

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it("ignores MCP notifications and orphan responses while waiting for the real response", async () => {
    const child = createManualChild()
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim()) as { id?: number; method?: string }
      if (request.method !== "initialize" || request.id === undefined) return
      child.stdout.write("\n")
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }) + "\n")
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }) + "\n")
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n")
    })

    const result = await runMcpStatusCanary({
      agent: "slugger",
      timeoutMs: 1,
      spawnImpl: spawnFake(child),
    })

    expect(result.summary).toContain("timed out waiting for tools/call")
  })

  it("wraps the canary as a health probe", async () => {
    const child = createFakeChild("daemon=running\thealth=ok")
    const probe = createMcpStatusCanaryProbe({
      agent: "slugger",
      spawnImpl: spawnFake(child),
    } as Parameters<typeof createMcpStatusCanaryProbe>[0])

    await expect(probe.check()).resolves.toEqual({
      ok: true,
      detail: expect.stringContaining("mcp canary ok"),
    })
  })

  it("formats canary output for the CLI", () => {
    expect(formatMcpStatusCanaryResult({
      ok: true,
      summary: "mcp canary ok",
      details: ["daemon=running"],
    })).toContain("mcp canary: ok")
    expect(formatMcpStatusCanaryResult({
      ok: false,
      summary: "mcp canary failed: health=warn",
      details: ["health=warn"],
    })).toContain("mcp canary: failed")
  })
})
