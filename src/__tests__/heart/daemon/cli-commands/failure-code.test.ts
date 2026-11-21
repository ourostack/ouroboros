import { describe, expect, it } from "vitest"
import { failureCodeLine } from "../../../../heart/daemon/cli-commands/failure-code"

describe("failureCodeLine", () => {
  it("ends stderr with a code the door's card names", () => {
    expect(failureCodeLine(Object.assign(new Error("x"), { code: "usage" }), ["usage", "needs-root"])).toBe("code: usage\n")
  })

  it("prints nothing for a code the card doesn't name, such as a Node ENOENT", () => {
    expect(failureCodeLine(Object.assign(new Error("x"), { code: "ENOENT" }), ["usage"])).toBe("")
  })

  it("prints nothing for a failure with no string code, or no failure object at all", () => {
    expect(failureCodeLine(Object.assign(new Error("x"), { code: 2 }), ["usage"])).toBe("")
    expect(failureCodeLine(new Error("x"), ["usage"])).toBe("")
    expect(failureCodeLine("plain", ["usage"])).toBe("")
    expect(failureCodeLine(null, ["usage"])).toBe("")
  })
})
