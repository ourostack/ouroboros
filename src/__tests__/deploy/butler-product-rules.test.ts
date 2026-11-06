import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

describe("the Butler's product rules", () => {
  it("ships the product rules with no heading and every required rule", () => {
    const text = fs.readFileSync(path.resolve("deploy/unraid/sanctuary.ouro/product/PRODUCT.md"), "utf8")
    expect(text.split("\n").filter((line) => line.startsWith("#"))).toEqual([])
    for (const rule of ["600 characters", "`*bold*`", "await_condition", "report_failure", "this turn", "no other", "in one line which file changed", "how the house works, I write it into TACIT"]) {
      expect(text, rule).toContain(rule)
    }
  })
})
