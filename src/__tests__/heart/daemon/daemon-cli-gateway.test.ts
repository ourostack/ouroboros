import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emitNervesEvent } from "../../../nerves/runtime"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { getCommandHelp } from "../../../heart/daemon/cli-help"

function emitTestEvent(testName: string): void {
  emitNervesEvent({ component: "daemon", event: "daemon.test_run", message: testName, meta: { test: true } })
}

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

describe("ouro gateway serve", () => {
  it("parses every flag", () => {
    emitTestEvent("gateway serve parse")
    expect(parseOuroCommand(["gateway", "serve", "--keys-dir", "/keys"])).toEqual({ kind: "gateway.serve", keysDir: "/keys" })
    expect(parseOuroCommand([
      "gateway", "serve", "--keys-dir", "/keys", "--host", "0.0.0.0", "--port", "8799", "--state", "/state.json",
      "--upstream", "http://127.0.0.1:9000", "--cooldown-minutes", "1.5",
    ])).toEqual({
      kind: "gateway.serve",
      keysDir: "/keys",
      host: "0.0.0.0",
      port: 8799,
      statePath: "/state.json",
      upstream: "http://127.0.0.1:9000",
      cooldownMinutes: 1.5,
    })
    expect(parseOuroCommand(["gateway", "serve", "--keys-dir", "/keys", "--port", "0"])).toEqual({ kind: "gateway.serve", keysDir: "/keys", port: 0 })
  })

  it("rejects malformed input", () => {
    emitTestEvent("gateway serve parse errors")
    expect(() => parseOuroCommand(["gateway"])).toThrow(/Usage: ouro gateway serve/)
    expect(() => parseOuroCommand(["gateway", "run"])).toThrow(/Usage: ouro gateway serve/)
    expect(() => parseOuroCommand(["gateway", "serve"])).toThrow(/Usage: ouro gateway serve/)
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir"])).toThrow(/Usage: ouro gateway serve/)
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir", "--port"])).toThrow(/Usage: ouro gateway serve/)
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir", "/k", "--wat", "x"])).toThrow(/Usage: ouro gateway serve/)
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir", "/k", "--port", "70000"])).toThrow("Gateway port must be 0-65535")
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir", "/k", "--port", "1.5"])).toThrow("Gateway port must be 0-65535")
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir", "/k", "--cooldown-minutes", "0"])).toThrow("--cooldown-minutes must be a positive number")
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir", "/k", "--cooldown-minutes", "soon"])).toThrow("--cooldown-minutes must be a positive number")
    expect(() => parseOuroCommand(["gateway", "serve", "--keys-dir", "/k", "--upstream", "api.anthropic.com"])).toThrow("--upstream must be an http(s) URL")
  })

  it("has help text", () => {
    emitTestEvent("gateway serve help")
    expect(parseOuroCommand(["gateway", "serve", "--help"])).toEqual({ kind: "help", command: "gateway serve" })
    expect(getCommandHelp("gateway serve")).toContain("ouro gateway serve --keys-dir <dir>")
    expect(getCommandHelp("gateway")).toContain("ouro gateway serve")
  })

  it("starts the gateway, prints where it listens, and stops on the shutdown signal", async () => {
    emitTestEvent("gateway serve run")
    const keysDir = mkdtempSync(join(tmpdir(), "gateway-cli-"))
    writeFileSync(join(keysDir, "master.key"), "ouro-gw-test")
    writeFileSync(join(keysDir, "acct1.key"), "sk-ant-usr-test")
    try {
      const deps = createMockDeps({ waitForShutdownSignal: () => Promise.resolve() })
      const message = await runOuroCli(["gateway", "serve", "--keys-dir", keysDir, "--port", "0"], deps)
      expect(message).toMatch(/^credit gateway listening on http:\/\/127\.0\.0\.1:\d+\nhealth: /)
      expect(deps.writeStdout).toHaveBeenCalledWith(message)
      expect(deps.sendCommand).not.toHaveBeenCalled()
      await expect(runOuroCli(["gateway", "serve", "--keys-dir", join(keysDir, "missing"), "--port", "0"], deps)).rejects.toThrow(/cannot read keys directory/)
    } finally {
      rmSync(keysDir, { recursive: true, force: true })
    }
  })
})
