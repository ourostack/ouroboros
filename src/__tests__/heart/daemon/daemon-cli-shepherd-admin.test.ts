import { describe, expect, it, vi } from "vitest"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

const id = "a".repeat(64)
const admin = ["--agent", "ouro", "--expected-revision", "0", "--request-id", "request-1"]

describe("local-owner Shepherd administration CLI", () => {
  it("parses bounded readonly status and inspection without authority arguments", () => {
    expect(parseOuroCommand(["shepherd", "status", "--agent", "ouro", "--json"]))
      .toEqual({ kind: "shepherd.status", agent: "ouro", json: true })
    expect(parseOuroCommand(["shepherd", "inspect", "--agent", "ouro", "--id", id]))
      .toEqual({ kind: "shepherd.inspect", agent: "ouro", id, limit: 50 })
    expect(parseOuroCommand(["shepherd", "inspect", "--agent", "ouro", "--limit", "200", "--cursor", "opaque"]))
      .toEqual({ kind: "shepherd.inspect", agent: "ouro", limit: 200, cursor: "opaque" })
  })

  it.each(["pause", "resume"])("requires explicit revision and request identity for %s", operation => {
    expect(parseOuroCommand(["shepherd", operation, ...admin, "--host", "cmux", "--session", "stable-terminal"]))
      .toEqual({ kind: `shepherd.${operation}`, agent: "ouro", expectedRevision: 0, requestId: "request-1", host: "cmux", session: "stable-terminal" })
  })

  it("parses scoped mandate grants, revocation and evidence-derived custody operations", () => {
    expect(parseOuroCommand(["shepherd", "mandate", "grant", ...admin, "--project", "/work/project", "--task", "finish-tests", "--expires-at", "2026-10-18T23:00:00.000Z"]))
      .toEqual({ kind: "shepherd.mandate.grant", agent: "ouro", expectedRevision: 0, requestId: "request-1", project: "/work/project", task: "finish-tests", expiresAt: "2026-10-18T23:00:00.000Z" })
    expect(parseOuroCommand(["shepherd", "mandate", "revoke", ...admin, "--id", id]))
      .toEqual({ kind: "shepherd.mandate.revoke", agent: "ouro", expectedRevision: 0, requestId: "request-1", id })
    expect(parseOuroCommand(["shepherd", "reconcile", ...admin, "--id", id, "--resolution", "retired"]))
      .toEqual({ kind: "shepherd.reconcile", agent: "ouro", expectedRevision: 0, requestId: "request-1", id, resolution: "retired" })
    expect(parseOuroCommand(["shepherd", "maintenance", ...admin, "--destination", "/work/archive"]))
      .toEqual({ kind: "shepherd.maintenance", agent: "ouro", expectedRevision: 0, requestId: "request-1", destination: "/work/archive" })
  })

  it.each([
    ["status", "--agent", "../ouro"],
    ["inspect", "--agent", "ouro", "--limit", "201"],
    ["inspect", "--agent", "ouro", "--limit", "1.5"],
    ["inspect", "--agent", "ouro", "--id", id, "--cursor", "cursor"],
    ["status", "--agent", "ouro", "--friend-id", "owner"],
    ["pause", "--agent", "ouro", "--host", "cmux", "--session", "x"],
    ["pause", ...admin, "--host", "unknown", "--session", "x"],
    ["pause", ...admin, "--host", "cmux", "--session", "x", "--expected-revision", "1"],
    ["reconcile", ...admin, "--id", id, "--resolution", "delivered", "--evidence-file", "/tmp/assertion"],
    ["maintenance", ...admin, "--destination", "/work/archive", "--stopped"],
    ["mandate", "grant", ...admin, "--project", "relative", "--task", "x", "--expires-at", "tomorrow"],
  ])("rejects unsupported or ambiguous input %j", (...args) => {
    expect(() => parseOuroCommand(["shepherd", ...args])).toThrow(/Usage:/)
  })

  it("dispatches administration through its injected local service, never daemon input or chat", async () => {
    const runShepherdOperation = vi.fn(async () => ({ state: "ready", revision: 3 }))
    const sendCommand = vi.fn()
    const deps = { runShepherdOperation, sendCommand } as unknown as OuroCliDeps
    expect(await runOuroCli(["shepherd", "status", "--agent", "ouro", "--json"], deps))
      .toBe(JSON.stringify({ state: "ready", revision: 3 }, null, 2))
    expect(runShepherdOperation).toHaveBeenCalledWith({ kind: "shepherd.status", agent: "ouro", json: true })
    expect(sendCommand).not.toHaveBeenCalled()
  })
})
