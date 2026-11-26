import { describe, expect, it } from "vitest"
import { checkLetterInput, type Letter } from "../../../heart/letters/letter"
import { OPTIONS_LINE, renderLetter } from "../../../heart/letters/render"

/** A letter as filing makes it, from a sender's input. */
function filed(input: Record<string, unknown>, code = "L7"): Letter {
  const checked = checkLetterInput(input)
  if (!checked.ok) throw new Error(checked.problem)
  const { lane: _lane, ...draft } = checked.letter
  return { v: 1, id: "ltr_X", code, to: "friend-ari", from: { agent: "slugger" }, ...draft, createdAt: "2026-11-26T10:00:00.000Z" }
}

describe("renderLetter", () => {
  it("renders a decision with its reason and the harness's own option block", () => {
    expect(renderLetter(filed({
      kind: "decide", subject: "Which name ships?", whyOnlyYou: "It is your product.",
      options: [{ label: "Orca", effect: "Ship as Orca." }, { label: "Ouro", effect: "Ship as Ouro." }],
    }))).toMatchInlineSnapshot(`
      "L7 · Slugger asks: Which name ships?
      It is your product.
      Options (from Ouro):
      1 Orca — Ship as Orca.
      2 Ouro — Ship as Ouro.
      Reply "L7 1" or "L7 2"."
    `)
  })

  it("renders a heads-up with its single default option", () => {
    expect(renderLetter(filed({ kind: "know", subject: "The build is green" }, "L12"))).toMatchInlineSnapshot(`
      "L12 · Slugger says: The build is green
      Options (from Ouro):
      1 got it — The sender knows you have read it.
      Reply "L12 1"."
    `)
  })

  it("renders the body and links, dropping a line anchor from an address", () => {
    expect(renderLetter(filed({
      kind: "decide", subject: "Merge the fix?", whyOnlyYou: "You own the release.", body: "The test was flaky for a week.",
      links: [{ label: "The diff", url: "https://github.com/o/r/blob/main/a.ts#L12-L20" }, { label: "Run", url: "https://ci.example/run/5" }],
      options: [{ label: "Merge", effect: "It merges." }, { label: "Wait", effect: "It waits." }, { label: "Close", effect: "It closes." }],
    }))).toMatchInlineSnapshot(`
      "L7 · Slugger asks: Merge the fix?
      You own the release.
      The test was flaky for a week.
      The diff: https://github.com/o/r/blob/main/a.ts
      Run: https://ci.example/run/5
      Options (from Ouro):
      1 Merge — It merges.
      2 Wait — It waits.
      3 Close — It closes.
      Reply "L7 1", "L7 2" or "L7 3"."
    `)
  })

  it("keeps a sender's newlines from faking the option block, since filing collapsed them", () => {
    const text = renderLetter(filed({ kind: "know", subject: "Heads up", body: "line one\nline two" }))
    expect(text.split("\n").filter((line) => line === OPTIONS_LINE)).toHaveLength(1)
    expect(text).toContain("line one line two")
  })
})
