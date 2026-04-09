import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import type { DoctorDeps, DoctorResult } from "../../../heart/daemon/doctor-types"
import { runDoctorChecks } from "../../../heart/daemon/doctor"

function createMockDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ mode: 0o600, size: 100 }),
    checkSocketAlive: vi.fn().mockResolvedValue(false),
    socketPath: "/tmp/test.sock",
    bundlesRoot: "/tmp/bundles",
    secretsRoot: "/tmp/secrets",
    homedir: "/tmp/home",
    ...overrides,
  }
}

describe("runDoctorChecks", () => {
  it("returns a DoctorResult with categories and summary", async () => {
    const deps = createMockDeps()
    const result: DoctorResult = await runDoctorChecks(deps)

    expect(result).toHaveProperty("categories")
    expect(result).toHaveProperty("summary")
    expect(Array.isArray(result.categories)).toBe(true)
    expect(result.categories.length).toBeGreaterThan(0)
    expect(typeof result.summary.passed).toBe("number")
    expect(typeof result.summary.warnings).toBe("number")
    expect(typeof result.summary.failed).toBe("number")
  })

  it("returns all 6 expected category names", async () => {
    const deps = createMockDeps()
    const result = await runDoctorChecks(deps)
    const names = result.categories.map((c) => c.name)

    expect(names).toContain("Daemon")
    expect(names).toContain("Agents")
    expect(names).toContain("Senses")
    expect(names).toContain("Habits")
    expect(names).toContain("Security")
    expect(names).toContain("Disk")
  })

  it("summary counts match the total checks across categories", async () => {
    const deps = createMockDeps()
    const result = await runDoctorChecks(deps)

    const totalChecks = result.categories.reduce(
      (sum, cat) => sum + cat.checks.length,
      0,
    )
    const summaryTotal =
      result.summary.passed + result.summary.warnings + result.summary.failed

    expect(summaryTotal).toBe(totalChecks)
  })

  it("individual check failures do not crash the overall run", async () => {
    const deps = createMockDeps({
      existsSync: vi.fn().mockImplementation(() => {
        throw new Error("simulated fs explosion")
      }),
    })

    // Should not throw
    const result = await runDoctorChecks(deps)
    expect(result.categories.length).toBeGreaterThan(0)
    // At least some checks should be fail due to the error
    expect(result.summary.failed).toBeGreaterThan(0)
  })
})
