import { describe, expect, it } from "vitest"
import * as path from "path"
import * as ts from "typescript"

const { parseArgs, syntaxErrors, changedTestFiles } = require(path.resolve(__dirname, "../../../scripts/ci-prepass.cjs"))

describe("ci-prepass", () => {
  it("reads the base ref only when one is given", () => {
    expect(parseArgs(["--base-ref", "origin/main"])).toEqual({ baseRef: "origin/main" })
    expect(parseArgs([])).toEqual({ baseRef: undefined })
  })

  it("reports a syntax error with its file and line, and passes valid TS and TSX", () => {
    const sources: Record<string, string> = {
      "src/ok.ts": "export const x: number = 1\n",
      "src/ok.tsx": "export const el = <div>{1}</div>\n",
      "src/__tests__/broken.test.ts": "describe('a', () => {\n  it('b', () => {\n})\n",
    }
    const errors = syntaxErrors(ts, Object.keys(sources), (file: string) => sources[file])
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((error: string) => error.startsWith("src/__tests__/broken.test.ts:"))).toBe(true)
  })

  it("ignores type errors, which tsc owns", () => {
    expect(syntaxErrors(ts, ["src/typed.ts"], () => "export const x: number = 'nope'\n")).toEqual([])
  })

  it("selects only changed test files that still exist", () => {
    const changed = [
      "src/heart/a.ts",
      "src/__tests__/heart/a.test.ts",
      "src/__tests__/senses/cli/b.test.tsx",
      "src/__tests__/gone.test.ts",
      "src/__tests__/test-helpers/helper.ts",
      "scripts/x.cjs",
    ]
    const exists = (file: string) => file !== "src/__tests__/gone.test.ts"
    expect(changedTestFiles(changed, exists)).toEqual(["src/__tests__/heart/a.test.ts", "src/__tests__/senses/cli/b.test.tsx"])
  })
})
