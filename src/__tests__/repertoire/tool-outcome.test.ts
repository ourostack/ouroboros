import { describe, expect, it } from "vitest"
import { typedOutcome, withCode } from "../../repertoire/tool-error-code"

describe("typedOutcome", () => {
  it("says a handler's success is done, with its text as the model reads it", () => {
    expect(typedOutcome({ kind: "handler_succeeded", text: "3 notes" })).toEqual({ state: "done", text: "3 notes" })
  })

  it("names the card's code on a refusal, a failure and an outcome nobody can know", () => {
    expect(typedOutcome({ kind: "rejected_before_handler", text: withCode("unknown: nope", "unknown-tool") })).toEqual({ state: "refused", text: "unknown: nope (code: unknown-tool)", code: "unknown-tool" })
    expect(typedOutcome({ kind: "handler_failed", text: withCode("no such file", "not-found") })).toEqual({ state: "failed", text: "no such file (code: not-found)", code: "not-found" })
    expect(typedOutcome({ kind: "handler_indeterminate", text: "timed out" })).toEqual({ state: "uncertain", text: "timed out" })
  })

  it("reads only a code at the end of the text", () => {
    expect(typedOutcome({ kind: "handler_failed", text: "said (code: inner) then more" })).toEqual({ state: "failed", text: "said (code: inner) then more" })
  })
})
