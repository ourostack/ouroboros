import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

const BUNDLED = "/opt/ouro/node_modules/@bitwarden/cli/build/bw.js"
const ON_PATH = "/usr/local/bin/bw"
const installer = vi.hoisted(() => ({ broken: false, marked: [] as string[] }))

// A stateful stand-in for bw-installer: the bundled bw until it is marked broken, then bw on PATH.
vi.mock("../../repertoire/bw-installer", () => ({
  bwCommand: (file: string, args: string[]) => ({ file, args }),
  ensureBwCli: vi.fn(async () => (installer.broken ? "/usr/local/bin/bw" : "/opt/ouro/node_modules/@bitwarden/cli/build/bw.js")),
  isBundledBw: (bwBinaryPath: string) => bwBinaryPath === "/opt/ouro/node_modules/@bitwarden/cli/build/bw.js",
  isBwMissingModuleError: (error: Error) => /\bCannot find module\b/.test(error.message),
  markBundledBwBroken: (reason: string) => {
    installer.broken = true
    installer.marked.push(reason)
  },
}))

const mockExecFile = vi.fn()
vi.mock("node:child_process", () => ({ execFile: (...args: unknown[]) => mockExecFile(...args) }))

import { BitwardenCredentialStore } from "../../repertoire/bitwarden-store"

const MISSING = "Error: Cannot find module '../internals/hidden-keys'"
const ITEM = JSON.stringify([{ id: "item-1", name: "test.com", login: { username: "u", password: "p" }, revisionDate: "2026-01-15T00:00:00.000Z" }])

/** A working bw, except that `brokenBinary` fails every command from `failFrom` on with a missing module. */
function bw(options: { brokenBinary?: string; failFrom?: (args: string[]) => boolean } = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  let failing = false
  mockExecFile.mockImplementation((file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ file, args })
    if (file === options.brokenBinary && (failing || (options.failFrom?.(args) ?? true))) {
      failing = true
      cb(Object.assign(new Error("Command failed"), { code: 1 }), "", MISSING)
      return
    }
    if (args[0] === "status") return cb(null, JSON.stringify({ status: "unlocked" }), "")
    if (args[0] === "unlock") return cb(null, `session-${file === ON_PATH ? "path" : "bundled"}`, "")
    if (args[0] === "list") return cb(null, ITEM, "")
    cb(null, "", "")
  })
  return calls
}

describe("BitwardenCredentialStore with a damaged bundled bw", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installer.broken = false
    installer.marked = []
  })

  it("switches to bw on PATH when the bundled bw cannot load a module at sign-in", async () => {
    const calls = bw({ brokenBinary: BUNDLED })
    const progress: string[] = []
    const store = new BitwardenCredentialStore("https://vault.example", "agent@example.com", "pw", { onProgress: (detail) => progress.push(detail) })

    const result = await store.get("test.com")

    expect(result?.username).toBe("u")
    expect(installer.marked).toEqual([`bw CLI error: ${MISSING}`])
    const firstOnPath = calls.findIndex((call) => call.file === ON_PATH)
    expect(firstOnPath).toBeGreaterThan(0)
    expect(calls.slice(firstOnPath).some((call) => call.file === BUNDLED)).toBe(false)
    expect(calls.some((call) => call.file === ON_PATH && call.args[0] === "list")).toBe(true)
    expect(progress).toContain("the bundled Bitwarden CLI is damaged; switching to the bw on PATH")
  })

  it("switches mid-session when a module disappears from the bundled bw after sign-in", async () => {
    const calls = bw({ brokenBinary: BUNDLED, failFrom: (args) => args[0] === "list" })
    const store = new BitwardenCredentialStore("https://vault.example", "agent@example.com", "pw")

    const result = await store.get("test.com")

    expect(result?.username).toBe("u")
    expect(installer.marked).toHaveLength(1)
    const pathCalls = calls.filter((call) => call.file === ON_PATH).map((call) => call.args[0])
    expect(pathCalls).toContain("unlock")
    expect(pathCalls).toContain("list")
  })

  it("does not switch for a missing module in a bw that is not the bundled one, and never loops", async () => {
    installer.broken = true
    bw({ brokenBinary: ON_PATH })
    const store = new BitwardenCredentialStore("https://vault.example", "agent@example.com", "pw")

    await expect(store.get("test.com")).rejects.toThrow("Cannot find module")
    expect(installer.marked).toEqual([])
  })
})
