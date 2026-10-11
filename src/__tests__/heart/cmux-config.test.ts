import { describe, expect, it } from "vitest"

import { cmuxConfigFacts, cmuxRepairHint, defaultCmuxSocketPath, resolveCmuxConnection } from "../../heart/cmux-config"

describe("cmux machine config", () => {
  it("names the human repair with the agent", () => {
    expect(cmuxRepairHint("slugger")).toBe(`human-required: in a cmux terminal run 'ouro vault config set --agent slugger --scope machine --key cmux.socketCapability --value "$CMUX_SOCKET_CAPABILITY"' (or set cmux.socketPassword when cmux is in password mode), then 'ouro up'.`)
  })

  it("reports a machine without cmux as optional, and a half-configured one as missing auth", () => {
    expect(cmuxConfigFacts({})).toEqual({ configured: false, optional: true, detail: "not attached on this machine" })
    expect(cmuxConfigFacts({ cmux: ["nope"] })).toEqual({ configured: false, optional: true, detail: "not attached on this machine" })
    expect(cmuxConfigFacts({ cmux: { socketPath: "/s", socketCapability: "  " } })).toEqual({ configured: false, detail: "missing cmux.socketCapability" })
  })

  it("prefers the capability token, then the password, then explicit automation mode", () => {
    expect(cmuxConfigFacts({ cmux: { socketCapability: "v1.a.b", socketPassword: "pw" } })).toEqual({ configured: true, detail: "socket auth: capability" })
    expect(cmuxConfigFacts({ cmux: { socketPassword: "pw", socketMode: "automation" } })).toEqual({ configured: true, detail: "socket auth: password" })
    expect(cmuxConfigFacts({ cmux: { socketMode: "automation" } })).toEqual({ configured: true, detail: "socket auth: automation mode" })
    expect(cmuxConfigFacts({ cmux: { socketMode: 7 } })).toMatchObject({ configured: false })
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
    expect(resolveCmuxConnection("slugger", { cmux: { socketCapability: "v1.a.b", socketPath: " /custom.sock " } }))
      .toEqual({ ok: true, connection: { socketPath: "/custom.sock", auth: { kind: "capability", token: "v1.a.b" } } })
    expect(resolveCmuxConnection("slugger", { cmux: { socketPassword: "pw" } }, () => "/default.sock"))
      .toEqual({ ok: true, connection: { socketPath: "/default.sock", auth: { kind: "password", password: "pw" } } })
    const missing = resolveCmuxConnection("slugger", {})
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error).toContain("cmux socket auth is not configured on this machine; human-required:")
  })
})
