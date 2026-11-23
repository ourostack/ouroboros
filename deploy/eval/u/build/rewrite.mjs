// Brand rewrite for the U arms (pre-registration section 2): every brand word in a tree, in file contents and in
// file and folder names, becomes a neutral word, case-preserved, so a kit reads the same under `@kit/ui` whichever
// kit it is. The words are the study's brand pattern (src/eval/interviews/protocol.ts BRAND_PATTERN), plus the
// `Mui`/`mui` prefix of class names, theme keys and props (`MuiButton-root`, `muiName`), which `\bmui\b` misses.
//
//   node rewrite.mjs rewrite <dir> <report.json> [--keep-package-scopes] [--skip a,b]   rewrite in place, write the
//                                                                                       replacement list
//   node rewrite.mjs scan <dir> <report.json>                              list every brand hit left, exit 1 if any
//
// --keep-package-scopes leaves `@mui/` package names and the workspace's own `mui-` folder names as they are, so a
// monorepo's workspace still installs from its own lockfile while its tests run; the packaging pass renames them
// after. --workspace <dir> names the workspace whose folders are kept, when <dir> is a package inside node_modules.
import fs from "node:fs"
import path from "node:path"

export const BRAND_PATTERN = "ouro|ouroboros|codex|openhands|open hands|all-hands|openai|anthropic|claude|gpt|minimax|shadcn|radix|base ui|material[ -]?ui|\\bmui\\b|mendelow|ourostack"

// Longest and most specific first; each entry is [pattern source, neutral word].
export const RULES = [
  ["@mui/material(?![-\\w])", "@kit/ui", "package"],
  ["@mui/", "@kit/", "package"],
  ["(?<![\\w-])mui-(?=[a-z])", "kit-", "package"],
  ["ouroboros", "kit"],
  ["ourostack", "kit"],
  ["ouro", "kit"],
  ["shadcn", "kit"],
  ["radix", "prim"],
  ["openhands|open hands|all-hands", "agent"],
  ["codex", "agent"],
  ["openai|anthropic", "vendor"],
  ["claude", "assistant"],
  ["minimax|gpt", "model"],
  ["mendelow", "owner"],
  ["base ui", "base kit"],
  ["material[ -]?ui", "kit"],
  ["Mui(?=[A-Z])", "Kit", "exact"],
  ["mui(?=[A-Z])", "kit", "exact"],
  ["MUI(?=[A-Z_])", "KIT", "exact"],
  ["\\bmui\\b", "kit"],
]

function shape(match, word) {
  if (match === match.toUpperCase() && match !== match.toLowerCase()) return word.toUpperCase()
  if (match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1)
  return word
}

/**
 * The `mui-<name>` folder names of a workspace's own packages (`packages/mui-material` gives `material`), longest
 * first: the only `mui-` words kept while package names are kept. Every other `mui-` word, such as the `--mui-`
 * CSS variables and the `Mui-` state classes, is rewritten as the kit's own code is, so its tests stay consistent.
 */
export function workspaceFolderNames(root) {
  const names = []
  for (const parent of ["packages", "packages-internal"]) {
    const dir = path.join(root, parent)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && /^mui-[a-z]/.test(entry.name)) names.push(entry.name.slice(4))
  }
  return names.sort((a, b) => b.length - a.length)
}

export function compile(keepPackageScopes, keptFolders = []) {
  const kept = keptFolders.map((name) => name.replace(/[^a-z0-9-]/g, "")).filter(Boolean)
  const keptMui = `(?<!@)\\bmui\\b(?!/${kept.length > 0 ? `|-(?:${kept.join("|")})(?![\\w-])` : ""})`
  return RULES.filter(([, , kind]) => !(keepPackageScopes && kind === "package"))
    // While package names are kept, `@mui/x` and the workspace's own `mui-x` folders are names, not words.
    .map(([source, word, kind]) => [keepPackageScopes && source === "\\bmui\\b" ? keptMui : source, word, kind])
    .map(([source, word, kind]) => ({ source, word, regex: new RegExp(source, kind === "exact" || kind === "package" ? "g" : "gi"), exact: kind === "exact" || kind === "package" }))
}

/** `text` rewritten, with a count per rule. */
export function rewriteText(text, rules, counts) {
  let out = text
  for (const rule of rules) {
    out = out.replace(rule.regex, (match) => {
      const key = `${rule.source} -> ${rule.word}`
      counts[key] = (counts[key] ?? 0) + 1
      return rule.exact ? rule.word : shape(match, rule.word)
    })
  }
  return out
}

const isBinary = (buffer) => buffer.subarray(0, 8000).includes(0)

/**
 * Every entry under `dir`, but never `.git`. `skip` holds paths relative to the root, and the bare name
 * `node_modules`, which skips every `node_modules` folder at any depth.
 */
function* walk(dir, root = dir, skip = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.name === ".git" || skip.has(path.relative(root, full)) || (entry.name === "node_modules" && skip.has("node_modules"))) continue
    yield { full, entry }
    if (entry.isDirectory() && !entry.isSymbolicLink()) yield* walk(full, root, skip)
  }
}

export function rewriteTree(root, keepPackageScopes, skip = new Set(), workspace = root) {
  const rules = compile(keepPackageScopes, keepPackageScopes ? workspaceFolderNames(workspace) : [])
  const counts = {}
  const files = {}
  const renamed = []
  const binaries = []
  const collisions = []
  // `@mui/material` becomes `@kit/ui` as one name, which renaming each folder alone can't do: an installed
  // node_modules/@mui/material folder becomes @mui/ui first, and the name pass below makes @mui @kit.
  if (!keepPackageScopes) {
    for (const { full, entry } of [...walk(root, root, skip)]) {
      if (entry.isDirectory() && path.basename(full) === "material" && path.basename(path.dirname(full)) === "@mui" && path.basename(path.dirname(path.dirname(full))) === "node_modules") {
        fs.renameSync(full, path.join(path.dirname(full), "ui"))
        renamed.push([path.relative(root, full), "ui"])
      }
    }
  }
  // Contents first, then names deepest first, so a renamed folder never moves a path still to be visited.
  const all = [...walk(root, root, skip)]
  for (const { full, entry } of all) {
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(full)
      const local = {}
      const next = rewriteText(target, rules, local)
      if (next !== target) { fs.unlinkSync(full); fs.symlinkSync(next, full); files[path.relative(root, full)] = local; merge(counts, local) }
      continue
    }
    if (!entry.isFile()) continue
    const buffer = fs.readFileSync(full)
    if (isBinary(buffer)) {
      if (new RegExp(BRAND_PATTERN, "i").test(buffer.toString("latin1"))) binaries.push(path.relative(root, full))
      continue
    }
    const text = buffer.toString("utf8")
    const local = {}
    const next = rewriteText(text, rules, local)
    if (next !== text) {
      fs.writeFileSync(full, next)
      files[path.relative(root, full)] = local
      merge(counts, local)
    }
  }
  for (const { full } of all.sort((a, b) => b.full.split(path.sep).length - a.full.split(path.sep).length)) {
    const name = path.basename(full)
    const local = {}
    const next = rewriteText(name, rules, local)
    if (next === name) continue
    // Two names that differ only in a brand word (an `ouro` and a `shadcn` file side by side) become `kit` and `kit-2`.
    let target = path.join(path.dirname(full), next)
    // A package scope that becomes one already there (`@shadcn` beside `@kit`) is merged into it, package by package,
    // when no package name is in both: npm resolves `@kit/react` only in the one `@kit` folder.
    if (name.startsWith("@") && path.basename(path.dirname(full)) === "node_modules" && fs.existsSync(target)
      && fs.lstatSync(full).isDirectory() && fs.lstatSync(target).isDirectory()
      && fs.readdirSync(full).every((child) => !fs.existsSync(path.join(target, child)))) {
      for (const child of fs.readdirSync(full)) fs.renameSync(path.join(full, child), path.join(target, child))
      fs.rmdirSync(full)
      renamed.push([path.relative(root, full), `${next} (merged)`])
      merge(counts, local)
      continue
    }
    const extension = path.extname(next)
    for (let n = 2; fs.existsSync(target); n += 1) target = path.join(path.dirname(full), `${path.basename(next, extension)}-${n}${extension}`)
    fs.renameSync(full, target)
    renamed.push([path.relative(root, full), path.basename(target)])
    if (path.basename(target) !== next) collisions.push([path.relative(root, full), path.basename(target)])
    merge(counts, local)
  }
  return { keepPackageScopes, skipped: [...skip], counts, files: Object.keys(files).length, renamed, collisions, binariesWithHits: binaries }
}

function merge(into, from) {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value
}

/** Every brand hit left in a tree: the pattern, and the `Mui`/`mui` prefix. */
export function scanTree(root) {
  // The brand pattern in any case, and the prefixes in the exact cases the rewrite rules name: case-insensitive
  // prefixes would match base64 and other runs of letters ("MuIE") that are no word at all.
  const brand = new RegExp(BRAND_PATTERN, "gi")
  const prefixes = /Mui(?=[A-Z])|mui(?=[A-Z])|MUI(?=[A-Z_])/g
  const matches = (text) => [...text.matchAll(brand), ...text.matchAll(prefixes)]
  const hits = []
  for (const { full, entry } of walk(root)) {
    const relative = path.relative(root, full)
    for (const match of matches(path.basename(full))) hits.push({ file: relative, where: "name", word: match[0] })
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const buffer = fs.readFileSync(full)
    const text = isBinary(buffer) ? buffer.toString("latin1") : buffer.toString("utf8")
    for (const match of matches(text)) {
      hits.push({ file: relative, where: isBinary(buffer) ? "binary" : "text", word: match[0], context: text.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, " ") })
      if (hits.length > 5000) return hits
    }
  }
  return hits
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [mode, dir, report, ...flags] = process.argv.slice(2)
  const skipAt = flags.indexOf("--skip")
  const skip = new Set(skipAt >= 0 ? flags[skipAt + 1].split(",") : [])
  if (mode === "rewrite") {
    const workspaceAt = flags.indexOf("--workspace")
    const result = rewriteTree(path.resolve(dir), flags.includes("--keep-package-scopes"), skip, path.resolve(workspaceAt >= 0 ? flags[workspaceAt + 1] : dir))
    fs.writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`)
    console.log(`rewrote ${result.files} files, renamed ${result.renamed.length} paths; ${Object.values(result.counts).reduce((a, b) => a + b, 0)} replacements`)
  } else if (mode === "scan") {
    const hits = scanTree(path.resolve(dir))
    fs.writeFileSync(report, `${JSON.stringify({ hits: hits.length, list: hits }, null, 2)}\n`)
    console.log(`${hits.length} brand hits`)
    process.exit(hits.length === 0 ? 0 : 1)
  } else {
    console.error("usage: rewrite.mjs rewrite|scan <dir> <report.json> [--keep-package-scopes]")
    process.exit(2)
  }
}
