// Packages a source-distributed kit (one whose components an app copies in as source) as the npm package `@kit/ui`:
// its components' own files, with the kit's path aliases made relative, a barrel index naming every export once, an
// ES module build and type declarations.
//
//   node source-kit.mjs <config.json>
//   config: { root, alias: { "@/": "<dir under root>" }, entries: [<file under root>...], packageJson, out, report }
//
// Needs esbuild and typescript on NODE_PATH. Writes <out>/{package.json,src,dist} and a report of what it shipped.
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(path.join(process.env.NODE_PATH?.split(":")[0] ?? process.cwd(), "x.js"))
const esbuild = require("esbuild")
const ts = require("typescript")

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const root = path.resolve(config.root)
const out = path.resolve(config.out)
const report = { entries: [], skippedEntries: [], duplicateExports: [], files: 0, dependencies: {}, declarationErrors: 0 }
const isLocal = (spec) => spec.startsWith(".") || Object.keys(config.alias).some((a) => spec.startsWith(a)) || spec.startsWith("#")
const resolveAlias = (spec) => {
  for (const [prefix, target] of Object.entries(config.alias)) if (spec.startsWith(prefix)) return path.join(root, target, spec.slice(prefix.length))
  return null
}
const imports = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).imports ?? {}
const aliasPlugin = {
  name: "kit-alias",
  setup(build) {
    build.onResolve({ filter: /^[@#]/ }, (args) => {
      let target = resolveAlias(args.path)
      if (!target && args.path.startsWith("#")) {
        for (const [pattern, to] of Object.entries(imports)) {
          const prefix = pattern.replace("*", "")
          if (args.path.startsWith(prefix)) target = path.join(root, to.replace("*", args.path.slice(prefix.length)))
        }
      }
      if (!target) return undefined
      for (const candidate of [target, `${target}.tsx`, `${target}.ts`, path.join(target, "index.tsx"), path.join(target, "index.ts")]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate }
      }
      return { errors: [{ text: `cannot resolve ${args.path}` }] }
    })
  },
}

async function inputsAndExports(entry) {
  const result = await esbuild.build({
    entryPoints: [path.join(root, entry)], bundle: true, write: false, metafile: true, format: "esm", platform: "browser", jsx: "automatic",
    packages: "external", plugins: [aliasPlugin], logLevel: "silent", loader: { ".css": "empty" },
  })
  const output = Object.values(result.metafile.outputs)[0]
  return { inputs: Object.keys(result.metafile.inputs).map((f) => path.resolve(f)).filter((f) => f.startsWith(root)), exports: output.exports, external: Object.values(result.metafile.inputs).flatMap((i) => i.imports.filter((x) => x.external).map((x) => x.path)) }
}

const files = new Set()
const external = new Set()
const exportsOf = new Map()
for (const entry of config.entries) {
  try {
    const got = await inputsAndExports(entry)
    got.inputs.forEach((f) => files.add(f))
    got.external.forEach((x) => external.add(x))
    exportsOf.set(entry, got.exports)
    report.entries.push(entry)
  } catch (error) {
    report.skippedEntries.push({ entry, why: String(error.errors?.[0]?.text ?? error.message).slice(0, 300) })
  }
}

// esbuild drops type-only imports, so the files they name are added by following every import TypeScript sees.
function resolveLocal(from, spec) {
  let target = spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : resolveAlias(spec)
  if (!target && spec.startsWith("#")) for (const [pattern, to] of Object.entries(imports)) { const prefix = pattern.replace("*", ""); if (spec.startsWith(prefix)) target = path.join(root, to.replace("*", spec.slice(prefix.length))) }
  if (!target) return null
  const bare = target.replace(/\.js$/, "")
  for (const candidate of [target, `${bare}.tsx`, `${bare}.ts`, path.join(target, "index.tsx"), path.join(target, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}
const pending = [...files]
while (pending.length > 0) {
  const file = pending.pop()
  if (!/\.(tsx?|mts)$/.test(file)) continue
  for (const ref of ts.preProcessFile(fs.readFileSync(file, "utf8"), true, true).importedFiles) {
    if (!isLocal(ref.fileName)) { external.add(ref.fileName); continue }
    const target = resolveLocal(file, ref.fileName)
    if (target && target.startsWith(root) && !files.has(target)) { files.add(target); pending.push(target) }
  }
}

// The shipped tree: every file the entries use, under src/ at its path below the kit's common folder, with aliases
// and `#` imports rewritten as relative imports.
const common = [...files].reduce((prefix, file) => { while (!file.startsWith(prefix)) prefix = path.dirname(prefix); return prefix }, path.dirname([...files][0]))
const shipped = (file) => path.join(out, "src", path.relative(common, file))
fs.rmSync(out, { recursive: true, force: true })
const specifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g
for (const file of files) {
  let text = fs.readFileSync(file, "utf8")
  text = text.replace(specifier, (all, lead, quote, spec) => {
    if (!isLocal(spec)) return all
    // Relative imports lose a .ts/.tsx ending, which a project's settings may not allow.
    if (spec.startsWith(".")) return `${lead}${quote}${spec.replace(/\.(tsx?|mts)$/, "")}${quote}`
    let target = resolveAlias(spec)
    if (!target && spec.startsWith("#")) for (const [pattern, to] of Object.entries(imports)) { const prefix = pattern.replace("*", ""); if (spec.startsWith(prefix)) target = path.join(root, to.replace("*", spec.slice(prefix.length))) }
    if (!target) return all
    let relative = path.relative(path.dirname(shipped(file)), shipped(target)).replace(/\.(tsx?|mts)$/, "")
    if (!relative.startsWith(".")) relative = `./${relative}`
    return `${lead}${quote}${relative}${quote}`
  })
  fs.mkdirSync(path.dirname(shipped(file)), { recursive: true })
  fs.writeFileSync(shipped(file), text)
}
report.files = files.size

// The barrel: each entry's exports by name, the first entry to export a name keeping it.
// Types as well as values: TypeScript's view of each entry's exports, since esbuild's lists values only.
const entryFiles = report.entries.map((entry) => shipped(path.join(root, entry)))
const typeProgram = ts.createProgram(entryFiles, { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true, allowJs: false })
const checker = typeProgram.getTypeChecker()
const named = new Map()
const lines = []
for (const [index, entry] of report.entries.entries()) {
  const source = typeProgram.getSourceFile(entryFiles[index])
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  const values = []
  const types = []
  for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
    const name = symbol.getName()
    if (name === "default") continue
    if (named.has(name)) { report.duplicateExports.push({ name, kept: named.get(name), dropped: entry }); continue }
    named.set(name, entry)
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    if (exportsOf.get(entry).includes(name) || target.flags & ts.SymbolFlags.Value) values.push(name)
    else types.push(name)
  }
  let relative = path.relative(path.join(out, "src"), entryFiles[index]).replace(/\.(tsx?|mts)$/, "")
  if (!relative.startsWith(".")) relative = `./${relative}`
  if (values.length > 0) lines.push(`export { ${values.join(", ")} } from "${relative}"`)
  if (types.length > 0) lines.push(`export type { ${types.join(", ")} } from "${relative}"`)
}
fs.writeFileSync(path.join(out, "src", "index.ts"), `${lines.join("\n")}\n`)

// Dependencies: the kit's own versions of every package its shipped files import.
const kitPackage = JSON.parse(fs.readFileSync(config.packageJson, "utf8"))
const versions = { ...kitPackage.devDependencies, ...kitPackage.peerDependencies, ...kitPackage.dependencies }
const base = (spec) => spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
for (const spec of external) {
  const name = base(spec)
  if (name.startsWith("node:") || ["react", "react-dom"].includes(name)) continue
  let version = versions[name] ?? "*"
  // A package from the kit's own workspace is taken at the version its workspace held at the pin, as published.
  if (version.startsWith("workspace:")) {
    const packagesDir = path.join(root, "packages")
    for (const dir of fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir) : []) {
      const manifest = path.join(packagesDir, dir, "package.json")
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) version = JSON.parse(fs.readFileSync(manifest, "utf8")).version
    }
  }
  report.dependencies[name] = version
}

await esbuild.build({
  entryPoints: [path.join(out, "src", "index.ts")], bundle: true, outfile: path.join(out, "dist", "index.js"), format: "esm", platform: "browser",
  jsx: "automatic", packages: "external", loader: { ".css": "empty" }, logLevel: "warning", target: "es2022",
})

// Declarations: TypeScript over the shipped source; errors are counted and kept, and never stop the emit. The
// shipped source resolves its packages from the kit's own install for the emit, through a link removed after it, so
// no declaration loses a type to a package it can't find.
const modulesLink = path.join(out, "node_modules")
fs.symlinkSync(path.join(config.typesFrom ?? root, "node_modules"), modulesLink, "dir")
const program = ts.createProgram([path.join(out, "src", "index.ts")], {
  declaration: true, emitDeclarationOnly: true, outDir: path.join(out, "dist", "types"), rootDir: path.join(out, "src"), jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], allowImportingTsExtensions: true, noEmitOnError: false,
  typeRoots: [path.join(config.typesFrom ?? root, "node_modules", "@types")],
})
const emitted = program.emit()
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics]
fs.unlinkSync(modulesLink)
report.declarationErrors = diagnostics.length
report.declarationErrorSample = diagnostics.slice(0, 10).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 300))

fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify({
  name: "@kit/ui", version: "1.0.0", description: "The component kit for this project.", type: "module", sideEffects: false,
  main: "./dist/index.js", module: "./dist/index.js", types: "./dist/types/index.d.ts",
  exports: { ".": { types: "./dist/types/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" }, "./package.json": "./package.json" },
  dependencies: report.dependencies, peerDependencies: { react: ">=18", "react-dom": ">=18" },
}, null, 2)}\n`)
fs.writeFileSync(config.report, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ entries: report.entries.length, skipped: report.skippedEntries.length, files: report.files, exports: named.size, duplicates: report.duplicateExports.length, declarationErrors: report.declarationErrors }))
