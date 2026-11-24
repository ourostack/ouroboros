// Assembles one arm's project template (/opt/u-kits/<slot> in the image): the same package.json shape, tsconfig and
// empty src/ in every arm, with only the kit's packages changing, installed with npm and then brand-rewritten
// throughout, node_modules included, and scanned for any brand word left.
//
//   node template.mjs <slot> <out-dir> <results-dir> <name=spec>...   e.g. @kit/ui=file:/work/pkg/k1.tgz
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { rewriteTree, scanTree } from "./rewrite.mjs"

const [slot, out, results, ...kitDeps] = process.argv.slice(2)
// The same React, types and settings in every arm. react-is is the one peer the kits' packages need and leave to the
// app (charts); peers are otherwise skipped (--legacy-peer-deps), so it is installed here, at React's version.
const SHARED = { react: "19.3.1", "react-dom": "19.3.1", "react-is": "19.3.1" }
const SHARED_DEV = { "@types/react": "19.3.0", "@types/react-dom": "19.3.0" }
export const TSCONFIG = {
  compilerOptions: {
    target: "ES2022", lib: ["ES2023", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx",
    strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, resolveJsonModule: true, isolatedModules: true, types: [],
  },
  include: ["src"],
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, "src"), { recursive: true })
// The first pair is the kit's main package, which is or becomes @kit/ui; a local tarball also overrides the same
// package wherever another kit package depends on it, so the kit's own packages come from the pin, not npm.
const dependencies = { ...SHARED }
const overrides = {}
const extras = {}
for (const [index, pair] of kitDeps.entries()) {
  const at = pair.indexOf("=", 1)
  const [name, spec] = [pair.slice(0, at), pair.slice(at + 1)]
  dependencies[name] = spec
  if (spec.startsWith("file:")) overrides[name] = spec
  else if (index > 0) extras[name] = spec
}
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify({ name: "app", private: true, version: "1.0.0", type: "module", dependencies, devDependencies: SHARED_DEV, overrides }, null, 2)}\n`)
execFileSync("npm", ["install", "--install-links", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", "--legacy-peer-deps"], { cwd: out, stdio: "inherit" })
// The kits' dependencies are ranges resolved at build time, so the version of every installed package is kept with
// the results (before the rewrite, under its published name); the lockfile itself would name the brand to the model.
const lock = JSON.parse(fs.readFileSync(path.join(out, "package-lock.json"), "utf8"))
const installed = Object.fromEntries(Object.entries(lock.packages ?? {}).filter(([at]) => at !== "").map(([at, entry]) => [at.replace(/^node_modules\//, ""), entry.version ?? null]).sort(([a], [b]) => a.localeCompare(b)))
fs.mkdirSync(results, { recursive: true })
fs.writeFileSync(path.join(results, `${slot}-installed.json`), `${JSON.stringify({ packages: Object.keys(installed).length, installed }, null, 2)}\n`)
fs.rmSync(path.join(out, "package-lock.json"), { force: true })
fs.rmSync(path.join(out, "node_modules", ".package-lock.json"), { force: true })

// The kit's packages were installed under their published names; the rewrite renames them everywhere at once.
const rewrite = rewriteTree(out, false)
// Binary files that hold a brand word (images, fonts, maps) are no use to the model and are removed.
for (const file of rewrite.binariesWithHits) fs.rmSync(path.join(out, file), { force: true })
// The project's package.json, as the model sees it: React, the kit as @kit/ui at its installed version, and any
// package the kit asks the app to install beside it (MUI's styling engine).
const kitVersion = JSON.parse(fs.readFileSync(path.join(out, "node_modules", "@kit", "ui", "package.json"), "utf8")).version
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify({ name: "app", private: true, version: "1.0.0", type: "module", dependencies: { ...SHARED, "@kit/ui": kitVersion, ...extras }, devDependencies: SHARED_DEV }, null, 2)}\n`)
fs.writeFileSync(path.join(out, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`)
const hits = scanTree(out)
fs.mkdirSync(results, { recursive: true })
fs.writeFileSync(path.join(results, `${slot}-template-rewrite.json`), `${JSON.stringify({ ...rewrite, renamed: rewrite.renamed.length, removedBinaries: rewrite.binariesWithHits }, null, 2)}\n`)
fs.writeFileSync(path.join(results, `${slot}-template-scan.json`), `${JSON.stringify({ hits: hits.length, list: hits.slice(0, 200) }, null, 2)}\n`)
console.log(JSON.stringify({ slot, replacements: Object.values(rewrite.counts).reduce((a, b) => a + b, 0), renamed: rewrite.renamed.length, removedBinaries: rewrite.binariesWithHits.length, brandHitsLeft: hits.length }))
if (hits.length > 0) process.exit(1)
