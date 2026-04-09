import { emitNervesEvent } from "../../nerves/runtime"
import {
  TASK_STATUS_TRANSITIONS,
  TASK_VALID_STATUSES,
  isTaskStatus,
  normalizeTaskStatus,
  validateTransition,
} from "../../arc/task-lifecycle"

describe("task lifecycle", () => {
  it("exports the shared valid status list", () => {
    emitNervesEvent({
      component: "mind",
      event: "mind.step_start",
      message: "testing shared task lifecycle statuses",
      meta: {},
    })

    expect(TASK_VALID_STATUSES).toEqual([
      "drafting",
      "processing",
      "validating",
      "collaborating",
      "paused",
      "blocked",
      "done",
      "cancelled",
    ])
  })

  it("validates and normalizes task statuses", () => {
    emitNervesEvent({
      component: "mind",
      event: "mind.step_start",
      message: "testing shared task lifecycle normalization",
      meta: {},
    })

    expect(isTaskStatus("processing")).toBe(true)
    expect(isTaskStatus("mystery")).toBe(false)
    expect(normalizeTaskStatus("CANCELLED")).toBe("cancelled")
    expect(normalizeTaskStatus("mystery")).toBeNull()
  })

  it("preserves the expected transition matrix", () => {
    emitNervesEvent({
      component: "mind",
      event: "mind.step_start",
      message: "testing shared task lifecycle transitions",
      meta: {},
    })

    expect(TASK_STATUS_TRANSITIONS.processing).toContain("validating")
    expect(TASK_STATUS_TRANSITIONS.processing).toContain("cancelled")
    expect(TASK_STATUS_TRANSITIONS.done).toEqual([])

    expect(validateTransition("processing", "cancelled")).toEqual({
      ok: true,
      from: "processing",
      to: "cancelled",
    })
    expect(validateTransition("done", "cancelled")).toMatchObject({
      ok: false,
      from: "done",
      to: "cancelled",
    })
    expect(validateTransition("cancelled", "cancelled")).toEqual({
      ok: true,
      from: "cancelled",
      to: "cancelled",
    })
  })
})
