import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { VENDOR_PATTERN } from "../../../eval/interviews/protocol"
import { checkVendorWords, NEUTRAL_LANE, neutralProviders, VENDOR_SCAN_MAX_BYTES } from "../../../eval/sandbox/neutral-bundle"

function write(root: string, file: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}

const read = (root: string, file: string): unknown => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"))

describe("the interviews' neutral bundle", () => {
  let bundle: string

  beforeEach(() => {
    bundle = fs.mkdtempSync(path.join(os.tmpdir(), "eval-neutral-"))
  })

  afterEach(() => {
    fs.rmSync(bundle, { recursive: true, force: true })
  })

  it("names one neutral provider in each lane, drops the fallback list and empties the readiness list", () => {
    write(bundle, "agent.json", JSON.stringify({
      version: 2,
      humanFacing: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
      agentFacing: { provider: "anthropic", model: "claude-sonnet-5-5" },
      providerFallback: [{ provider: "minimax", model: "MiniMax-M3" }],
      phrases: { thinking: ["one"] },
    }))
    write(bundle, "provider-readiness.json", JSON.stringify({
      version: 1, selectionPolicy: "explicit-same-lane-only", providers: [{ provider: "minimax", model: "MiniMax-M3", vaultItem: "providers/minimax" }],
    }))

    const gaps = neutralProviders(bundle)

    expect(NEUTRAL_LANE).toEqual({ provider: "github-copilot", model: "model" })
    expect(read(bundle, "agent.json")).toEqual({
      version: 2,
      humanFacing: { provider: "github-copilot", model: "model", effort: "high" },
      agentFacing: { provider: "github-copilot", model: "model" },
      phrases: { thinking: ["one"] },
    })
    expect(read(bundle, "provider-readiness.json")).toEqual({ version: 1, selectionPolicy: "explicit-same-lane-only", providers: [] })
    expect(gaps).toEqual([
      expect.stringMatching(/^agent\.json: .*github-copilot.*"model".*providerFallback/),
      expect.stringMatching(/^provider-readiness\.json: .*empty/),
    ])
    // What is left passes the vendor check.
    expect(() => checkVendorWords(bundle)).not.toThrow()
  })

  it("leaves a lane without a provider, and files that are absent, unreadable or already neutral, as they are", () => {
    write(bundle, "agent.json", JSON.stringify({ humanFacing: { model: "x" }, agentFacing: "lane", senses: {} }))
    expect(neutralProviders(bundle)).toEqual([])
    expect(read(bundle, "agent.json")).toEqual({ humanFacing: { model: "x" }, agentFacing: "lane", senses: {} })

    write(bundle, "agent.json", "not json")
    write(bundle, "provider-readiness.json", JSON.stringify({ version: 1, providers: [] }))
    expect(neutralProviders(bundle)).toEqual([])
    expect(fs.readFileSync(path.join(bundle, "agent.json"), "utf8")).toBe("not json")

    write(bundle, "agent.json", "null")
    write(bundle, "provider-readiness.json", JSON.stringify({ version: 1 }))
    expect(neutralProviders(bundle)).toEqual([])

    fs.rmSync(path.join(bundle, "agent.json"))
    fs.rmSync(path.join(bundle, "provider-readiness.json"))
    expect(neutralProviders(bundle)).toEqual([])
  })

  it("refuses a bundle whose text names a vendor, naming each file and its count and never the words around them", () => {
    write(bundle, "psyche/SOUL.md", "I was made by Claude. claude again, and GPT-5.")
    write(bundle, "skills/notes.md", "ask minimax or gemini or Grok, or mai-code")
    write(bundle, "books/README.md", "nothing here")

    let message = ""
    try { checkVendorWords(bundle) } catch (error) { message = (error as Error).message }

    expect(message).toMatch(/psyche\/SOUL\.md \(3\)/)
    expect(message).toMatch(/skills\/notes\.md \(4\)/)
    expect(message).not.toMatch(/books\/README/)
    expect(message).not.toMatch(/made by|again|ask/)
    expect(message.toLowerCase()).not.toMatch(new RegExp(VENDOR_PATTERN))
  })

  it("counts mai-code only where it starts a word, and none of the brand words an arm carries", () => {
    write(bundle, "a.md", "ouro ouroboros codex shadcn mendelow ourostack, domai-code")
    expect(() => checkVendorWords(bundle)).not.toThrow()
    write(bundle, "b.md", "use mai-code")
    expect(() => checkVendorWords(bundle)).toThrow(/b\.md \(1\)/)
  })

  it("skips binary files and symbolic links, and refuses a text file too large to scan", () => {
    write(bundle, "books/work/1/copy.epub", Buffer.concat([Buffer.from("PK\u0000\u0003"), Buffer.from("claude anthropic")]))
    fs.symlinkSync("/nowhere/claude", path.join(bundle, "claude-link"))
    expect(() => checkVendorWords(bundle)).not.toThrow()

    write(bundle, "big.txt", Buffer.alloc(VENDOR_SCAN_MAX_BYTES + 1, "a"))
    expect(() => checkVendorWords(bundle)).toThrow(/big\.txt \(too large to scan\)/)
  })
})
