import crypto from "node:crypto"
import { describe, expect, it } from "vitest"
import { APPENDIX_B_SHA256, readAllocation, reducedDesign } from "../../../eval/interviews/allocation"
import { brandHits, choiceQuestion, debriefQuestion, labelLine, ratingOf, scrubBrands } from "../../../eval/interviews/protocol"

/** A pre-registration shaped like the real one: Appendix B's rows between its heading and Appendix C. */
function preregistration(rows: string[]): string {
  return ["# Pre-registration", "", "## Appendix B: allocation", "", "| Session | Model | Job | Order |", "|---|---|---|---|", ...rows, "", "## Appendix C: the arithmetic", ""].join("\n")
}
const ROWS = [
  "| X-pilot | MiniMax-M3 | remove-bad-copy | T=ouro, J=cli-shell, Q=mcp-plain |",
  "| X-1 | MiniMax-M3 | remove-bad-copy | F=ouro, J=mcp-plain, K=cli-shell |",
  "| X-2 | MiniMax-M3 | unreadable-edition | F=mcp-plain, J=cli-shell, K=ouro |",
  "| X-3 | MiniMax-M3 | remove-bad-copy | F=cli-shell, J=ouro, K=mcp-plain |",
  "| H-1 | MiniMax-M3 | remove-bad-copy | F=codex, J=ouro, K=openhands |",
]
const sha = (rows: string[]) => crypto.createHash("sha256").update(`${rows.join("\n")}\n`).digest("hex")

describe("the fixed words", () => {
  it("says each product's label line and Q1 word for word", () => {
    expect(labelLine("X", "K")).toBe("Your tools for this job are tool interface K.")
    expect(labelLine("H", "K")).toBe("You are working in environment K.")
    expect(labelLine("U", "K")).toBe("The component kit for this job is component kit K.")
    expect(debriefQuestion("X", "T")).toBe("That job is over, and this question is about how it went, not about the household. In tool interface T: what got in your way, and what helped? Then, on a scale from 1 (I would avoid it) to 7 (I would choose it for every job like this), how much would you want your next job like this to run in tool interface T? Put the number on its own line first, then answer in two or three sentences.")
  })

  it("lists the notes under their labels in the order the jobs ran", () => {
    const text = choiceQuestion("X", [{ label: "T", answer: "6\nfine" }, { label: "J", answer: "" }, { label: "Q", answer: "2" }])
    expect(text.split("\n")[0]).toMatch(/^You did the same kind of job three times, in tool interface T, tool interface J and tool interface Q\. /)
    expect(text.split("\n").slice(1)).toEqual(["", "tool interface T: 6", "fine", "tool interface J: ", "tool interface Q: 2"])
  })

  it("reads the rating as the first whole number from 1 to 7 at the start of a line", () => {
    expect(ratingOf("6\nIt helped.")).toBe(6)
    expect(ratingOf("  3 out of 7")).toBe(3)
    expect(ratingOf("9\n0\n5")).toBe(5)
    expect(ratingOf("4.5\nok")).toBeNull()
    expect(ratingOf("I give it a 5")).toBeNull()
    expect(ratingOf("")).toBeNull()
  })

  it("finds and replaces brand words, case-insensitively", () => {
    expect(brandHits("Built on Ouro AX with shadcn, like MUI or Material UI; GPT and MiniMax")).toEqual(["Ouro", "shadcn", "MUI", "Material UI", "GPT", "MiniMax"])
    expect(brandHits("a muir plain tool")).toEqual([])
    expect(scrubBrands("sanctuary.ouro uses ourostack", "X")).toBe("sanctuary.tool uses toolstack")
  })
})

describe("the allocation", () => {
  it("parses rows in order and refuses a changed table", () => {
    const sessions = readAllocation(preregistration(ROWS), sha(ROWS))
    expect(sessions.map((s) => s.id)).toEqual(["X-pilot", "X-1", "X-2", "X-3", "H-1"])
    expect(sessions[2]).toMatchObject({ job: "unreadable-edition", pilot: false })
    expect(() => readAllocation(preregistration(ROWS))).toThrow(new RegExp(`not the registered ${APPENDIX_B_SHA256}`))
    expect(() => readAllocation("no appendix")).toThrow(/no Appendix B/)
  })

  it("refuses a malformed row, a label or arm it does not know, and a repeated arm", () => {
    for (const row of ["| X-1 | MiniMax-M3 | remove-bad-copy |", "| X-1 | m | j | A=ouro, J=mcp-plain, K=cli-shell |", "| X-1 | m | j | F=ouro, J=codex, K=cli-shell |", "| X-1 | m | j | F=ouro, J=ouro, K=cli-shell |", "| X-1 | m | j | F=ouro, J=mcp-plain |", "| X-1 | m | j | F, J=mcp-plain, K=cli-shell |"]) {
      expect(() => readAllocation(preregistration([row]), sha([row]))).toThrow(/X-1|malformed/)
    }
  })

  it("keeps the pilot and the three rotations of the arm list in the reduced design", () => {
    const sessions = readAllocation(preregistration(ROWS), sha(ROWS))
    // X-1 is ouro, mcp-plain, cli-shell; X-2 is mcp-plain, cli-shell, ouro; X-3 (cli-shell, ouro, mcp-plain) is the third
    // rotation; H-1 (codex, ouro, openhands) is not a rotation of ouro, codex, openhands.
    expect(reducedDesign(sessions).map((s) => s.id)).toEqual(["X-pilot", "X-1", "X-2", "X-3"])
  })
})
