import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { emitNervesEvent } from "../../nerves/runtime"
import { pingProviderInChild, runProviderPingChild, serveProviderPingChild } from "../../heart/provider-ping-child"

const config = { githubToken: "tok", baseUrl: "https://api.example" }

function tempScript(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-child-"))
  const file = path.join(dir, "entry.cjs")
  fs.writeFileSync(file, source)
  return file
}

describe("pingProviderInChild", () => {
  it("returns the child's result and sends it only the ping's data", async () => {
    const runChild = vi.fn(async () => ({ code: 0, stdout: '{"ok":false,"classification":"auth-failure","message":"401"}\n' }))
    const pingInProcess = vi.fn()
    const result = await pingProviderInChild("github-copilot", config, { model: "m", timeoutMs: 5, attemptPolicy: { maxAttempts: 1 } }, { runChild, pingInProcess })
    expect(result).toEqual({ ok: false, classification: "auth-failure", message: "401" })
    expect(JSON.parse(runChild.mock.calls[0]![0])).toEqual({ provider: "github-copilot", config, options: { model: "m", timeoutMs: 5, attemptPolicy: { maxAttempts: 1 } } })
    expect(pingInProcess).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "engine.provider_ping_child_done", meta: { provider: "github-copilot", ok: false } }))
  })

  it("pings in this process when the child gives no usable result or can't start", async () => {
    const pingInProcess = vi.fn(async () => ({ ok: true as const }))
    for (const runChild of [
      async () => ({ code: 1, stdout: "" }),
      async () => ({ code: 0, stdout: "null" }),
      async () => ({ code: 0, stdout: '{"message":"no ok"}' }),
      async () => { throw new Error("spawn EAGAIN") },
      async () => { throw "odd" },
    ]) {
      await expect(pingProviderInChild("github-copilot", config, { model: "m" }, { runChild, pingInProcess })).resolves.toEqual({ ok: true })
    }
    expect(pingInProcess).toHaveBeenCalledTimes(5)
    expect(pingInProcess).toHaveBeenCalledWith("github-copilot", config, { model: "m" })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "engine.provider_ping_child_fallback", meta: { provider: "github-copilot", failure: "spawn EAGAIN" } }))
  })

  it("keeps a ping with progress callbacks in this process", async () => {
    const runChild = vi.fn()
    const pingInProcess = vi.fn(async () => ({ ok: true as const }))
    for (const options of [{ onRetry: () => undefined }, { onAttemptStart: () => undefined }, { sleep: async () => undefined }]) {
      await pingProviderInChild("anthropic", config, options, { runChild, pingInProcess })
    }
    expect(runChild).not.toHaveBeenCalled()
    expect(pingInProcess).toHaveBeenCalledTimes(3)
  })

  it("falls back to a real in-process ping by default when the built entry isn't there", async () => {
    // Under the test runner the compiled entry doesn't exist, so the child exits without a result.
    await expect(pingProviderInChild("github-copilot", {})).resolves.toMatchObject({ ok: false, classification: "auth-failure", message: "no credentials configured" })
  }, 30_000)
})

describe("serveProviderPingChild", () => {
  it("reads the whole request, pings, and writes one JSON line", async () => {
    const ping = vi.fn(async () => ({ ok: true as const }))
    const written: string[] = []
    const request = JSON.stringify({ provider: "github-copilot", config, options: { model: "m" } })
    const code = await serveProviderPingChild([request.slice(0, 10), Buffer.from(request.slice(10))], (text) => written.push(text), ping)
    expect(code).toBe(0)
    expect(ping).toHaveBeenCalledWith("github-copilot", config, { model: "m" })
    expect(written).toEqual(['{"ok":true}\n'])
  })

  it("answers nothing and exits 2 for an unreadable request", async () => {
    const ping = vi.fn()
    const written: string[] = []
    expect(await serveProviderPingChild(["{not json"], (text) => written.push(text), ping)).toBe(2)
    expect(ping).not.toHaveBeenCalled()
    expect(written).toEqual([])
  })

  it("pings for real by default", async () => {
    const written: string[] = []
    await serveProviderPingChild([JSON.stringify({ provider: "github-copilot", config: {}, options: {} })], (text) => written.push(text))
    expect(JSON.parse(written[0]!)).toMatchObject({ ok: false, message: "no credentials configured" })
  })
})

describe("runProviderPingChild", () => {
  it("sends the request on stdin and collects stdout and the exit code", async () => {
    const entry = tempScript('let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({ok:true,echo:JSON.parse(s)}));process.exitCode=3})')
    const outcome = await runProviderPingChild('{"provider":"x"}', entry)
    expect(outcome.code).toBe(3)
    expect(JSON.parse(outcome.stdout)).toEqual({ ok: true, echo: { provider: "x" } })
  })

  it("kills a child that never answers", async () => {
    const entry = tempScript("setInterval(() => {}, 1000)")
    const outcome = await runProviderPingChild("{}", entry, 200)
    expect(outcome).toEqual({ code: null, stdout: "" })
  })
})
