import { describe, expect, it } from "vitest"

import { defaultCmuxSocketPath, defaultHerdrSocketPath, resolveShepherdConnection, shepherdConfigFacts, shepherdRepairHint, shepherdSenseStatus } from "../../heart/shepherd-config"

describe("Shepherd machine config", () => {
  it("names the human repair with the agent", () => {
    expect(shepherdRepairHint("slugger")).toBe(`human-required: in a cmux terminal run 'ouro vault config set --agent slugger --scope machine --key cmux.socketCapability --value "$CMUX_SOCKET_CAPABILITY"' (or set cmux.socketPassword when cmux is in password mode), then 'ouro up'.`)
  })

  it("reports a machine without a terminal host as optional, and a half-configured cmux as missing auth", () => {
    expect(shepherdConfigFacts({})).toEqual({ configured: false, optional: true, detail: "no terminal host attached on this machine" })
    expect(shepherdConfigFacts({ cmux: ["nope"] })).toEqual({ configured: false, optional: true, detail: "no terminal host attached on this machine" })
    expect(shepherdConfigFacts({ cmux: { socketPath: "/s", socketCapability: "  " } })).toEqual({ configured: false, detail: "missing cmux.socketCapability" })
  })

  it("prefers the capability token, then the password, then explicit automation mode", () => {
    expect(shepherdConfigFacts({ cmux: { socketCapability: "v1.a.b", socketPassword: "pw" } })).toEqual({ configured: true, detail: "cmux socket auth: capability" })
    expect(shepherdConfigFacts({ cmux: { socketPassword: "pw", socketMode: "automation" } })).toEqual({ configured: true, detail: "cmux socket auth: password" })
    expect(shepherdConfigFacts({ cmux: { socketMode: "automation" } })).toEqual({ configured: true, detail: "cmux socket auth: automation mode" })
    expect(shepherdConfigFacts({ cmux: { socketMode: 7 } })).toMatchObject({ configured: false })
  })

  it("says disabled, ready, not attached or needs config", () => {
    expect(shepherdSenseStatus(false, {})).toBe("disabled")
    expect(shepherdSenseStatus(true, { cmux: { socketCapability: "v1.a.b" } })).toBe("ready")
    expect(shepherdSenseStatus(true, {})).toBe("not_attached")
    expect(shepherdSenseStatus(true, { cmux: {} })).toBe("needs_config")
  })

  it("uses cmux's per-user socket and falls back to the older shared one only when that is all there is", () => {
    const exists = (present: string[]) => (candidate: string) => present.includes(candidate)
    expect(defaultCmuxSocketPath("/h", 502, exists([]))).toBe("/h/.local/state/cmux/cmux-502.sock")
    expect(defaultCmuxSocketPath("/h", 502, exists(["/h/.local/state/cmux/cmux.sock"]))).toBe("/h/.local/state/cmux/cmux.sock")
    expect(defaultCmuxSocketPath("/h", 502, exists(["/h/.local/state/cmux/cmux.sock", "/h/.local/state/cmux/cmux-502.sock"]))).toBe("/h/.local/state/cmux/cmux-502.sock")
    expect(defaultCmuxSocketPath()).toMatch(/\.local\/state\/cmux\/cmux(-\d+)?\.sock$/)
    const getuid = process.getuid
    try {
      Object.defineProperty(process, "getuid", { value: undefined, configurable: true, writable: true })
      expect(defaultCmuxSocketPath("/h", undefined, exists([]))).toBe("/h/.local/state/cmux/cmux-0.sock")
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true, writable: true })
    }
  })

  it("resolves the connection or explains the repair", () => {
    expect(resolveShepherdConnection("slugger", { cmux: { socketCapability: "v1.a.b", socketPath: " /custom.sock " } }))
      .toEqual({ ok: true, connection: { host: "cmux", socketPath: "/custom.sock", auth: { kind: "capability", token: "v1.a.b" } } })
    expect(resolveShepherdConnection("slugger", { cmux: { socketPassword: "pw" } }, () => "/default.sock"))
      .toEqual({ ok: true, connection: { host: "cmux", socketPath: "/default.sock", auth: { kind: "password", password: "pw" } } })
    const missing = resolveShepherdConnection("slugger", {})
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error).toContain("no terminal host is attached on this machine; human-required:")
  })

  it("attaches Herdr from its own record, with cmux winning when both are set", () => {
    expect(shepherdConfigFacts({ herdr: {} })).toEqual({ configured: true, detail: "herdr socket" })
    expect(shepherdSenseStatus(true, { herdr: {}, cmux: {} })).toBe("ready")
    expect(resolveShepherdConnection("slugger", { herdr: { socketPath: "/h.sock" } })).toEqual({ ok: true, connection: { host: "herdr", socketPath: "/h.sock" } })
    expect(resolveShepherdConnection("slugger", { herdr: {} })).toEqual({ ok: true, connection: { host: "herdr", socketPath: defaultHerdrSocketPath() } })
    expect(resolveShepherdConnection("slugger", { herdr: {}, cmux: { socketCapability: "v1.a.b" } })).toMatchObject({ ok: true, connection: { host: "cmux" } })
    expect(defaultHerdrSocketPath("/h")).toBe("/h/.config/herdr/herdr.sock")
  })
})
