import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import { parseCodexJsonlEvent, type CodexJsonlEvent } from "../../../repertoire/coding/codex-jsonl"

describe("codex JSONL event parsing", () => {
  it("parses thread.started event", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing thread.started parsing",
      meta: {},
    })

    const event = parseCodexJsonlEvent('{"type":"thread.started","thread_id":"t1"}')
    expect(event).not.toBeNull()
    expect(event!.type).toBe("thread.started")
    expect(event!.threadId).toBe("t1")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "thread.started parsing test complete",
      meta: {},
    })
  })

  it("parses turn.started event", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing turn.started parsing",
      meta: {},
    })

    const event = parseCodexJsonlEvent('{"type":"turn.started","turn_id":"turn1"}')
    expect(event).not.toBeNull()
    expect(event!.type).toBe("turn.started")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "turn.started parsing test complete",
      meta: {},
    })
  })

  it("parses turn.completed event", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing turn.completed parsing",
      meta: {},
    })

    const event = parseCodexJsonlEvent('{"type":"turn.completed","turn_id":"turn1"}')
    expect(event).not.toBeNull()
    expect(event!.type).toBe("turn.completed")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "turn.completed parsing test complete",
      meta: {},
    })
  })

  it("parses item.completed event", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing item.completed parsing",
      meta: {},
    })

    const event = parseCodexJsonlEvent('{"type":"item.completed","item":{"type":"message","content":"done"}}')
    expect(event).not.toBeNull()
    expect(event!.type).toBe("item.completed")

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "item.completed parsing test complete",
      meta: {},
    })
  })

  it("returns null for invalid JSON", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing invalid JSON handling",
      meta: {},
    })

    const event = parseCodexJsonlEvent("not json")
    expect(event).toBeNull()

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "invalid JSON handling test complete",
      meta: {},
    })
  })

  it("returns null for unknown event types", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing unknown event type",
      meta: {},
    })

    const event = parseCodexJsonlEvent('{"type":"unknown.event"}')
    expect(event).toBeNull()

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "unknown event type test complete",
      meta: {},
    })
  })

  it("returns null for empty string", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing empty string",
      meta: {},
    })

    const event = parseCodexJsonlEvent("")
    expect(event).toBeNull()

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "empty string test complete",
      meta: {},
    })
  })

  it("maps event types to session status transitions", () => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_start",
      message: "testing status mapping",
      meta: {},
    })

    const threadStarted = parseCodexJsonlEvent('{"type":"thread.started","thread_id":"t1"}')
    expect(threadStarted!.statusHint).toBe("running")

    const turnStarted = parseCodexJsonlEvent('{"type":"turn.started","turn_id":"turn1"}')
    expect(turnStarted!.statusHint).toBe("running")

    const turnCompleted = parseCodexJsonlEvent('{"type":"turn.completed","turn_id":"turn1"}')
    expect(turnCompleted!.statusHint).toBeNull()

    const itemCompleted = parseCodexJsonlEvent('{"type":"item.completed","item":{"type":"message","content":"done"}}')
    expect(itemCompleted!.statusHint).toBeNull()

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_test_end",
      message: "status mapping test complete",
      meta: {},
    })
  })
})
