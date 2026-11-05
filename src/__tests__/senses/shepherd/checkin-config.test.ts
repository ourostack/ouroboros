import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { normalizeShepherdCheckInMinutes, readShepherdCheckInMinutes } from "../../../senses/shepherd/checkin-config"

describe("Shepherd fallback cadence", () => {
  it.each([
    { input: undefined, want: 60 },
    { input: 0, want: 0 },
    { input: 30, want: 30 },
    { input: 60, want: 60 },
    { input: 1440, want: 1440 },
  ])("normalizes the explicit cadence/default: $input", ({ input, want }) => {
    expect(normalizeShepherdCheckInMinutes(input)).toBe(want)
  })

  it.each([1, 29, 1441, 30.5, "60", null, false, NaN, Infinity, {}, []])("refuses invalid explicit cadence without a fallback: %j", value => {
    expect(() => normalizeShepherdCheckInMinutes(value)).toThrow("checkInMinutes")
  })

  it.each([
    { raw: {}, want: 60 },
    { raw: { senses: {} }, want: 60 },
    { raw: { senses: { shepherd: { enabled: true } } }, want: 60 },
    { raw: { senses: { shepherd: { enabled: true, checkInMinutes: 30 } } }, want: 30 },
    { raw: { senses: { shepherd: { enabled: true, notify: "off", checkInMinutes: 0 } } }, want: 0 },
  ])("reads actual config without provider initialization: $raw", ({ raw, want }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-config-"))
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify(raw))
    expect(readShepherdCheckInMinutes(root)).toBe(want)
  })

  it.each([null, [], "invalid", { senses: null }, { senses: [] }, { senses: "invalid" }, { senses: { shepherd: [] } }, { senses: { shepherd: null } }])("refuses malformed config structure: %j", raw => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-config-shape-"))
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify(raw))
    expect(() => readShepherdCheckInMinutes(root)).toThrow()
  })

  it("surfaces missing or corrupt config instead of silently disabling check-ins", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-config-unreadable-"))
    expect(() => readShepherdCheckInMinutes(root)).toThrow()
    fs.writeFileSync(path.join(root, "agent.json"), "{broken")
    expect(() => readShepherdCheckInMinutes(root)).toThrow()
  })
})
