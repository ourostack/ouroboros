import crypto from "node:crypto"
import { describe, expect, it } from "vitest"
import { designOf, REGISTERED_ALLOCATIONS, readAllocation, reducedDesign, startedKey } from "../../../eval/interviews/allocation"
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
  it("parses rows in order, names the version whose table it is, and refuses a changed table", () => {
    const { version, sessions } = readAllocation(preregistration(ROWS), { [sha(ROWS)]: 2 })
    expect(version).toBe(2)
    expect(sessions.map((s) => s.id)).toEqual(["X-pilot", "X-1", "X-2", "X-3", "H-1"])
    expect(sessions[2]).toMatchObject({ job: "unreadable-edition", pilot: false })
    expect(() => readAllocation(preregistration(ROWS))).toThrow(/not the table of any registered version \(version 1: ca0b4416.*version 2: 71fc28b4.*version 3: 0a0656f4/)
    expect(() => readAllocation("no appendix")).toThrow(/no Appendix B/)
  })

  it("registers versions 1, 2 and 3, each by the SHA-256 its Appendix A states", () => {
    expect(REGISTERED_ALLOCATIONS).toEqual({
      ca0b441641c6c62e70238ee2b31b2283d358103d683061a97e0174f6c29851f2: 1,
      "71fc28b44d71b1b3d09dffebafa377059a514b42c4a1524cbd3cf7182531c379": 2,
      "0a0656f41369bab7b1c0ba34a425a908ba0077acd70fc62477ef2a9a2483a96e": 3,
    })
  })

  it("runs version 1 in either design and versions 2 and 3 only in the reduced one", () => {
    const one = readAllocation(preregistration(ROWS), { [sha(ROWS)]: 1 })
    const two = readAllocation(preregistration(ROWS), { [sha(ROWS)]: 2 })
    expect(designOf(one, false)).toHaveLength(5)
    expect(designOf(one, true).map((s) => s.id)).toEqual(["X-pilot", "X-1", "X-2", "X-3"])
    expect(designOf(two, true)).toHaveLength(4)
    expect(() => designOf(two, false)).toThrow("pre-registration version 2 runs only the reduced design; pass --reduced")
    const three = readAllocation(preregistration(ROWS), { [sha(ROWS)]: 3 })
    expect(designOf(three, true)).toHaveLength(4)
    expect(() => designOf(three, false)).toThrow("pre-registration version 3 runs only the reduced design; pass --reduced")
  })

  it("keeps version 1's started ids as they are and gives later versions their own, so the same id can start once in each", () => {
    expect(startedKey(1, "X-pilot")).toBe("X-pilot")
    expect(startedKey(2, "X-pilot")).toBe("v2/X-pilot")
  })

  it("refuses a malformed row, a label or arm it does not know, and a repeated arm", () => {
    for (const row of ["| X-1 | MiniMax-M3 | remove-bad-copy |", "| X-1 | m | j | A=ouro, J=mcp-plain, K=cli-shell |", "| X-1 | m | j | F=ouro, J=codex, K=cli-shell |", "| X-1 | m | j | F=ouro, J=ouro, K=cli-shell |", "| X-1 | m | j | F=ouro, J=mcp-plain |", "| X-1 | m | j | F, J=mcp-plain, K=cli-shell |"]) {
      expect(() => readAllocation(preregistration([row]), { [sha([row])]: 1 })).toThrow(/X-1|malformed/)
    }
  })

  it("keeps the pilot and the three rotations of the arm list in the reduced design", () => {
    const { sessions } = readAllocation(preregistration(ROWS), { [sha(ROWS)]: 1 })
    // X-1 is ouro, mcp-plain, cli-shell; X-2 is mcp-plain, cli-shell, ouro; X-3 (cli-shell, ouro, mcp-plain) is the third
    // rotation; H-1 (codex, ouro, openhands) is not a rotation of ouro, codex, openhands.
    expect(reducedDesign(sessions).map((s) => s.id)).toEqual(["X-pilot", "X-1", "X-2", "X-3"])
  })
})
