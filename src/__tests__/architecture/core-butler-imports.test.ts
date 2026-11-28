import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * M3's ratchet: core harness files must stop importing Butler code. Butler code is any file under src/ whose path names
 * the Butler (`sanctuary` or `butler`, which includes src/heart/butler-agent.ts) or sits under src/products/. Every other
 * file under src/ is core.
 *
 * ALLOWED lists the imports core has today. It may only shrink: a new import fails the first test, and an import that
 * has gone but is still listed fails the second, so whoever removes one also deletes its line.
 */
const ALLOWED: Record<string, readonly string[]> = {
  "eval/transport/telegram-turn": [
    "eval/transport/synthetic-sanctuary",
  ],
  "heart/daemon/cli-exec": [
    "heart/daemon/sanctuary-bundle-migration",
  ],
  "heart/daemon/container-healthcheck": [
    "heart/butler-agent",
    "heart/daemon/sanctuary-bundle-migration",
    "heart/daemon/sanctuary-package-management",
  ],
  "heart/daemon/container-spec-auditor": [
    "heart/butler-agent",
  ],
  "senses/root-host-approval-port": [
    "heart/daemon/sanctuary-authority-codec",
    "heart/daemon/sanctuary-host-authority",
  ],
  "senses/root-host-approval-runtime": [
    "repertoire/tools-sanctuary-host",
  ],
  "senses/telegram": [
    "heart/butler-agent",
    "heart/daemon/sanctuary-acceptance-marker",
    "repertoire/tools-sanctuary-host",
    "senses/sanctuary-authority-resident",
    "senses/sanctuary-grounding",
    "senses/sanctuary-interactive-control",
    "senses/sanctuary-runtime",
    "senses/sanctuary-sab",
  ],
  "senses/telegram-approval-runtime": [
    "heart/daemon/sanctuary-acceptance-marker",
  ],
  "senses/telegram-authority-transport": [
    "heart/daemon/sanctuary-authority-codec",
    "heart/daemon/sanctuary-telegram-authority-gateway",
  ],
}

const SRC = path.resolve(process.cwd(), "src")

function isButlerCode(relative: string): boolean {
  return /sanctuary|butler/i.test(relative) || relative.startsWith("products/")
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : []
  })
}

function moduleId(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/").replace(/\.ts$/, "")
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ""))
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm

function coreImportsOfButlerCode(): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const file of sourceFiles(SRC)) {
    const id = moduleId(file)
    if (isButlerCode(id)) continue
    const targets = new Set<string>()
    for (const match of fs.readFileSync(file, "utf-8").matchAll(IMPORT)) {
      const target = resolveImport(file, match[1]!)
      if (target && isButlerCode(moduleId(target))) targets.add(moduleId(target))
    }
    if (targets.size > 0) found[id] = [...targets].sort()
  }
  return found
}

describe("core harness files and Butler code (M3)", () => {
  const actual = coreImportsOfButlerCode()

  it("no core file gains an import of Butler code", () => {
    const added = Object.entries(actual).flatMap(([core, targets]) =>
      targets.filter((target) => !(ALLOWED[core] ?? []).includes(target)).map((target) => `${core} -> ${target}`))
    expect(added, "Core must reach Butler code through the product seam, not an import. Move the job behind the seam instead.").toEqual([])
  })

  it("lists only imports that still exist, so the list shrinks as they go", () => {
    const gone = Object.entries(ALLOWED).flatMap(([core, targets]) =>
      targets.filter((target) => !(actual[core] ?? []).includes(target)).map((target) => `${core} -> ${target}`))
    expect(gone, "These imports are gone: delete their lines from ALLOWED.").toEqual([])
  })

  it("finds imports in every form core uses", () => {
    expect(isButlerCode("heart/butler-agent")).toBe(true)
    expect(isButlerCode("senses/sanctuary-usenet")).toBe(true)
    expect(isButlerCode("products/butler")).toBe(true)
    expect(isButlerCode("heart/daemon/daemon")).toBe(false)
    const samples = [
      `import { x } from "./a"`,
      `export { y } from "../b"`,
      `const m = await import("./c")`,
      `const n = require("./d.js")`,
      `import "./e"`,
      `import fs from "node:fs"`,
    ].join("\n")
    expect([...samples.matchAll(IMPORT)].map((match) => match[1])).toEqual(["./a", "../b", "./c", "./d.js", "./e"])
  })
})
