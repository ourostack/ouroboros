import { describe, expect, it, vi } from "vitest"

import {
  observeProcessIdentity,
  parseProcessIdentity,
  processIdentityEquals,
  proveExactProcessState,
  type ProcessIdentity,
  type ProcessIdentitySource,
} from "../../../heart/runtime/process-identity"

const identity: ProcessIdentity = {
  uid: 501,
  pid: 4242,
  startIdentity: "darwin-proc:1770000000:000123",
  bootId: "boot-a",
}

function source(overrides: Partial<ProcessIdentitySource> = {}): ProcessIdentitySource {
  return {
    readBootId: vi.fn(() => "boot-a"),
    readProcess: vi.fn(() => ({
      pid: 4242,
      uid: 501,
      startIdentity: "darwin-proc:1770000000:000123",
      executableRealpath: "/usr/local/bin/runtime",
    })),
    ...overrides,
  }
}

describe("ProcessIdentity", () => {
  it("accepts exactly four validated fields", () => {
    expect(parseProcessIdentity(identity)).toEqual(identity)

    for (const value of [
      null,
      "identity",
      [],
      { ...identity, extra: true },
      { ...identity, uid: -1 },
      { ...identity, pid: 0 },
      { ...identity, pid: 1.5 },
      { ...identity, startIdentity: "" },
      { ...identity, bootId: "" },
      { uid: identity.uid, pid: identity.pid, bootId: identity.bootId },
    ]) {
      expect(() => parseProcessIdentity(value)).toThrow(/process identity/i)
    }
  })

  it("rejects incomplete or mismatched injected evidence", () => {
    for (const pid of [0, -1, 1.5]) {
      expect(() => observeProcessIdentity(pid, source())).toThrow(/PID/i)
    }
    expect(() => observeProcessIdentity(4242, source({ readBootId: () => "" }))).toThrow(/boot/i)
    expect(() => observeProcessIdentity(4242, source({ readProcess: () => null }))).toThrow(/absent/i)
    expect(() => observeProcessIdentity(4242, source({
      readProcess: () => ({ pid: 4243, uid: 501, startIdentity: identity.startIdentity, executableRealpath: "/runtime" }),
    }))).toThrow(/PID/i)
    expect(() => observeProcessIdentity(4242, source({
      readProcess: () => ({ pid: 4242, uid: -1, startIdentity: identity.startIdentity, executableRealpath: "/runtime" }),
    }))).toThrow(/UID/i)
    expect(() => observeProcessIdentity(4242, source({
      readProcess: () => ({ pid: 4242, uid: 501, startIdentity: "", executableRealpath: "/runtime" }),
    }))).toThrow(/start/i)
    expect(() => observeProcessIdentity(4242, source({
      readProcess: () => ({ pid: 4242, uid: 501, startIdentity: identity.startIdentity, executableRealpath: "runtime" }),
    }))).toThrow(/executable/i)
  })

  it("constructs identity only from injected boot and process-start evidence", () => {
    const evidence = source()

    expect(observeProcessIdentity(4242, evidence)).toEqual(identity)
    expect(evidence.readBootId).toHaveBeenCalledTimes(1)
    expect(evidence.readProcess).toHaveBeenCalledWith(4242)
  })

  it("requires equality of uid, pid, microsecond start identity, and boot ID", () => {
    expect(processIdentityEquals(identity, { ...identity })).toBe(true)
    expect(processIdentityEquals(identity, { ...identity, uid: 502 })).toBe(false)
    expect(processIdentityEquals(identity, { ...identity, pid: 4243 })).toBe(false)
    expect(processIdentityEquals(identity, { ...identity, startIdentity: "darwin-proc:1770000000:000124" })).toBe(false)
    expect(processIdentityEquals(identity, { ...identity, bootId: "boot-b" })).toBe(false)
  })

  it("distinguishes the exact live owner from same-PID reuse in the same second", () => {
    expect(proveExactProcessState(identity, source())).toEqual({ state: "alive", observed: identity })

    const reused = source({
      readProcess: () => ({
        pid: 4242,
        uid: 501,
        startIdentity: "darwin-proc:1770000000:999999",
        executableRealpath: "/usr/local/bin/runtime",
      }),
    })
    expect(proveExactProcessState(identity, reused)).toEqual({
      state: "dead",
      reason: "process-replaced",
      observed: { ...identity, startIdentity: "darwin-proc:1770000000:999999" },
    })
  })

  it("proves exact-owner death from absence or a later boot, never PID age", () => {
    const absent = source({ readProcess: () => null })
    expect(proveExactProcessState(identity, absent)).toEqual({ state: "dead", reason: "process-absent" })

    const laterBoot = source({
      readBootId: () => "boot-b",
      readProcess: vi.fn(() => { throw new Error("must not inspect a reused PID across boots") }),
    })
    expect(proveExactProcessState(identity, laterBoot)).toEqual({ state: "dead", reason: "boot-changed" })
    expect(laterBoot.readProcess).not.toHaveBeenCalled()
  })

  it("fails closed when current boot or process evidence is unavailable", () => {
    expect(proveExactProcessState(identity, source({ readBootId: () => { throw new Error("denied") } }))).toEqual({
      state: "unobservable",
      reason: "boot-evidence-unavailable",
    })
    expect(proveExactProcessState(identity, source({ readProcess: () => { throw new Error("denied") } }))).toEqual({
      state: "unobservable",
      reason: "process-evidence-unavailable",
    })
    expect(proveExactProcessState(identity, source({ readBootId: () => "" }))).toEqual({
      state: "unobservable",
      reason: "boot-evidence-unavailable",
    })
    expect(proveExactProcessState(identity, source({
      readProcess: () => ({ pid: 4243, uid: 501, startIdentity: identity.startIdentity, executableRealpath: "/runtime" }),
    }))).toEqual({
      state: "unobservable",
      reason: "process-evidence-unavailable",
    })
  })
})
