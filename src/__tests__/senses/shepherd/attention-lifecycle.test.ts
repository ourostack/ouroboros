import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runShepherdAttention, startManagedShepherdAttention } from "../../../senses/shepherd/attention"

const runtime = vi.hoisted(() => ({
  home: "",
  spawn: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  owner: vi.fn(),
}))
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => runtime.home }))
vi.mock("node:child_process", () => ({ spawnSync: runtime.spawn }))
vi.mock("../../../senses/shepherd/surface", async original => ({
  ...await original<typeof import("../../../senses/shepherd/surface")>(),
  localShepherdFriendStore: () => ({}),
  resolveExistingLocalOwner: runtime.owner,
}))
vi.mock("../../../heart/frontend-socket-client", () => ({
  SocketFrontendClient: class {
    request = runtime.request
    close = runtime.close
    onEvent() { return () => {} }
    onClose() { return () => {} }
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  runtime.home = fs.mkdtempSync(path.join(os.tmpdir(), "attention-lifecycle-"))
  runtime.owner.mockResolvedValue("owner")
  runtime.request.mockResolvedValue({ targets: [] })
  runtime.spawn.mockReturnValue({ status: 0, stdout: "", stderr: "" })
  runtime.close.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe("managed native attention lifecycle", () => {
  it("uses the existing local owner and socket, installs a validated per-agent entry, and closes", async () => {
    runtime.request.mockResolvedValue({ targets: [{ id: "11111111-1111-4111-8111-111111111111", host: "cmux", label: "legacy diagnostic label" }] })
    const app = await startManagedShepherdAttention({ agent: "ouro", socketPath: "/test.frontend" })
    try {
      expect(runtime.owner).toHaveBeenCalled()
      expect(runtime.request).toHaveBeenCalledWith("shepherd.targets", { agent: "ouro", friendId: "owner" })
      expect(runtime.spawn).toHaveBeenCalledWith("cmux", ["sidebar", "validate", "ouro-attention-ouro"], { encoding: "utf8" })
      const source = fs.readFileSync(path.join(runtime.home, ".config/cmux/sidebars/ouro-attention-ouro.swift"), "utf8")
      expect(source).toContain(app.url)
      expect(source).not.toContain("/test.frontend")
      const url = new URL(app.url)
      const state = await (await fetch(`${url.origin}/state`, { headers: { "X-Ouro-Attention": url.hash.slice(1) } })).json()
      expect(state.targets[0].label).toBe("Coding session")
      expect(state.target).toBe("11111111-1111-4111-8111-111111111111")
    } finally { await app.close() }
  })

  it("fails and closes the listener when native validation fails", async () => {
    runtime.spawn.mockReturnValue({ status: 1, stderr: "unsupported sidebar" })
    await expect(startManagedShepherdAttention({ agent: "ouro", socketPath: "/test" })).rejects.toThrow("unsupported sidebar")
    runtime.spawn.mockReturnValue({ error: new Error("cmux missing"), status: null })
    await expect(startManagedShepherdAttention({ agent: "ouro", socketPath: "/test" })).rejects.toThrow("cmux missing")
  })

  it("closes cleanly after an owned signal callback and never sends terminal text", async () => {
    let stop: () => void = () => {}
    const originalOnce = process.once.bind(process)
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") { stop = listener; return process }
      return originalOnce(event, listener)
    })
    const running = runShepherdAttention({ agent: "ouro", session: "11111111-1111-4111-8111-111111111111", socketPath: "/test" })
    runtime.request.mockResolvedValue({ targets: [{ id: "11111111-1111-4111-8111-111111111111", host: "cmux", label: "test" }] })
    await vi.waitFor(() => expect(runtime.spawn.mock.calls.some(([, args]) => args[0] === "browser")).toBe(true))
    stop()
    await running
    expect(runtime.spawn.mock.calls.every(([, args]) => ["sidebar", "browser"].includes(args[0]))).toBe(true)
  })

  it("closes the app and reports an explicit native open error", async () => {
    runtime.spawn.mockImplementation((_command, args) => args[0] === "browser" ? { status: 1, stderr: "open failed" } : { status: 0 })
    await expect(runShepherdAttention({ agent: "ouro", socketPath: "/test" })).rejects.toThrow("open failed")
    runtime.spawn.mockImplementation((_command, args) => args[0] === "browser" ? { error: new Error("open missing") } : { status: 0 })
    await expect(runShepherdAttention({ agent: "ouro", socketPath: "/test" })).rejects.toThrow("open missing")
  })

  it("never replaces the managed native entry with a one-off web listener, even on open failure", async () => {
    const managed = await startManagedShepherdAttention({ agent: "ouro", socketPath: "/test" })
    const file = path.join(runtime.home, ".config/cmux/sidebars/ouro-attention-ouro.swift")
    const original = fs.readFileSync(file, "utf8")
    let stop: () => void = () => {}
    const originalOnce = process.once.bind(process)
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") { stop = listener; return process }
      return originalOnce(event, listener)
    })
    runtime.spawn.mockClear()
    const running = runShepherdAttention({ agent: "ouro", socketPath: "/test" })
    try {
      await vi.waitFor(() => expect(runtime.spawn.mock.calls.some(([, args]) => args[0] === "browser")).toBe(true))
      expect(fs.readFileSync(file, "utf8")).toBe(original)
    } finally {
      stop()
      await running
      runtime.spawn.mockImplementation(() => ({ status: 1, stderr: "one-off open failed" }))
      await expect(runShepherdAttention({ agent: "ouro", socketPath: "/test" })).rejects.toThrow("open failed")
      const final = fs.readFileSync(file, "utf8")
      await managed.close()
      expect(final).toBe(original)
    }
  })

  it("does not create a view when owner or target discovery is unavailable", async () => {
    runtime.owner.mockRejectedValueOnce(new Error("owner unavailable"))
    await expect(startManagedShepherdAttention({ agent: "ouro", socketPath: "/test" })).rejects.toThrow("owner unavailable")
    runtime.request.mockRejectedValueOnce(new Error("daemon unavailable"))
    await expect(startManagedShepherdAttention({ agent: "ouro", socketPath: "/test" })).rejects.toThrow("daemon unavailable")
    expect(runtime.close).toHaveBeenCalled()
  })
})
