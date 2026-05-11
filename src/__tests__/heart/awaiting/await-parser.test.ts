import { describe, expect, it } from "vitest"

import {
  parseAwaitFile,
  renderAwaitFile,
  type AwaitFile,
  type AwaitStatus,
  type AwaitMode,
} from "../../../heart/awaiting/await-parser"

describe("parseAwaitFile", () => {
  it("parses a valid await file with all fields", () => {
    const content = [
      "---",
      "condition: HEY export download visible in mail",
      "cadence: 5m",
      "alert: bluebubbles",
      "mode: full",
      "max_age: 24h",
      "status: pending",
      "created_at: 2026-05-10T20:00:00.000Z",
      "filed_from: cli",
      "filed_for_friend_id: ari",
      "---",
      "",
      "what would count as ready",
    ].join("\n")

    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/hey_export.md")

    expect(result).toEqual({
      name: "hey_export",
      condition: "HEY export download visible in mail",
      cadence: "5m",
      alert: "bluebubbles",
      mode: "full",
      max_age: "24h",
      status: "pending",
      created_at: "2026-05-10T20:00:00.000Z",
      filed_from: "cli",
      filed_for_friend_id: "ari",
      body: "what would count as ready",
      resolved_at: null,
      resolution_observation: null,
      expired_at: null,
      last_observation_at_expiry: null,
      canceled_at: null,
      cancel_reason: null,
    })
  })

  it("returns null condition when condition is missing", () => {
    const content = [
      "---",
      "cadence: 5m",
      "---",
      "",
      "body",
    ].join("\n")

    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/no-condition.md")
    expect(result.condition).toBeNull()
  })

  it("defaults status to pending when missing", () => {
    const content = [
      "---",
      "condition: something",
      "cadence: 5m",
      "---",
      "",
      "body",
    ].join("\n")

    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.status).toBe("pending")
  })

  it("defaults mode to full when missing", () => {
    const content = [
      "---",
      "condition: something",
      "cadence: 5m",
      "---",
      "",
    ].join("\n")

    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.mode).toBe("full")
  })

  it("accepts mode: quick", () => {
    const content = [
      "---",
      "condition: something",
      "mode: quick",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.mode).toBe("quick")
  })

  it("falls back to full for unknown mode", () => {
    const content = [
      "---",
      "condition: something",
      "mode: weird",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.mode).toBe("full")
  })

  it("falls back to pending for unknown status", () => {
    const content = [
      "---",
      "condition: something",
      "status: weird",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.status).toBe("pending")
  })

  it.each<AwaitStatus>(["pending", "resolved", "expired", "canceled"])(
    "preserves valid status %s",
    (status) => {
      const content = [
        "---",
        "condition: something",
        `status: ${status}`,
        "---",
        "",
      ].join("\n")
      const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
      expect(result.status).toBe(status)
    },
  )

  it("uses filename stem as name", () => {
    const content = [
      "---",
      "condition: something",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/hey_export_ready.md")
    expect(result.name).toBe("hey_export_ready")
  })

  it("handles non-frontmatter content as body with all-null fields", () => {
    const result = parseAwaitFile("not frontmatter", "/bundles/agent.ouro/awaiting/raw.md")
    expect(result.name).toBe("raw")
    expect(result.condition).toBeNull()
    expect(result.status).toBe("pending")
    expect(result.mode).toBe("full")
    expect(result.body).toBe("not frontmatter")
  })

  it("handles empty content", () => {
    const result = parseAwaitFile("", "/bundles/agent.ouro/awaiting/x.md")
    expect(result.condition).toBeNull()
    expect(result.body).toBe("")
  })

  it("handles unterminated frontmatter as no frontmatter", () => {
    const content = "---\ncondition: x\ncadence: 5m"
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.condition).toBeNull()
    expect(result.body).toBe(content)
  })

  it("parses resolution-only fields when present", () => {
    const content = [
      "---",
      "condition: thing",
      "status: resolved",
      "resolved_at: 2026-05-10T21:00:00.000Z",
      "resolution_observation: download appeared in mail",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/.done/x.md")
    expect(result.resolved_at).toBe("2026-05-10T21:00:00.000Z")
    expect(result.resolution_observation).toBe("download appeared in mail")
  })

  it("parses expiry-only fields when present", () => {
    const content = [
      "---",
      "condition: thing",
      "status: expired",
      "expired_at: 2026-05-11T20:00:00.000Z",
      "last_observation_at_expiry: still no sign",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/.done/x.md")
    expect(result.expired_at).toBe("2026-05-11T20:00:00.000Z")
    expect(result.last_observation_at_expiry).toBe("still no sign")
  })

  it("parses canceled-only fields when present", () => {
    const content = [
      "---",
      "condition: thing",
      "status: canceled",
      "canceled_at: 2026-05-10T22:00:00.000Z",
      "cancel_reason: nevermind",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/.done/x.md")
    expect(result.canceled_at).toBe("2026-05-10T22:00:00.000Z")
    expect(result.cancel_reason).toBe("nevermind")
  })

  it("returns null for resolution/expiry/cancel fields when missing", () => {
    const content = [
      "---",
      "condition: thing",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.resolved_at).toBeNull()
    expect(result.resolution_observation).toBeNull()
    expect(result.expired_at).toBeNull()
    expect(result.last_observation_at_expiry).toBeNull()
    expect(result.canceled_at).toBeNull()
    expect(result.cancel_reason).toBeNull()
  })

  it("type exports work", () => {
    const status: AwaitStatus = "pending"
    const mode: AwaitMode = "full"
    expect(status).toBe("pending")
    expect(mode).toBe("full")
  })

  it("has expected AwaitFile shape", () => {
    const content = [
      "---",
      "condition: x",
      "---",
      "",
    ].join("\n")
    const result: AwaitFile = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    const keys = Object.keys(result).sort()
    expect(keys).toEqual([
      "alert",
      "body",
      "cadence",
      "cancel_reason",
      "canceled_at",
      "condition",
      "created_at",
      "expired_at",
      "filed_for_friend_id",
      "filed_from",
      "last_observation_at_expiry",
      "max_age",
      "max_age",
      "mode",
      "name",
      "resolution_observation",
      "resolved_at",
      "status",
    ].filter((v, i, a) => a.indexOf(v) === i))
  })

  it("handles empty alert/cadence/etc as null", () => {
    const content = [
      "---",
      "condition: x",
      "alert:",
      "cadence:",
      "---",
      "",
    ].join("\n")
    const result = parseAwaitFile(content, "/bundles/agent.ouro/awaiting/x.md")
    expect(result.alert).toBeNull()
    expect(result.cadence).toBeNull()
  })
})

describe("renderAwaitFile", () => {
  it("renders frontmatter + body", () => {
    const result = renderAwaitFile(
      {
        condition: "HEY export download visible",
        cadence: "5m",
        alert: "bluebubbles",
        mode: "full",
        status: "pending",
      },
      "body text",
    )

    expect(result).toContain("---")
    expect(result).toContain("condition: HEY export download visible")
    expect(result).toContain("cadence: 5m")
    expect(result).toContain("alert: bluebubbles")
    expect(result).toContain("mode: full")
    expect(result).toContain("status: pending")
    expect(result).toContain("body text")
  })

  it("renders null values as null", () => {
    const result = renderAwaitFile({ condition: "x", cadence: null }, "")
    expect(result).toContain("cadence: null")
  })

  it("renders array values inline", () => {
    const result = renderAwaitFile({ tags: ["a", "b"] }, "")
    expect(result).toContain("tags: [a, b]")
  })

  it("roundtrips through parse + render", () => {
    const original = [
      "---",
      "condition: rt cond",
      "cadence: 5m",
      "alert: bluebubbles",
      "mode: full",
      "status: pending",
      "created_at: 2026-05-10T20:00:00.000Z",
      "filed_from: cli",
      "filed_for_friend_id: ari",
      "---",
      "",
      "rt body.",
    ].join("\n")

    const parsed = parseAwaitFile(original, "/bundles/agent.ouro/awaiting/rt.md")
    const rendered = renderAwaitFile(
      {
        condition: parsed.condition,
        cadence: parsed.cadence,
        alert: parsed.alert,
        mode: parsed.mode,
        status: parsed.status,
        created_at: parsed.created_at,
        filed_from: parsed.filed_from,
        filed_for_friend_id: parsed.filed_for_friend_id,
      },
      parsed.body,
    )
    const reparsed = parseAwaitFile(rendered, "/bundles/agent.ouro/awaiting/rt.md")
    expect(reparsed.condition).toBe(parsed.condition)
    expect(reparsed.cadence).toBe(parsed.cadence)
    expect(reparsed.alert).toBe(parsed.alert)
    expect(reparsed.mode).toBe(parsed.mode)
    expect(reparsed.status).toBe(parsed.status)
    expect(reparsed.created_at).toBe(parsed.created_at)
    expect(reparsed.filed_from).toBe(parsed.filed_from)
    expect(reparsed.filed_for_friend_id).toBe(parsed.filed_for_friend_id)
    expect(reparsed.body).toBe(parsed.body)
  })
})
