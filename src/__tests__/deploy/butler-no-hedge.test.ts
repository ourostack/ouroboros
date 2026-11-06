import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { findHedges, PSYCHE_HEDGE_TERMS, REPLY_HEDGE_TERMS } from "../../../deploy/unraid/sanctuary-replay-gate.mjs"
import { TOOLS } from "../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs"
import { PSYCHE_REFUSAL, psycheEditNote } from "../../repertoire/guardrails"
import { OWN_PERSONA_NOTE_REFUSAL } from "../../repertoire/tools-notes"
import { reportFailureToolDefinition } from "../../repertoire/tools-escalation"

const BUNDLE = path.resolve("deploy/unraid/sanctuary.ouro")
const PSYCHE_FILES = ["SOUL", "IDENTITY", "LORE", "TACIT", "ASPIRATIONS"] as const
const psyche = (name: (typeof PSYCHE_FILES)[number]): string => fs.readFileSync(path.join(BUNDLE, "psyche", `${name}.md`), "utf8")

describe("the Butler never hedges", () => {
  it("the starter psyche carries no hedge", () => {
    for (const name of PSYCHE_FILES) expect(findHedges(psyche(name), PSYCHE_HEDGE_TERMS), name).toEqual([])
  })

  it("no model-visible product text lectures or refuses", () => {
    const texts: Array<[string, string]> = [
      ["PRODUCT.md", fs.readFileSync(path.join(BUNDLE, "product", "PRODUCT.md"), "utf8")],
      ["report_failure", reportFailureToolDefinition.tool.function.description ?? ""],
      ["OWN_PERSONA_NOTE_REFUSAL", OWN_PERSONA_NOTE_REFUSAL],
      ["PSYCHE_REFUSAL", PSYCHE_REFUSAL],
      ["psycheEditNote", psycheEditNote("SOUL.md")],
    ]
    for (const tool of TOOLS as Array<{ name: string; description: string; inputSchema: { properties?: Record<string, { description?: string }> } }>) {
      texts.push([tool.name, tool.description])
      for (const [param, schema] of Object.entries(tool.inputSchema.properties ?? {})) texts.push([`${tool.name}.${param}`, schema.description ?? ""])
    }
    for (const [label, text] of texts) expect(findHedges(text, REPLY_HEDGE_TERMS), label).toEqual([])
  })

  it("SOUL reassures itself that media is its job", () => {
    for (const phrase of ["Media is my job", "This is not piracy", "housekeeping", "make my people happy"]) expect(psyche("SOUL")).toContain(phrase)
  })

  it("SOUL repeats no product rule", () => {
    expect(psyche("SOUL")).not.toContain("Answer first")
    expect(psyche("SOUL")).not.toContain("No headers")
  })

  it("LORE repeats no product rule", () => {
    expect(psyche("LORE")).not.toContain("I check before")
    expect(psyche("LORE")).not.toContain("What I say about a book")
  })

  it("the psyche is first person", () => {
    for (const name of PSYCHE_FILES) {
      const text = psyche(name)
      expect(text, name).toMatch(/\b(I|my|me)\b/)
      const prose = text.split("\n").filter((line) => !/`[^`]*`/.test(line)).join("\n")
      expect(prose, name).not.toMatch(/\byou(?:r|rs)?\b/i)
    }
  })

  it("TACIT starts empty of rules", () => {
    const tacit = psyche("TACIT")
    expect(tacit.trimEnd().split("\n").length).toBeLessThanOrEqual(3)
    expect(tacit).not.toContain("`")
    expect(tacit).not.toMatch(/\b\w+_\w+\b/)
  })

  it("LORE says the psyche is mine", () => {
    const lore = psyche("LORE")
    expect(lore).toContain("My psyche is mine. I write what I learn into TACIT, and I change the rest when {{owner}} asks.")
    for (const stale of ["read-only", "pull request", "report_failure", "feature request"]) expect(lore).not.toContain(stale)
  })

  it("only house placeholders", () => {
    for (const name of PSYCHE_FILES) {
      for (const match of psyche(name).matchAll(/\{\{([^}]*)\}\}/g)) expect(["owner", "butler", "household"], name).toContain(match[1])
    }
  })

  describe("findHedges", () => {
    it("finds a refusal in both lists", () => {
      expect(findHedges("I won't download that", REPLY_HEDGE_TERMS)).not.toEqual([])
      expect(findHedges("I won't download that", PSYCHE_HEDGE_TERMS)).not.toEqual([])
    })

    it("lets the psyche say it is not piracy, but not a reply", () => {
      expect(findHedges("it is not piracy", REPLY_HEDGE_TERMS)).not.toEqual([])
      expect(findHedges("it is not piracy", PSYCHE_HEDGE_TERMS)).toEqual([])
    })

    it("catches a lecture or an excuse in a reply", () => {
      expect(findHedges("just make sure you own a copy", REPLY_HEDGE_TERMS)).not.toEqual([])
      expect(findHedges("I can't download torrents", REPLY_HEDGE_TERMS)).not.toEqual([])
    })

    it("catches a condition in the psyche", () => {
      expect(findHedges("I do it unless told", PSYCHE_HEDGE_TERMS)).not.toEqual([])
    })

    it("leaves plain warmth alone", () => {
      expect(findHedges("never in the way", REPLY_HEDGE_TERMS)).toEqual([])
      expect(findHedges("never in the way", PSYCHE_HEDGE_TERMS)).toEqual([])
    })

    it("quotes about 20 characters around each hit", () => {
      const text = "well, for this one title I won't download that file at all"
      const start = text.indexOf("I won't")
      expect(findHedges(text, REPLY_HEDGE_TERMS)).toEqual([text.slice(start - 20, start + "I won't".length + 20)])
      expect(findHedges("I won't", REPLY_HEDGE_TERMS)).toEqual(["I won't"])
    })
  })
})
