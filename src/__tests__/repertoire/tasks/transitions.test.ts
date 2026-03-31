import { emitNervesEvent } from "../../../nerves/runtime"
import {
  TASK_VALID_STATUSES,
  TASK_STATUS_TRANSITIONS,
  TASK_REQUIRED_TEMPLATE_FIELDS,
  normalizeTaskStatus,
  validateTransition,
} from "../../../repertoire/tasks/transitions"
import type { TaskStatus } from "../../../repertoire/tasks/types"

describe("transitions — cancelled status", () => {
  it("includes cancelled in TASK_VALID_STATUSES", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing cancelled in valid statuses",
    })
    expect(TASK_VALID_STATUSES).toContain("cancelled")
  })

  it("cancelled is a terminal state with empty transitions", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing cancelled terminal state",
    })
    expect(TASK_STATUS_TRANSITIONS.cancelled).toEqual([])
  })

  it("done remains a terminal state", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing done remains terminal",
    })
    expect(TASK_STATUS_TRANSITIONS.done).toEqual([])
  })

  it("cancelled is reachable from all non-terminal states", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing cancelled reachable from non-terminal",
    })
    const nonTerminal: TaskStatus[] = [
      "drafting",
      "processing",
      "validating",
      "collaborating",
      "paused",
      "blocked",
    ]
    for (const status of nonTerminal) {
      expect(TASK_STATUS_TRANSITIONS[status]).toContain("cancelled")
    }
  })

  it("done does not transition to cancelled", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing done cannot reach cancelled",
    })
    expect(TASK_STATUS_TRANSITIONS.done).not.toContain("cancelled")
  })

  it("cancelled does not transition to done", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing cancelled cannot reach done",
    })
    expect(TASK_STATUS_TRANSITIONS.cancelled).not.toContain("done")
  })

  it("normalizeTaskStatus recognizes cancelled", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing normalizeTaskStatus cancelled",
    })
    expect(normalizeTaskStatus("cancelled")).toBe("cancelled")
    expect(normalizeTaskStatus("CANCELLED")).toBe("cancelled")
  })

  it("validateTransition allows processing -> cancelled", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing processing to cancelled transition",
    })
    const result = validateTransition("processing", "cancelled")
    expect(result.ok).toBe(true)
    expect(result.from).toBe("processing")
    expect(result.to).toBe("cancelled")
  })

  it("validateTransition rejects done -> cancelled", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing done to cancelled rejected",
    })
    const result = validateTransition("done", "cancelled")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("invalid transition")
  })

  it("validateTransition rejects cancelled -> done", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing cancelled to done rejected",
    })
    const result = validateTransition("cancelled", "done")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("invalid transition")
  })

  it("validateTransition allows cancelled -> cancelled (no-op)", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing cancelled self-transition",
    })
    const result = validateTransition("cancelled", "cancelled")
    expect(result.ok).toBe(true)
  })
})

describe("transitions — required template fields", () => {
  it("includes kind in one-shot required fields", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing kind in one-shot fields",
    })
    expect(TASK_REQUIRED_TEMPLATE_FIELDS["one-shot"]).toContain("kind")
  })

  it("includes kind in ongoing required fields", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing kind in ongoing fields",
    })
    expect(TASK_REQUIRED_TEMPLATE_FIELDS["ongoing"]).toContain("kind")
  })

  it("includes kind in habit required fields", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing kind in habit fields",
    })
    expect(TASK_REQUIRED_TEMPLATE_FIELDS["habit"]).toContain("kind")
  })

  it("does not include child_tasks in one-shot required fields", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing child_tasks removed from one-shot",
    })
    expect(TASK_REQUIRED_TEMPLATE_FIELDS["one-shot"]).not.toContain("child_tasks")
  })

  it("does not include child_tasks in ongoing required fields", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing child_tasks removed from ongoing",
    })
    expect(TASK_REQUIRED_TEMPLATE_FIELDS["ongoing"]).not.toContain("child_tasks")
  })

  it("does not include child_tasks in habit required fields", () => {
    emitNervesEvent({
      event: "repertoire.task_scan_start",
      component: "repertoire",
      message: "testing child_tasks removed from habit",
    })
    expect(TASK_REQUIRED_TEMPLATE_FIELDS["habit"]).not.toContain("child_tasks")
  })
})
