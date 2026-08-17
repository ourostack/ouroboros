import { describe, expect, it, vi } from "vitest"
import { EventEmitter, PassThrough } from "node:stream"
import type { ChildProcess, SpawnOptionsWithoutStdio } from "child_process"
import {
  buildMcpBridgeRepairGuidance,
  classifyMcpBoundary,
  createMcpStatusCanaryProbe,
  DEFAULT_CANARY_TIMEOUT_MS,
  formatMcpStatusDoctorResult,
  formatMcpStatusCanaryResult,
  parseMcpStatusText,
  runMcpStatusCanary,
  sanitizeMcpCanaryArgs,
  sanitizeMcpCanaryText,
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
  Object.assign(child, { pid: 4321 })
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
  it("limits boundary classification to truthful bridge and host-stall states", () => {
    expect(classifyMcpBoundary({ bridgeHealthy: false, hostStallObserved: false })).toBe("ouro-bridge-failed")
    expect(classifyMcpBoundary({ bridgeHealthy: true, hostStallObserved: false })).toBe("ouro-bridge-healthy-at-capture")
    expect(classifyMcpBoundary({ bridgeHealthy: true, hostStallObserved: true })).toBe("host-stall-unexplained")
    expect(classifyMcpBoundary({ bridgeHealthy: false, hostStallObserved: true })).toBe("ouro-bridge-failed")
  })

  it("uses a production-safe default timeout for slow status paths", () => {
    expect(DEFAULT_CANARY_TIMEOUT_MS).toBe(60_000)
  })

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
      "worker=private-runtime:running",
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
    expect(result.classification).toBe("ouro-bridge-healthy-at-capture")
    expect(result.evidence).toEqual(expect.objectContaining({
      capturedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      durationMs: expect.any(Number),
      childPid: 4321,
      phase: "complete",
      exitCode: 0,
      exitSignal: null,
      stderr: "",
    }))
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
    expect(result.classification).toBe("ouro-bridge-healthy-at-capture")
    expect(result.summary).toContain("health=warn")
    expect(result.summary).toContain("sense=bluebubbles:error")
  })

  it("classifies an observed host stall as unexplained when the bridge is healthy", async () => {
    const child = createFakeChild("daemon=running\thealth=ok")
    const result = await runMcpStatusCanary({
      agent: "slugger",
      hostStallObserved: true,
      spawnImpl: spawnFake(child),
    })
    expect(result).toMatchObject({ ok: true, classification: "host-stall-unexplained" })
  })

  it("uses one total timeout budget across initialize and status phases", async () => {
    vi.useFakeTimers()
    const child = createManualChild()
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim()) as { id?: number; method?: string }
      if (request.method === "initialize") {
        setTimeout(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n"), 20)
      }
    })
    try {
      const resultPromise = runMcpStatusCanary({ agent: "slugger", timeoutMs: 25, spawnImpl: spawnFake(child) })
      await vi.advanceTimersByTimeAsync(50)
      const result = await resultPromise
      expect(result.summary).toContain("timed out waiting for tools/call")
      expect(result.evidence?.durationMs).toBe(25)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not start the status phase after the total deadline is exhausted", async () => {
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(25)
    const child = createStatusResponseChild({ result: { content: [] } })
    try {
      const result = await runMcpStatusCanary({ agent: "slugger", timeoutMs: 25, spawnImpl: spawnFake(child) })
      expect(result.summary).toContain("timed out waiting for tools/call")
      expect(result.evidence?.durationMs).toBe(25)
    } finally {
      now.mockRestore()
    }
  })

  it("redacts JSON, bearer, CLI, query, and key-value credential shapes", () => {
    const raw = 'https://host/path?password=query "token":"json-token" Bearer bearer-token --api-key cli-token secret=value'
    const sanitized = sanitizeMcpCanaryText(raw)
    expect(sanitized).toContain("https://host/path?[redacted]")
    expect(sanitized).toContain('"token":"[redacted]"')
    expect(sanitized).toContain("Bearer [redacted]")
    expect(sanitized).toContain("--api-key [redacted]")
    expect(sanitized).toContain("secret=[redacted]")
    expect(sanitized).not.toContain("query")
    expect(sanitized).not.toContain("json-token")
    expect(sanitized).not.toContain("bearer-token")
    expect(sanitized).not.toContain("cli-token")
    expect(sanitizeMcpCanaryArgs(["mcp-serve", "--token", "arg-token", "--password=inline", "safe"]))
      .toEqual(["mcp-serve", "--token", "[redacted]", "--password=[redacted]", "safe"])
  })

  it("can ignore aggregate health while preserving transport and required-sense checks", async () => {
    const child = createFakeChild([
      "daemon=running\thealth=warn\tdaemonVersion=1\tmcpVersion=1",
      "sense=bluebubbles:running\tdetail=:18789",
      "sense=mail:running\tdetail=slugger@ouro.bot",
    ].join("\n"))

    const result = await runMcpStatusCanary({
      agent: "slugger",
      requiredSenses: ["bluebubbles", "mail"],
      ignoreOverviewHealth: true,
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain("health=warn (overview ignored)")
  })

  it("still fails unhealthy required senses when aggregate health is ignored", async () => {
    const child = createFakeChild([
      "daemon=running\thealth=warn\tdaemonVersion=1\tmcpVersion=1",
      "sense=bluebubbles:error\tdetail=listener down",
    ].join("\n"))

    const result = await runMcpStatusCanary({
      agent: "slugger",
      requiredSenses: ["bluebubbles"],
      ignoreOverviewHealth: true,
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(false)
    expect(result.summary).not.toContain("health=warn")
    expect(result.summary).toContain("sense=bluebubbles:error")
    expect(result.summary).toContain("required sense unhealthy: bluebubbles:error")
  })

  it("can ignore general sense health while preserving explicit required-sense checks", async () => {
    const child = createFakeChild([
      "daemon=running\thealth=warn\tdaemonVersion=1\tmcpVersion=1",
      "sense=bluebubbles:not_attached\tdetail=not attached on this machine",
      "sense=mail:error\tdetail=missing vault runtime/config",
      "sense=a2a:error\tdetail=:18921 /a2a",
    ].join("\n"))

    const result = await runMcpStatusCanary({
      agent: "slugger",
      ignoreOverviewHealth: true,
      ignoreSenseHealth: true,
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain("sense health reported, not gated")
    expect(result.summary).toContain("bluebubbles:not_attached")
    expect(result.summary).toContain("mail:error")
  })

  it("does not ignore unhealthy required senses when general sense health is ignored", async () => {
    const child = createFakeChild([
      "daemon=running\thealth=warn\tdaemonVersion=1\tmcpVersion=1",
      "sense=bluebubbles:not_attached\tdetail=not attached on this machine",
      "sense=mail:error\tdetail=missing vault runtime/config",
    ].join("\n"))

    const result = await runMcpStatusCanary({
      agent: "slugger",
      requiredSenses: ["bluebubbles"],
      ignoreOverviewHealth: true,
      ignoreSenseHealth: true,
      spawnImpl: spawnFake(child),
    })

    expect(result.ok).toBe(false)
    expect(result.summary).not.toContain("sense=mail:error")
    expect(result.summary).toContain("required sense unhealthy: bluebubbles:not_attached")
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
    expect(result.repair).toMatchObject({
      actor: "agent-runnable",
      commands: [
        "ouro setup --tool codex --agent slugger",
        "ouro setup --tool claude-code --agent slugger",
      ],
    })
    expect(result.details).toContain("repair actor=agent-runnable")
    expect(result.details).toContain("repair command=ouro setup --tool codex --agent slugger")
    expect(result.details).toContain("repair command=ouro setup --tool claude-code --agent slugger")
    expect(result.details).toContain("reload required: open a fresh dev-tool session after setup; existing MCP processes keep their old runtime")
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

  it("uses a safe generic error for a status tool error without text content", async () => {
    const child = createStatusResponseChild({ result: { isError: true } })

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.classification).toBe("ouro-bridge-failed")
    expect(result.summary).toContain("MCP status tool returned an error")
  })

  it.each([
    ["initialize", { jsonrpc: "2.0", error: { code: -32603, message: "init failed" } }, "init failed"],
    ["initialize", { result: {} }, "malformed JSON-RPC response"],
    ["initialize", { jsonrpc: "2.0", result: null }, "invalid initialize result"],
    ["tools/call", { jsonrpc: "2.0", error: { code: -32603, message: "status failed" } }, "status failed"],
    ["tools/call", { jsonrpc: "2.0", result: null }, "invalid status result"],
    ["tools/call", { jsonrpc: "2.0", result: {} }, "invalid status result"],
  ])("does not classify an invalid %s envelope as a healthy bridge %#", async (targetMethod, payload, expected) => {
    const child = createManualChild()
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString().trim()) as { id?: number; method?: string }
      if (request.id === undefined) return
      if (request.method === "initialize" && targetMethod !== "initialize") {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n")
        return
      }
      if (request.method === targetMethod) {
        child.stdout.write(JSON.stringify({ id: request.id, ...payload }) + "\n")
      }
    })

    const result = await runMcpStatusCanary({
      agent: "slugger",
      hostStallObserved: true,
      timeoutMs: 25,
      spawnImpl: spawnFake(child),
    })

    expect(result.classification).toBe("ouro-bridge-failed")
    expect(result.summary).toContain(expected)
  })

  it("redacts successful status payloads in structured, JSON, and text output", async () => {
    const child = createFakeChild([
      "daemon=running\thealth=ok\tdetail=https://host/path?password=raw-query",
      "sense=mail:running\tdetail=Bearer raw-bearer\ttoken=raw-token",
    ].join("\n"))

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })
    const json = JSON.stringify(result)
    const textOutput = formatMcpStatusCanaryResult(result)

    expect(result.ok).toBe(true)
    expect(result.parsed?.raw).toContain("[redacted]")
    expect(json).not.toContain("raw-query")
    expect(json).not.toContain("raw-bearer")
    expect(json).not.toContain("raw-token")
    expect(textOutput).not.toContain("raw-query")
    expect(textOutput).not.toContain("raw-bearer")
    expect(textOutput).not.toContain("raw-token")
  })

  it.each([
    [{}, "malformed JSON-RPC response"],
    [{ result: { content: { bad: true } } }, "invalid status result"],
    [{ result: { content: [] } }, "invalid status result"],
    [{ result: { content: [null] } }, "invalid status result"],
    [{ result: { content: [{ type: "text", text: 42 }] } }, "invalid status result"],
  ])("rejects malformed status responses %#", async (response, expected) => {
    const child = createStatusResponseChild(response)

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result.ok).toBe(false)
    expect(result.classification).toBe("ouro-bridge-failed")
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
    expect(result.classification).toBe("ouro-bridge-failed")
    expect(result.evidence).toEqual(expect.objectContaining({ phase: "initialize" }))
  })

  it("captures exit signal and sanitized stderr without leaking credentials", async () => {
    const child = createManualChild()
    Object.assign(child, { pid: 9876 })
    child.kill.mockImplementation(() => {
      child.killed = true
      child.emit("close", null, "SIGTERM")
      return true
    })
    child.stdin.on("data", () => {
      child.stderr.write("failed https://bridge.local/path?password=top-secret token=abc123\n")
      child.emit("close", null, "SIGTERM")
    })

    const result = await runMcpStatusCanary({ agent: "slugger", timeoutMs: 25, spawnImpl: spawnFake(child) })

    expect(result.classification).toBe("ouro-bridge-failed")
    expect(result.evidence).toEqual(expect.objectContaining({
      childPid: 9876,
      exitCode: null,
      exitSignal: "SIGTERM",
      stderr: "failed https://bridge.local/path?[redacted] token=[redacted]",
    }))
    expect(JSON.stringify(result)).not.toContain("top-secret")
    expect(JSON.stringify(result)).not.toContain("abc123")
  })

  it("returns structured spawn-failure evidence instead of throwing", async () => {
    const result = await runMcpStatusCanary({
      agent: "slugger",
      spawnImpl: vi.fn(() => { throw new Error("spawn denied") }),
    })

    expect(result).toMatchObject({
      ok: false,
      classification: "ouro-bridge-failed",
      evidence: { childPid: null, phase: "spawn", exitCode: null, exitSignal: null },
    })
    expect(result.summary).toContain("spawn denied")

    await expect(runMcpStatusCanary({
      agent: "slugger",
      spawnImpl: vi.fn(() => { throw "spawn unavailable" }),
    })).resolves.toMatchObject({
      classification: "ouro-bridge-failed",
      summary: expect.stringContaining("spawn unavailable"),
    })
  })

  it("handles a child with unavailable stdout and stderr streams", async () => {
    const child = createManualChild()
    child.stdin.end()
    Object.assign(child, { stdout: null, stderr: null })

    const result = await runMcpStatusCanary({ agent: "slugger", spawnImpl: spawnFake(child) })

    expect(result).toMatchObject({ ok: false, classification: "ouro-bridge-failed" })
    expect(result.evidence?.stderr).toBe("")
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
      timeoutMs: 25,
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
    const healthy = formatMcpStatusCanaryResult({
      ok: true,
      summary: "mcp canary ok",
      details: ["daemon=running"],
      classification: "ouro-bridge-healthy-at-capture",
      evidence: {
        capturedAt: "2026-08-17T18:00:00.000Z",
        durationMs: 12,
        childPid: 4321,
        phase: "complete",
        exitCode: 0,
        exitSignal: null,
        stderr: "",
      },
    })
    expect(healthy).toContain("mcp canary: ok")
    expect(healthy).toContain("classification: ouro-bridge-healthy-at-capture")
    expect(healthy).toContain("captured=2026-08-17T18:00:00.000Z durationMs=12 childPid=4321 phase=complete exitCode=0 exitSignal=none")
    const failed = formatMcpStatusCanaryResult({
      ok: false,
      summary: "mcp canary failed",
      details: [],
      classification: "ouro-bridge-failed",
      evidence: {
        capturedAt: "2026-08-17T18:00:00.000Z",
        durationMs: 25,
        childPid: null,
        phase: "initialize",
        exitCode: null,
        exitSignal: "SIGTERM",
        stderr: "safe failure",
      },
    })
    expect(failed).toContain("childPid=none")
    expect(failed).toContain("exitCode=none exitSignal=SIGTERM")
    expect(failed).toContain("stderr=safe failure")
    expect(formatMcpStatusCanaryResult({
      ok: false,
      summary: "mcp canary failed: health=warn",
      details: ["health=warn"],
    })).toContain("mcp canary: failed")
  })

  it("formats doctor output with the any-agent repair path", () => {
    const output = formatMcpStatusDoctorResult({
      ok: true,
      summary: "mcp canary ok",
      details: ["daemon=running"],
      classification: "ouro-bridge-healthy-at-capture",
      evidence: {
        capturedAt: "2026-08-17T18:00:00.000Z",
        durationMs: 12,
        childPid: null,
        phase: "complete",
        exitCode: null,
        exitSignal: null,
        stderr: "",
      },
    }, "slugger")

    expect(output).toContain("mcp doctor: ok")
    expect(output).toContain("ouro setup --tool codex --agent slugger")
    expect(output).toContain("ouro setup --tool claude-code --agent slugger")
    expect(output).toContain("open a fresh dev-tool session")
  })

  it("formats doctor failure evidence with null exit fields and sanitized stderr", () => {
    const output = formatMcpStatusDoctorResult({
      ok: false,
      summary: "mcp canary failed",
      details: [],
      classification: "ouro-bridge-failed",
      evidence: {
        capturedAt: "2026-08-17T18:00:00.000Z",
        durationMs: 25,
        childPid: 9876,
        phase: "initialize",
        exitCode: 1,
        exitSignal: "SIGTERM",
        stderr: "safe failure",
      },
    }, "slugger")

    expect(output).toContain("classification: ouro-bridge-failed")
    expect(output).toContain("childPid=9876")
    expect(output).toContain("exitCode=1 exitSignal=SIGTERM")
    expect(output).toContain("stderr=safe failure")
  })

  it("formats failed doctor output without duplicating embedded repair lines", () => {
    const output = formatMcpStatusDoctorResult({
      ok: false,
      summary: "mcp canary failed: version mismatch daemon=2 mcp=1",
      details: [
        "version mismatch daemon=2 mcp=1",
        "repair actor=agent-runnable",
        "repair command=ouro setup --tool codex --agent slugger",
        "reload required: open a fresh dev-tool session after setup; existing MCP processes keep their old runtime",
        "verify command=ouro mcp doctor --agent slugger",
      ],
      repair: buildMcpBridgeRepairGuidance("slugger"),
    }, "slugger")

    expect(output).toContain("mcp doctor: failed")
    expect(output.match(/repair actor=agent-runnable/g)).toHaveLength(1)
    expect(output).toContain("version mismatch daemon=2 mcp=1")
  })

  it("formats non-bridge doctor failures with daemon health next steps instead of setup", () => {
    const output = formatMcpStatusDoctorResult({
      ok: false,
      summary: "mcp canary failed: daemon=unreachable; health=missing",
      details: ["daemon=unreachable\terror=transport closed"],
    }, "slugger")

    expect(output).toContain("mcp doctor: failed")
    expect(output).toContain("next checks:")
    expect(output).toContain("next command=ouro up")
    expect(output).toContain("next command=ouro mcp doctor --agent slugger")
    expect(output).not.toContain("ouro setup --tool")
  })

  it("formats non-bridge doctor failures with general diagnostics when the daemon is reachable", () => {
    const output = formatMcpStatusDoctorResult({
      ok: false,
      summary: "mcp canary failed: health=warn",
      details: ["health=warn"],
    }, "slugger")

    expect(output).toContain("next command=ouro doctor")
    expect(output).toContain("next command=ouro status --agent slugger")
    expect(output).toContain("next command=ouro repair --agent slugger")
    expect(output).not.toContain("bridge registration path:")
  })

  it("quotes unusual agent names in repair commands", () => {
    const repair = buildMcpBridgeRepairGuidance("odd agent's")

    expect(repair.commands[0]).toContain("ouro setup --tool codex --agent 'odd agent'\\''s'")
    expect(repair.verify).toBe("ouro mcp doctor --agent 'odd agent'\\''s'")
  })
})
