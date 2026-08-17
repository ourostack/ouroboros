import { createRequire } from "module"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

const helperPath = path.join(process.cwd(), "assets", "bluebubbles-host")
const loadHelper = () => createRequire(import.meta.url)(helperPath) as {
  constants: Record<string, string | number>
  createRuntime: (overrides?: Record<string, unknown>) => Record<string, any>
  nativePlist: () => string
  validateRequest: (request: Record<string, unknown>, requestPath: string, runtime: Record<string, unknown>) => Record<string, unknown>
  inspect: (request: Record<string, unknown>, runtime: Record<string, unknown>) => Record<string, unknown>
  execute: (request: Record<string, unknown>, runtime: Record<string, unknown>) => Record<string, unknown>
  publishReceipt: (
    request: Record<string, unknown>,
    result: string,
    detail: string,
    state: Record<string, unknown>,
    runtime: Record<string, unknown>,
  ) => void
  main: (runtime: Record<string, unknown>) => void
  runCli: (runtime: Record<string, unknown>) => void
  runCliIfMain: (isMain: boolean, runtime: Record<string, unknown>) => void
}

const NOW = Date.parse("2026-08-17T17:00:00.000Z")
const NONCE = "ab".repeat(32)
const REQUEST_ID = `502-${NONCE}`
const REQUEST_PATH = `/Users/Shared/Ouro/bluebubbles-host-requests/${REQUEST_ID}.json`
const PLIST_PATH = "/Users/clawdbot/Library/LaunchAgents/com.bluebubbles.server.plist"

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    helperVersion: 1,
    requestId: REQUEST_ID,
    nonce: NONCE,
    action: "install",
    username: "clawdbot",
    uid: 502,
    requestedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(),
    ...overrides,
  }
}

function runtime(input: {
  request?: Record<string, unknown>
  appPresent?: boolean
  plist?: string
  loaded?: boolean
  launchctlFailure?: string
} = {}) {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  const calls: Array<{ command: string; args: string[]; options: unknown }> = []
  const output: string[] = []
  const errors: string[] = []
  let loaded = input.loaded ?? false
  if (input.request) files.set(REQUEST_PATH, JSON.stringify(input.request))
  if (input.appPresent ?? true) files.set("/Applications/BlueBubbles.app", "app")
  if (typeof input.plist === "string") files.set(PLIST_PATH, input.plist)
  const eexist = () => Object.assign(new Error("EEXIST"), { code: "EEXIST" })
  const fs = {
    existsSync: (filePath: string) => files.has(filePath),
    readFileSync: (filePath: string) => {
      const value = files.get(filePath)
      if (value === undefined) throw new Error(`ENOENT ${filePath}`)
      return value
    },
    mkdirSync: vi.fn(),
    writeFileSync: (filePath: string, content: string, options?: { flag?: string; mode?: number }) => {
      if (options?.flag === "wx" && files.has(filePath)) throw eexist()
      files.set(filePath, content)
      if (options?.mode) modes.set(filePath, options.mode)
    },
    chmodSync: (filePath: string, mode: number) => { modes.set(filePath, mode) },
    linkSync: (source: string, destination: string) => {
      if (files.has(destination)) throw eexist()
      files.set(destination, files.get(source)!)
    },
    unlinkSync: (filePath: string) => { files.delete(filePath) },
  }
  const execFileSync = (command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options })
    if (command === "id") return "clawdbot\n"
    if (args.join(" ") === "print gui/502") return "gui session\n"
    if (args[0] === input.launchctlFailure) throw new Error(`${args[0]} denied`)
    if (args[0] === "print") {
      if (!loaded) throw new Error("not loaded")
      return "loaded\n"
    }
    if (args[0] === "bootout") loaded = false
    if (args[0] === "bootstrap") loaded = true
    return "ok\n"
  }
  const result = {
    fs,
    path,
    homedir: () => "/Users/clawdbot",
    now: () => NOW + 1_000,
    getuid: () => 502,
    execFileSync,
    argv: ["node", helperPath, "--request", REQUEST_PATH],
    writeStdout: (value: string) => { output.push(value) },
    writeStderr: (value: string) => { errors.push(value) },
    setExitCode: vi.fn(),
  }
  return { runtime: result, files, modes, calls, output, errors, setLoaded: (value: boolean) => { loaded = value } }
}

describe("packaged BlueBubbles host helper", () => {
  it("exports its testable credential-free runtime contract", () => {
    const helper = loadHelper()
    expect(helper.constants).toMatchObject({ schemaVersion: 1, helperVersion: 1, freshnessMs: 300_000 })
    expect(helper.nativePlist()).toContain("com.bluebubbles.server")
    expect(helper.runCli).toBeTypeOf("function")
    const h = runtime()
    helper.runCliIfMain(false, h.runtime)
    expect(h.runtime.setExitCode).not.toHaveBeenCalled()
  })

  it("runs the explicit main-entry seam", () => {
    const helper = loadHelper()
    const h = runtime()
    h.runtime.argv = ["node", helperPath]
    helper.runCliIfMain(true, h.runtime)
    expect(h.errors.join(" ")).toContain("usage: bluebubbles-host --request")
    expect(h.runtime.setExitCode).toHaveBeenCalledWith(1)
  })

  it("covers the real default runtime adapters without leaking output", () => {
    const helper = loadHelper()
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const previousExitCode = process.exitCode
    const runtime = helper.createRuntime({ argv: ["node", helperPath] })

    try {
      expect(runtime.getuid()).toBe(process.getuid())
      expect(runtime.now()).toBeTypeOf("number")
      expect(runtime.homedir()).toBeTypeOf("string")
      runtime.writeStdout("test")
      runtime.writeStderr("test")
      runtime.setExitCode(7)
      expect(process.exitCode).toBe(7)
      expect(stdout).toHaveBeenCalledWith("test")
      expect(stderr).toHaveBeenCalledWith("test")
    } finally {
      process.exitCode = previousExitCode
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })

  it("validates the exact target actor and GUI launchd domain argv", () => {
    const helper = loadHelper()
    const h = runtime()

    expect(helper.validateRequest(request(), REQUEST_PATH, h.runtime)).toMatchObject({ requestId: REQUEST_ID })
    expect(h.calls).toEqual([
      { command: "id", args: ["-un"], options: { encoding: "utf8" } },
      {
        command: "launchctl",
        args: ["print", "gui/502"],
        options: { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      },
    ])
  })

  it("normalizes empty and non-Error launchctl output and rejects actor/session mismatches", () => {
    const helper = loadHelper()
    const empty = runtime()
    empty.runtime.execFileSync = (command: string, args: string[]) => {
      if (command === "id") return "clawdbot\n"
      if (args.join(" ") === "print gui/502") return ""
      throw new Error("unexpected")
    }
    expect(helper.validateRequest(request(), REQUEST_PATH, empty.runtime)).toMatchObject({ requestId: REQUEST_ID })

    const wrongUid = runtime()
    wrongUid.runtime.getuid = () => 501
    expect(() => helper.validateRequest(request(), REQUEST_PATH, wrongUid.runtime)).toThrow("exact target user")

    const wrongName = runtime()
    wrongName.runtime.execFileSync = (command: string, args: string[], options: unknown) => {
      if (command === "id") return "someone-else\n"
      return runtime().runtime.execFileSync(command, args, options)
    }
    expect(() => helper.validateRequest(request(), REQUEST_PATH, wrongName.runtime)).toThrow("exact target user")

    const noSession = runtime()
    noSession.runtime.execFileSync = (command: string) => {
      if (command === "id") return "clawdbot\n"
      throw "launchctl unavailable"
    }
    expect(() => helper.validateRequest(request(), REQUEST_PATH, noSession.runtime)).toThrow(
      "launchctl print gui/502 failed: launchctl unavailable",
    )
  })

  it.each([
    ["path", request(), "/tmp/request.json", "outside the shared request directory"],
    ["schema", request({ schemaVersion: 2 }), REQUEST_PATH, "unsupported request schema"],
    ["helper", request({ helperVersion: 2 }), REQUEST_PATH, "unsupported helper version"],
    ["username", request({ username: "../root" }), REQUEST_PATH, "invalid target username"],
    ["uid", request({ uid: 499, requestId: `499-${NONCE}` }), REQUEST_PATH, "invalid target uid"],
    ["nonce", request({ nonce: "ABC" }), REQUEST_PATH, "invalid request nonce"],
    ["id", request({ requestId: `503-${NONCE}` }), REQUEST_PATH, "request id mismatch"],
    ["action", request({ action: "explode" }), REQUEST_PATH, "unsupported host action"],
    ["time", request({ requestedAt: "bad" }), REQUEST_PATH, "invalid request time"],
    ["window", request({ expiresAt: new Date(NOW + 300_001).toISOString() }), REQUEST_PATH, "freshness window is too large"],
    ["future", request({ requestedAt: new Date(NOW + 2_000).toISOString() }), REQUEST_PATH, "request is not fresh"],
  ])("rejects invalid %s request", (_label, value, requestPath, message) => {
    const helper = loadHelper()
    const h = runtime()
    expect(() => helper.validateRequest(value, requestPath, h.runtime)).toThrow(message)
  })

  it("installs and verifies exact native lifecycle argv", () => {
    const helper = loadHelper()
    const h = runtime()

    const state = helper.execute(request(), h.runtime)

    expect(state).toMatchObject({ plist: "current", service: { ok: true } })
    expect(h.files.get(PLIST_PATH)).toBe(helper.nativePlist())
    expect(h.calls.map((call) => call.args)).toEqual([
      ["print", "gui/502/com.bluebubbles.server"],
      ["disable", "gui/502/com.bluebubbles.server"],
      ["enable", "gui/502/com.bluebubbles.server"],
      ["bootstrap", "gui/502", PLIST_PATH],
      ["print", "gui/502/com.bluebubbles.server"],
    ])
  })

  it("keeps current loaded setup idempotent and repairs drift with bootout first", () => {
    const helper = loadHelper()
    const current = runtime({ plist: helper.nativePlist(), loaded: true })
    expect(helper.execute(request(), current.runtime)).toMatchObject({ plist: "current" })
    expect(current.calls.map((call) => call.args)).toEqual([["print", "gui/502/com.bluebubbles.server"]])

    const drift = runtime({ plist: "stale", loaded: true })
    helper.execute(request({ action: "repair" }), drift.runtime)
    expect(drift.calls.map((call) => call.args)).toEqual([
      ["print", "gui/502/com.bluebubbles.server"],
      ["bootout", "gui/502/com.bluebubbles.server"],
      ["disable", "gui/502/com.bluebubbles.server"],
      ["enable", "gui/502/com.bluebubbles.server"],
      ["bootstrap", "gui/502", PLIST_PATH],
      ["print", "gui/502/com.bluebubbles.server"],
    ])
  })

  it("loads a current but unloaded plist without rewriting it", () => {
    const helper = loadHelper()
    const h = runtime({ plist: helper.nativePlist(), loaded: false })

    helper.execute(request({ action: "repair" }), h.runtime)

    expect(h.runtime.fs.mkdirSync).not.toHaveBeenCalled()
    expect(h.calls.map((call) => call.args)).toEqual([
      ["print", "gui/502/com.bluebubbles.server"],
      ["disable", "gui/502/com.bluebubbles.server"],
      ["enable", "gui/502/com.bluebubbles.server"],
      ["bootstrap", "gui/502", PLIST_PATH],
      ["print", "gui/502/com.bluebubbles.server"],
    ])
  })

  it("removes loaded state idempotently and status fails when not loaded", () => {
    const helper = loadHelper()
    const loaded = runtime({ plist: helper.nativePlist(), loaded: true })
    expect(helper.execute(request({ action: "remove" }), loaded.runtime)).toMatchObject({ plist: "missing" })
    expect(loaded.calls.map((call) => call.args)).toEqual([
      ["print", "gui/502/com.bluebubbles.server"],
      ["disable", "gui/502/com.bluebubbles.server"],
      ["bootout", "gui/502/com.bluebubbles.server"],
      ["print", "gui/502/com.bluebubbles.server"],
    ])
    expect(() => helper.execute(request({ action: "status" }), runtime().runtime)).toThrow("not current and loaded")

    const currentUnloaded = runtime({ plist: helper.nativePlist(), loaded: false })
    expect(() => helper.execute(request({ action: "status" }), currentUnloaded.runtime)).toThrow("not current and loaded")

    const alreadyRemoved = runtime()
    expect(helper.execute(request({ action: "remove" }), alreadyRemoved.runtime)).toMatchObject({ plist: "missing" })
    expect(alreadyRemoved.calls.map((call) => call.args)).toEqual([
      ["print", "gui/502/com.bluebubbles.server"],
      ["print", "gui/502/com.bluebubbles.server"],
    ])

    const healthy = runtime({ plist: helper.nativePlist(), loaded: true })
    expect(helper.execute(request({ action: "status" }), healthy.runtime)).toMatchObject({ plist: "current" })
  })

  it.each(["disable", "enable", "bootstrap"])("surfaces launchctl %s failure", (verb) => {
    const helper = loadHelper()
    const h = runtime({ launchctlFailure: verb })
    expect(() => helper.execute(request(), h.runtime)).toThrow(`launchctl ${verb} failed: ${verb} denied`)
  })

  it("fails closed when remove or install cannot be verified", () => {
    const helper = loadHelper()
    const remove = runtime({ plist: helper.nativePlist(), loaded: true })
    remove.runtime.fs.unlinkSync = vi.fn()
    expect(() => helper.execute(request({ action: "remove" }), remove.runtime)).toThrow("removal did not verify")

    const noService = runtime()
    const originalExec = noService.runtime.execFileSync
    noService.runtime.execFileSync = (command: string, args: string[], options: unknown) => {
      if (args[0] === "bootstrap") return "ok\n"
      return originalExec(command, args, options)
    }
    noService.setLoaded(false)
    expect(() => helper.execute(request(), noService.runtime)).toThrow("installation did not verify")

    const noPlist = runtime()
    noPlist.runtime.fs.writeFileSync = (filePath: string, content: string, options?: { flag?: string; mode?: number }) => {
      if (options?.flag === "wx") noPlist.files.set(filePath, content)
    }
    expect(() => helper.execute(request(), noPlist.runtime)).toThrow("installation did not verify")
  })

  it("publishes one read-only no-clobber receipt", () => {
    const helper = loadHelper()
    const h = runtime()
    const state = { plistPath: PLIST_PATH, serviceTarget: "gui/502/com.bluebubbles.server" }

    helper.publishReceipt(request(), "verified", "ok", state, h.runtime)
    const finalPath = `/Users/Shared/Ouro/bluebubbles-host-receipts/${REQUEST_ID}.json`
    expect(JSON.parse(h.files.get(finalPath)!)).toMatchObject({ result: "verified", verifiedAt: new Date(NOW + 1_000).toISOString() })
    expect(h.modes.get(finalPath)).toBe(0o444)
    expect(() => helper.publishReceipt(request(), "verified", "ok", state, h.runtime)).toThrow("EEXIST")
  })

  it("cleans receipt temporary state after an unexpected link failure", () => {
    const helper = loadHelper()
    const h = runtime()
    const state = { plistPath: PLIST_PATH, serviceTarget: "gui/502/com.bluebubbles.server" }
    const temporaryPath = `/Users/Shared/Ouro/bluebubbles-host-receipts/${REQUEST_ID}.json.${NONCE}.tmp`
    h.runtime.fs.linkSync = (source: string) => {
      h.files.delete(source)
      throw new Error("link failed")
    }

    expect(() => helper.publishReceipt(request(), "failed", "no", state, h.runtime)).toThrow("link failed")
    expect(h.files.has(temporaryPath)).toBe(false)
  })

  it("main publishes verified evidence on success", () => {
    const helper = loadHelper()
    const h = runtime({ request: request({ action: "remove" }) })

    helper.main(h.runtime)

    const finalPath = `/Users/Shared/Ouro/bluebubbles-host-receipts/${REQUEST_ID}.json`
    expect(JSON.parse(h.files.get(finalPath)!)).toMatchObject({ result: "verified", detail: "native remove verified" })
  })

  it("main publishes failed lifecycle evidence and runCli returns one sanitized error", () => {
    const helper = loadHelper()
    const h = runtime({ request: request(), appPresent: false })

    helper.runCli(h.runtime)

    const finalPath = `/Users/Shared/Ouro/bluebubbles-host-receipts/${REQUEST_ID}.json`
    expect(JSON.parse(h.files.get(finalPath)!)).toMatchObject({ result: "failed" })
    expect(h.errors.join(" ")).toContain("BlueBubbles app is missing")
    expect(h.runtime.setExitCode).toHaveBeenCalledWith(1)
  })

  it("normalizes non-Error main and CLI failures", () => {
    const helper = loadHelper()
    const mainFailure = runtime({ request: request() })
    let existsCalls = 0
    const defaultExists = mainFailure.runtime.fs.existsSync
    mainFailure.runtime.fs.existsSync = (filePath: string) => {
      existsCalls++
      if (existsCalls === 2) throw "app lookup failed"
      return defaultExists(filePath)
    }
    expect(() => helper.main(mainFailure.runtime)).toThrow("app lookup failed")
    expect([...mainFailure.files.values()].some((value) => value.includes('"detail": "app lookup failed"'))).toBe(true)

    const cliFailure = runtime()
    cliFailure.runtime.fs.readFileSync = () => { throw "request read failed" }
    helper.runCli(cliFailure.runtime)
    expect(cliFailure.errors.join(" ")).toContain("request read failed")
    expect(cliFailure.runtime.setExitCode).toHaveBeenCalledWith(1)
  })

  it.each([
    [["node", helperPath], "usage: bluebubbles-host"],
    [["node", helperPath, "--request"], "usage: bluebubbles-host"],
  ])("rejects incomplete argv %j", (argv, message) => {
    const helper = loadHelper()
    const h = runtime()
    h.runtime.argv = argv
    expect(() => helper.main(h.runtime)).toThrow(message)
  })
})
