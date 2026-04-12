import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Tests for per-test event tracking in global-capture.ts.
 *
 * The global-capture setup file should:
 * 1. Track which test is currently running via beforeEach/afterEach hooks
 * 2. Associate each emitted event with the current test name
 * 3. Emit a harness heartbeat so every executed test is observable
 * 4. Expose per-test data via the global capture state
 *
 * We verify this by checking the per-test state stored on globalThis
 * after emitting events in different tests.
 */

const PER_TEST_KEY = Symbol.for("ouroboros.nerves.per-test-events")

interface PerTestState {
  currentTest: string | null
  events: Map<string, Array<{ component: string; event: string }>>
}

function getPerTestState(): PerTestState | undefined {
  const scope = globalThis as Record<PropertyKey, unknown>
  return scope[PER_TEST_KEY] as PerTestState | undefined
}

describe("per-test event capture", () => {
  it("tracks the current test name during execution", () => {
    const state = getPerTestState()
    expect(state).toBeDefined()
    expect(state!.currentTest).toContain("tracks the current test name during execution")
  })

  it("emits a harness heartbeat for the current test", () => {
    const state = getPerTestState()
    expect(state).toBeDefined()
    const testName = state!.currentTest!
    const events = state!.events.get(testName) ?? []
    expect(events.some((e) => e.component === "tests" && e.event === "test_case_observed")).toBe(true)
  })

  it("associates emitted events with the current test", () => {
    emitNervesEvent({
      component: "test-capture",
      event: "per_test_verify",
      message: "verifying per-test association",
    })

    const state = getPerTestState()
    expect(state).toBeDefined()
    const testName = state!.currentTest!
    expect(testName).toContain("associates emitted events with the current test")
    const events = state!.events.get(testName)
    expect(events).toBeDefined()
    expect(events!.some((e) => e.event === "per_test_verify")).toBe(true)
  })

  it("isolates events between tests", () => {
    // This test should NOT see events from the previous test
    const state = getPerTestState()
    expect(state).toBeDefined()
    const testName = state!.currentTest!
    expect(testName).toContain("isolates events between tests")
    const events = state!.events.get(testName) ?? []
    // No "per_test_verify" event should be in THIS test's events
    expect(events.some((e) => e.event === "per_test_verify")).toBe(false)
  })

  it("records multiple events for one test", () => {
    emitNervesEvent({
      component: "test-capture",
      event: "multi_a",
      message: "first",
    })
    emitNervesEvent({
      component: "test-capture",
      event: "multi_b",
      message: "second",
    })

    const state = getPerTestState()
    const testName = state!.currentTest!
    const events = state!.events.get(testName) ?? []
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.some((e) => e.event === "multi_a")).toBe(true)
    expect(events.some((e) => e.event === "multi_b")).toBe(true)
  })
})
