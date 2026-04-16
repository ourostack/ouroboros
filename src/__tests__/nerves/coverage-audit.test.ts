import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { describe, expect, it } from "vitest"
import { collectObservedEventKeys, readEvents, auditNervesCoverage } from "../../nerves/coverage/audit"

function makeEventsPath(events: Array<Record<string, unknown>>): string {
  const runDir = mkdtempSync(join(tmpdir(), "ouro-nerves-audit-"))
  const eventsPath = join(runDir, "vitest-events.ndjson")
  writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
  return eventsPath
}

function makeEventsPathFromContent(content: string): string {
  const runDir = mkdtempSync(join(tmpdir(), "ouro-nerves-audit-"))
  const eventsPath = join(runDir, "vitest-events.ndjson")
  writeFileSync(eventsPath, content, "utf8")
  return eventsPath
}

describe("observability/coverage audit - schema_redaction", () => {
  it("fails schema/redaction checks when captured events break envelope policy", () => {
    const eventsPath = makeEventsPath([
      {
        ts: "2026-03-02T18:00:00.000Z",
        level: "info",
        event: "channel.message_sent",
        trace_id: "",
        component: "channels",
        message: "token=super-secret-value",
        meta: { prompt: "raw prompt dump" },
      },
    ])
    const report = auditNervesCoverage({ eventsPath })

    expect(report.overall_status).toBe("fail")
    expect(report.nerves_coverage.schema_redaction.status).toBe("fail")
    expect(report.required_actions).toContainEqual(expect.objectContaining({
      type: "logging",
      target: "schema-redaction",
    }))
  })

  it("flags invalid meta fields during schema checks", () => {
    const eventsPath = makeEventsPath([
      {
        ts: "2026-03-02T18:00:00.000Z",
        level: "info",
        event: "engine.turn_start",
        trace_id: "trace-1",
        component: "engine",
        message: "turn start",
        meta: [],
      },
    ])
    const report = auditNervesCoverage({ eventsPath })

    expect(report.nerves_coverage.schema_redaction.status).toBe("fail")
  })

  it("treats malformed ndjson lines as schema violations", () => {
    const eventsPath = makeEventsPathFromContent("{not-json\n")
    const report = auditNervesCoverage({ eventsPath })

    expect(report.nerves_coverage.schema_redaction.status).toBe("fail")
  })

  it("passes schema check with valid events", () => {
    const eventsPath = makeEventsPath([
      {
        ts: "2026-03-02T18:00:00.000Z",
        level: "info",
        event: "engine.turn_start",
        trace_id: "trace-1",
        component: "engine",
        message: "turn start",
        meta: { idx: 0 },
      },
    ])
    const report = auditNervesCoverage({ eventsPath })

    expect(report.nerves_coverage.schema_redaction.status).toBe("pass")
  })

  it("allows file paths and branch names that contain sensitive-looking words", () => {
    const eventsPath = makeEventsPath([
      {
        ts: "2026-03-02T18:00:00.000Z",
        level: "info",
        event: "daemon.runtime_metadata_read",
        trace_id: "trace-1",
        component: "daemon",
        message: "runtime metadata read",
        meta: {
          repoRoot: "/tmp/ouroboros-bw-secret-redaction",
          branchPath: "/tmp/api-key-cleanup/password-reset/token-refresh/authorization-flow",
        },
      },
    ])
    const report = auditNervesCoverage({ eventsPath })

    expect(report.nerves_coverage.schema_redaction.status).toBe("pass")
  })

  it("still rejects credential-shaped text in messages and metadata", () => {
    const eventsPath = makeEventsPath([
      {
        ts: "2026-03-02T18:00:00.000Z",
        level: "info",
        event: "engine.turn_start",
        trace_id: "trace-1",
        component: "engine",
        message: "password=swordfish",
        meta: { item: "secret: swordfish" },
      },
    ])
    const report = auditNervesCoverage({ eventsPath })

    expect(report.nerves_coverage.schema_redaction.status).toBe("fail")
  })

  it("passes when events file is missing (no events to check)", () => {
    const runDir = mkdtempSync(join(tmpdir(), "ouro-nerves-audit-"))
    const report = auditNervesCoverage({ eventsPath: join(runDir, "missing.ndjson") })

    expect(report.nerves_coverage.schema_redaction.status).toBe("pass")
  })

  it("handles empty events files without parse failures", () => {
    const eventsPath = makeEventsPathFromContent("\n \n")
    const report = auditNervesCoverage({ eventsPath })

    expect(report.nerves_coverage.schema_redaction.status).toBe("pass")
  })
})

describe("collectObservedEventKeys", () => {
  it("collects unique component:event keys from parsed events", () => {
    const events = readEvents((() => {
      const runDir = mkdtempSync(join(tmpdir(), "ouro-nerves-keys-"))
      const p = join(runDir, "events.ndjson")
      writeFileSync(p, [
        JSON.stringify({ component: "engine", event: "turn_start" }),
        JSON.stringify({ component: "engine", event: "turn_end" }),
        JSON.stringify({ component: "engine", event: "turn_start" }),
        JSON.stringify({ missing: "fields" }),
      ].join("\n") + "\n", "utf8")
      return p
    })())
    const keys = collectObservedEventKeys(events)
    expect(keys).toEqual(["engine:turn_end", "engine:turn_start"])
  })

  it("returns empty array for no events", () => {
    expect(collectObservedEventKeys([])).toEqual([])
  })
})
