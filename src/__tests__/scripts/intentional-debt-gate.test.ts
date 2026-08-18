import * as fs from "node:fs"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

const {
  validateIntentionalDebt,
} = require(path.resolve(__dirname, "../../../scripts/intentional-debt-gate.cjs"))

function validDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    items: [{
      id: "mailroom-encrypted-raw-orphans",
      status: "open",
      owner: "Mailroom",
      due: "2026-09-30",
      removalCriteria: "Replace upload ordering with a transaction and sweep verified orphan raw objects.",
      ...overrides,
    }],
  }
}

describe("intentional debt gate", () => {
  it("accepts a complete open item before its due date", () => {
    expect(validateIntentionalDebt(validDocument(), new Date("2026-09-29T23:59:59.999Z"))).toEqual({
      ok: true,
      errors: [],
      message: "intentional debt gate: pass (1 open item)",
    })
  })

  it("fails an open item on and after its due date", () => {
    const onDueDate = validateIntentionalDebt(validDocument(), new Date("2026-09-30T00:00:00.000Z"))
    expect(onDueDate.ok).toBe(false)
    expect(onDueDate.errors.join("\n")).toContain("mailroom-encrypted-raw-orphans")
    expect(onDueDate.errors.join("\n")).toContain("due 2026-09-30")

    expect(validateIntentionalDebt(validDocument(), new Date("2026-10-01T00:00:00.000Z")).ok).toBe(false)
  })

  it("rejects malformed ownership, dates, status, and removal criteria", () => {
    for (const overrides of [
      { id: "" },
      { owner: "" },
      { due: "September 30" },
      { status: "ignored" },
      { removalCriteria: "" },
    ]) {
      const result = validateIntentionalDebt(validDocument(overrides), new Date("2026-08-18T00:00:00.000Z"))
      expect(result.ok).toBe(false)
    }
  })

  it("does not fail a resolved item after its former due date", () => {
    expect(validateIntentionalDebt(
      validDocument({ status: "resolved" }),
      new Date("2026-10-01T00:00:00.000Z"),
    )).toEqual({
      ok: true,
      errors: [],
      message: "intentional debt gate: pass (0 open items)",
    })
  })

  it("keeps the repository debt file valid at the task's release date", () => {
    const document = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "docs/intentional-debt.json"), "utf8"))
    expect(validateIntentionalDebt(document, new Date("2026-08-18T00:00:00.000Z")).ok).toBe(true)
  })
})
