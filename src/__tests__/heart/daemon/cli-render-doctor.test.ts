import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import type { DoctorResult } from "../../../heart/daemon/doctor-types"
import { formatDoctorOutput } from "../../../heart/daemon/cli-render-doctor"

// Strip ANSI codes for easier assertion
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

function makeResult(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    categories: [],
    summary: { passed: 0, warnings: 0, failed: 0 },
    ...overrides,
  }
}

describe("formatDoctorOutput", () => {
  it("renders empty categories with just summary", () => {
    const result = makeResult()
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("0 passed")
    expect(plain).toContain("0 warnings")
    expect(plain).toContain("0 failed")
  })

  it("renders pass checks with green checkmark", () => {
    const result = makeResult({
      categories: [{
        name: "TestCat",
        checks: [{ label: "check one", status: "pass", detail: "looks good" }],
      }],
      summary: { passed: 1, warnings: 0, failed: 0 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("TestCat")
    expect(plain).toContain("check one")
    expect(plain).toContain("looks good")
    // Should contain the checkmark character
    expect(output).toContain("\u2714")
  })

  it("renders warn checks with yellow warning", () => {
    const result = makeResult({
      categories: [{
        name: "WarnCat",
        checks: [{ label: "warn check", status: "warn", detail: "maybe bad" }],
      }],
      summary: { passed: 0, warnings: 1, failed: 0 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("warn check")
    expect(plain).toContain("maybe bad")
    // Should contain warning character
    expect(output).toContain("\u26A0")
  })

  it("renders fail checks with red X", () => {
    const result = makeResult({
      categories: [{
        name: "FailCat",
        checks: [{ label: "fail check", status: "fail", detail: "broken" }],
      }],
      summary: { passed: 0, warnings: 0, failed: 1 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("fail check")
    expect(plain).toContain("broken")
    // Should contain X character
    expect(output).toContain("\u2718")
  })

  it("groups checks by category", () => {
    const result = makeResult({
      categories: [
        {
          name: "Alpha",
          checks: [{ label: "a1", status: "pass" }],
        },
        {
          name: "Beta",
          checks: [{ label: "b1", status: "fail" }],
        },
      ],
      summary: { passed: 1, warnings: 0, failed: 1 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    const alphaIdx = plain.indexOf("Alpha")
    const betaIdx = plain.indexOf("Beta")
    expect(alphaIdx).toBeLessThan(betaIdx)
    expect(plain.indexOf("a1")).toBeGreaterThan(alphaIdx)
    expect(plain.indexOf("b1")).toBeGreaterThan(betaIdx)
  })

  it("renders summary line with correct counts", () => {
    const result = makeResult({
      categories: [{
        name: "Mixed",
        checks: [
          { label: "ok", status: "pass" },
          { label: "meh", status: "warn" },
          { label: "bad", status: "fail" },
        ],
      }],
      summary: { passed: 1, warnings: 1, failed: 1 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("1 passed")
    expect(plain).toContain("1 warning")
    expect(plain).toContain("1 failed")
  })

  it("handles all-pass result", () => {
    const result = makeResult({
      categories: [{
        name: "All Good",
        checks: [
          { label: "a", status: "pass" },
          { label: "b", status: "pass" },
        ],
      }],
      summary: { passed: 2, warnings: 0, failed: 0 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("2 passed")
    expect(plain).toContain("0 warnings")
    expect(plain).toContain("0 failed")
  })

  it("handles all-fail result", () => {
    const result = makeResult({
      categories: [{
        name: "All Bad",
        checks: [
          { label: "x", status: "fail" },
          { label: "y", status: "fail" },
        ],
      }],
      summary: { passed: 0, warnings: 0, failed: 2 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("0 passed")
    expect(plain).toContain("2 failed")
  })

  it("renders check without detail", () => {
    const result = makeResult({
      categories: [{
        name: "NoDetail",
        checks: [{ label: "simple", status: "pass" }],
      }],
      summary: { passed: 1, warnings: 0, failed: 0 },
    })
    const output = formatDoctorOutput(result)
    const plain = stripAnsi(output)
    expect(plain).toContain("simple")
  })
})
