import { describe, it, expect } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"
import { PROMPT_POOL, selectPrompts } from "../../mailpals/prompts"

describe("prompts", () => {
  it("has 102 prompts in the pool", () => {
    emitNervesEvent({ component: "mailpals", event: "mailpals.test_prompts", message: "checking pool size" })
    expect(PROMPT_POOL).toHaveLength(102)
  })

  it("selects the requested number of prompts", () => {
    const selected = selectPrompts(3)
    expect(selected).toHaveLength(3)
  })

  it("caps at pool size", () => {
    const selected = selectPrompts(200)
    expect(selected).toHaveLength(102)
  })

  it("returns unique prompts", () => {
    const selected = selectPrompts(10)
    expect(new Set(selected).size).toBe(10)
  })

  it("seeded random produces deterministic results", () => {
    const a = selectPrompts(5, 42)
    const b = selectPrompts(5, 42)
    expect(a).toEqual(b)
  })

  it("different seeds produce different results", () => {
    const a = selectPrompts(5, 42)
    const b = selectPrompts(5, 99)
    expect(a).not.toEqual(b)
  })

  it("returns empty for count 0", () => {
    expect(selectPrompts(0)).toHaveLength(0)
  })
})
