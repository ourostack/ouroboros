import * as fs from "node:fs"
import * as path from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { bookletWordsIn } from "../../../scripts/ouro-census/cards.mts"

// Spec R11.6: what a tool hands back (its results, rejections and the descriptions it serves) says what happened or what
// the tool is for, not a rule for the agent reading it. The census reads cards; this reads the strings the census can't:
// every string literal in these files, with the census's own booklet-word matcher.
const ROOT = path.resolve(__dirname, "../../..")
const FILES = [
  "deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs",
  "src/repertoire/mcp-write-guard.ts",
]

/** Reviewed exceptions, each a file, a piece of the string and the word it may say. It only shrinks. */
const ALLOW: { file: string; text: string; word: string }[] = []

function bookletStrings(file: string): { line: number; text: string; words: string[] }[] {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const found: { line: number; text: string; words: string[] }[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const words = bookletWordsIn(node.text)
      if (words.length) found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text, words })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("booklet words in tool results and rejections", () => {
  it.each(FILES)("%s states what happened instead of giving the reader a rule", (file) => {
    const unexplained = bookletStrings(file).flatMap(({ line, text, words }) => words
      .filter((word) => !ALLOW.some((allowed) => allowed.file === file && allowed.word === word && text.includes(allowed.text)))
      .map((word) => `${file}:${line} says "${word}": ${text.replace(/\s+/g, " ").slice(0, 120)}`))
    expect(unexplained).toEqual([])
  })

  it("finds a booklet word where one is", () => {
    // The scan itself: a planted rule in a template, a string and a split phrase are each found.
    const dir = fs.mkdtempSync(path.join(ROOT, ".booklet-probe-"))
    try {
      const probe = path.relative(ROOT, path.join(dir, "probe.ts"))
      fs.writeFileSync(path.join(ROOT, probe), "const a = `x ${1} never y`\nconst b = \"you must\"\nconst c = 'do\\nnot'\nconst d = \"nevermore\"\n")
      expect(bookletStrings(probe).map(({ line, words }) => [line, words])).toEqual([[1, ["never"]], [2, ["you must"]], [3, ["do not"]]])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
