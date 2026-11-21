/**
 * The bundle a sandboxed run sees: a projection of the bundle under test that keeps only what the case needs and
 * none of the household's private state.
 *
 * It copies only the case's `include` paths from the bundle under test, and takes `psyche/TACIT.md` (what the Butler
 * learned about the household), `arc/`, `awaiting/`, `habits/`, `tool-profiles.json`, `bundle-meta.json` and
 * `provider-readiness.json` from the public seed bundle. It never copies `friends/`, `state/`, `desk/`, the books
 * CLI's `credentials.json`, `ledger.ndjson`, `removed/` or `work/`, any `.git`, or a symbolic link; those that the
 * turn writes start empty. The run's synthetic settings and owner are written later, by the sandbox and the turn.
 * What differs from the live bundle comes back as `gaps`, which every report lists.
 */
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

/** Package-managed files and folders, always from the public seed bundle. */
const FROM_SEED = ["psyche/TACIT.md", "arc", "awaiting", "habits", "tool-profiles.json", "bundle-meta.json", "provider-readiness.json"]
/** Never copied from the bundle under test, wherever they sit in an included path. */
const PRIVATE = ["friends", "state", "desk", "books/credentials.json", "books/ledger.ndjson", "books/removed", "books/work"]
/** Folders the turn and the books CLI write, created empty. */
const EMPTY = ["friends", "state", "desk", "arc", "books/work", "books/removed"]

export type ProjectionInput = { bundleDir: string; seedBundleDir: string; include: string[]; out: string }

function refuse(include: string, why: string): never {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.projection_error", message: "refused a bundle projection", meta: { include, why } })
  throw new Error(`cannot include ${include}: ${why}`)
}

// Compared in lower case: on a case-insensitive disk, `Friends` is the friends folder.
const isGit = (relative: string): boolean => relative.toLowerCase().split("/").includes(".git")
const isHouseholds = (relative: string): boolean => {
  const lower = relative.toLowerCase()
  return PRIVATE.some((p) => lower === p || lower.startsWith(`${p}/`))
}
const isPrivate = (relative: string): boolean => isGit(relative) || isHouseholds(relative)

function checkInclude(include: string): void {
  const normal = path.posix.normalize(include)
  if (path.isAbsolute(include) || normal !== include || normal.startsWith("..")) refuse(include, "it is not a plain path inside the bundle")
  if (isGit(normal)) refuse(include, "Git metadata is never projected")
  if (isHouseholds(normal)) refuse(include, "it holds the household's private state")
}

/** The first folder above `relative` that is a symbolic link, if any. */
function linkedAncestor(root: string, relative: string): string | undefined {
  const parts = relative.split("/").slice(0, -1)
  return parts.map((_part, index) => parts.slice(0, index + 1).join("/")).find((dir) => fs.lstatSync(path.join(root, dir), { throwIfNoEntry: false })?.isSymbolicLink())
}

/** Copies `relative` from `from` to `to`, skipping private paths and symbolic links, each link reported as a gap. */
function copyTree(from: string, to: string, relative: string, gaps: string[]): void {
  const source = path.join(from, relative)
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    gaps.push(`${relative}: a symbolic link, left out`)
    return
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(path.join(to, relative), { recursive: true })
    for (const name of fs.readdirSync(source).sort()) {
      const child = path.posix.join(relative, name)
      if (!isPrivate(child)) copyTree(from, to, child, gaps)
    }
    return
  }
  fs.mkdirSync(path.dirname(path.join(to, relative)), { recursive: true })
  fs.copyFileSync(source, path.join(to, relative))
  fs.chmodSync(path.join(to, relative), stat.mode & 0o755)
}

export function projectBundle(input: ProjectionInput): { gaps: string[] } {
  emitNervesEvent({ component: "eval", event: "eval.projection_start", message: "projecting a bundle for a sandboxed run", meta: { include: input.include } })
  for (const include of input.include) checkInclude(include)
  if (fs.existsSync(input.out)) {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.projection_error", message: "refused a bundle projection", meta: { out: input.out, why: "exists" } })
    throw new Error(`the projection folder ${input.out} already exists`)
  }
  fs.mkdirSync(input.out, { recursive: true, mode: 0o755 })
  const gaps: string[] = []
  for (const include of input.include) {
    const linked = linkedAncestor(input.bundleDir, include)
    if (linked) gaps.push(`${include}: under a symbolic link (${linked}), left out`)
    else if (!fs.existsSync(path.join(input.bundleDir, include))) gaps.push(`${include}: not in the bundle under test`)
    else copyTree(input.bundleDir, input.out, include, gaps)
  }
  for (const seeded of FROM_SEED) {
    fs.rmSync(path.join(input.out, seeded), { recursive: true, force: true })
    if (!fs.existsSync(path.join(input.seedBundleDir, seeded))) gaps.push(`${seeded}: not in the seed bundle`)
    else copyTree(input.seedBundleDir, input.out, seeded, gaps)
  }
  for (const dir of EMPTY) fs.mkdirSync(path.join(input.out, dir), { recursive: true })
  fs.writeFileSync(path.join(input.out, "books/ledger.ndjson"), "")
  gaps.push(
    "psyche/TACIT.md: the public seed's, not what the Butler learned about the household",
    "friends: one synthetic owner instead of the household's friends",
    "state: starts empty (no diary, sessions or runtime state)",
    "desk: starts empty",
    "books/credentials.json: synthetic, pointing at the fake household",
  )
  emitNervesEvent({ component: "eval", event: "eval.projection_end", message: "projected a bundle for a sandboxed run", meta: { gaps: gaps.length } })
  return { gaps }
}
