import * as fs from "node:fs"
import { builtinModules } from "node:module"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "../../..")

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : []
  })
}

function packageName(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!
}

describe("declared dependencies", () => {
  it("declares every package the shipped code loads, so no install depends on a package arriving transitively", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>
      optionalDependencies: Record<string, string>
    }
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.optionalDependencies)])
    const undeclared = new Map<string, string>()
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      const text = fs.readFileSync(file, "utf8")
      const runtimeImports = [
        ...text.matchAll(/^\s*import\s+(?!type\b)[^;]*?\bfrom\s+"([^"]+)"/gm),
        ...text.matchAll(/^\s*import\s+"([^"]+)"/gm),
        ...text.matchAll(/\b(?:require|import)\("([^"]+)"\)/g),
      ].map((match) => match[1]!)
      for (const specifier of runtimeImports) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue
        const name = packageName(specifier)
        if (builtinModules.includes(name) || declared.has(name)) continue
        undeclared.set(name, path.relative(ROOT, file))
      }
    }
    expect(Object.fromEntries(undeclared)).toEqual({})
  })
})
