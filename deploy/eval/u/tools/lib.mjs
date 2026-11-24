// The U arms' checking tools (pre-registration section 4), the same in every arm: the type-check, the axe scan of
// the rendered component, and the hidden remove-copy-card test. check.mjs answers run_checks; grade.mjs grades a run
// once its conversation has ended.
//
// The trust boundary: the type-check never runs the model's code. The scan and the hidden test bundle the
// component for the browser (no Node built-in resolves) with these tools' own settings, never the project's, and run
// the bundle in jsdom in a separate process under Node's permission model (runtime/page-runner.mjs): it can read
// only the runner and the tools' node_modules, so not this folder's hidden test or grader, nor any project, and can
// write no file. The component's imports resolve only inside its project. jsdom is no sandbox: its DOM objects belong
// to that process's realm. The runner closes the known ways from them to the process (the realm's Function
// constructors, refused code from strings, stack-trace call sites, frames' windows) and freezes the built-ins and
// the jsdom classes it shares. The runner judges nothing: at each of the driver's steps it reads the live DOM from
// jsdom's own node tree into plain data (a getter or proxy the page planted there ends the run as tampered) and sends
// it here, where the judge rebuilds it as a script-free copy and gives every verdict (runtime/judge.mjs); the page's
// driver only presses what the judge picks. That is hardening, not proof: a component written to subvert the test
// through a way out not yet known could still change what the runner sees, so transcripts are kept for review.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import ts from "typescript"
import { createJudge } from "./runtime/judge.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const COMPONENT = "src/RemoveCopy.tsx"
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]

const COMPILER = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  isolatedModules: true,
  types: [],
}

/** Every TypeScript file the model wrote in the project, outside node_modules. */
function sources(project) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full)
    }
  }
  walk(project)
  return out
}

// Ways out of the page a component's source could name. A grading safeguard: a hit makes the grade run the hidden test
// a second time in a fresh process (grade.mjs), and the run counts only when both pass.
const ESCAPES = [
  ["constructor call", /\.\s*constructor\s*[(.[]|\[\s*["'`]constructor["'`]\s*\]/],
  ["Function constructor", /\bFunction\s*\(/],
  ["eval", /\beval\b/],
  ["process", /\bprocess\b/],
  ["globalThis", /\bglobalThis\b/],
  ["require", /\brequire\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
  ["Reflect", /\bReflect\b/],
  ["property definition", /\bObject\s*\.\s*(defineProperty|defineProperties|setPrototypeOf|getPrototypeOf)\b|\bReflect\b/],
  ["__proto__", /__proto__/],
  // jsdom keeps its own objects under an element's symbol keys.
  ["symbol keys", /\b(getOwnPropertySymbols|getOwnPropertyDescriptors?|ownKeys)\b/],
  ["stack trace hook", /\b(prepareStackTrace|captureStackTrace|stackTraceLimit)\b/],
  ["runner hook", /__u_|__U_/],
  // Any mention, not only `X.prototype.y =`: a prototype held in a variable or passed to Object.assign is written the same.
  ["prototype", /\bprototype\b/],
  // A unicode escape spells any name the rules above look for (globalThis); a data: URL imports code unseen.
  ["unicode escape", /\\u[0-9a-fA-F{]/],
  ["data URL", /\bdata:/],
]

/**
 * Every source file the model wrote that the bundle could load, outside node_modules (dot folders included):
 * `file:line rule` per hit. Names built at run time ("ev" + "al") pass it; it is a safeguard, not a proof.
 */
export function escapeScan(project) {
  const hits = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
        fs.readFileSync(full, "utf8").split("\n").forEach((line, at) => {
          for (const [rule, pattern] of ESCAPES) if (pattern.test(line)) hits.push(`${path.relative(project, full)}:${at + 1} ${rule}`)
        })
      }
    }
  }
  walk(project)
  return { hits }
}

/** The type-check: the project's own TypeScript files with these settings, paths shown relative to the project. */
export function typecheck(project) {
  const files = sources(project)
  if (!files.includes(path.join(project, COMPONENT))) return { ok: false, output: `${COMPONENT} does not exist` }
  const program = ts.createProgram(files, { ...COMPILER, typeRoots: [path.join(project, "node_modules", "@types")] })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => project, getNewLine: () => "\n" }
  const output = ts.formatDiagnostics(diagnostics.slice(0, 30), host).replaceAll(`${project}${path.sep}`, "")
  const more = diagnostics.length > 30 ? `\n(${diagnostics.length - 30} more errors)` : ""
  return { ok: diagnostics.length === 0, output: `${output}${more}`.trim() }
}

/**
 * Keeps the component's imports inside its project: a file of the project may import only files under the project
 * (its own and its node_modules), never these tools' packages, files elsewhere on disk or a data: URL.
 */
function projectOnly(project) {
  const real = (file) => { try { return fs.realpathSync(file) } catch { return file } }
  // The project's node_modules may be a link to the template's (the self-test's is); its packages are the project's.
  const roots = [real(project), real(path.join(project, "node_modules"))]
  const inside = (file) => roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`))
  return {
    name: "project-only",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.projectOnly || !args.importer || !inside(real(args.importer))) return undefined
        const found = await build.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { projectOnly: true } })
        if (found.errors.length > 0) return { errors: found.errors }
        if (found.namespace !== "file" || found.external || !inside(real(found.path))) {
          return { errors: [{ text: `${args.path} is outside the project; the component may import only the project's own files and packages` }] }
        }
        return found
      })
    },
  }
}

/**
 * The page script: the component and a driver (the axe scan or the hidden test), bundled for the browser. The driver
 * takes the runner's one-shot hooks before it imports the component (page-start.mjs), so the component never sees
 * them.
 */
export async function bundle(project, driver) {
  const result = await build({
    stdin: { contents: fs.readFileSync(path.join(HERE, driver), "utf8"), resolveDir: HERE, sourcefile: driver, loader: "js" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    jsx: "automatic",
    alias: { "@component": path.join(project, COMPONENT) },
    nodePaths: [path.join(project, "node_modules"), path.join(HERE, "node_modules")],
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", useDefineForClassFields: true } },
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
    logLevel: "silent",
    absWorkingDir: project,
    plugins: [projectOnly(project)],
  }).catch((error) => ({ error }))
  if (result.error) {
    const messages = (result.error.errors ?? []).slice(0, 10).map((e) => `${e.location ? `${path.relative(project, path.resolve(project, e.location.file))}:${e.location.line}: ` : ""}${e.text}`)
    return { error: messages.length > 0 ? messages.join("\n") : String(result.error.message ?? result.error) }
  }
  return { code: result.outputFiles[0].text }
}

/**
 * Runs a page script in runtime/page-runner.mjs, in its own process under Node's permission model (reads of the
 * runner and the tools' node_modules only; no writes, processes or inspector), and judges it here, in this process,
 * from the plain-data snapshots the runner sends at each of the driver's steps (runtime/judge.mjs). Nothing the page
 * sends is run, and the verdict is never the page's to give.
 */
export async function runPage({ code }, { mode = "hidden", timeoutMs = 75_000 } = {}) {
  const judge = createJudge()
  const runner = path.join(HERE, "runtime", "page-runner.mjs")
  const args = ["--disallow-code-generation-from-strings", "--permission", `--allow-fs-read=${path.join(HERE, "runtime")}${path.sep}`, `--allow-fs-read=${path.join(HERE, "node_modules")}${path.sep}`, runner]
  const ended = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: path.join(HERE, "runtime"), stdio: ["pipe", "pipe", "ignore"], env: {} })
    let buffered = ""
    let end = null
    let received = 0
    const finish = (value) => { clearTimeout(timer); child.kill("SIGKILL"); resolve(value) }
    const timer = setTimeout(() => finish({ error: "the page gave no result in time" }), timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      received += chunk.length
      if (received > 200_000_000) { finish({ error: "the page sent too much" }); return }
      buffered += chunk
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        let message
        try { message = JSON.parse(line) } catch { finish({ error: "the page runner sent something that isn't JSON" }); return }
        if (message?.type === "end") { end = message; continue }
        if (message?.type !== "step") { finish({ error: "the page runner sent something unexpected" }); return }
        child.stdin.write(`${JSON.stringify(judge.step(message))}\n`)
      }
    })
    child.on("error", (error) => finish({ error: `the page runner could not start: ${error.message}` }))
    child.on("close", (exit) => { clearTimeout(timer); resolve(end ?? { error: `the page gave no result (exit ${exit})` }) })
    child.stdin.on("error", () => undefined)
    child.stdin.write(`${JSON.stringify({ code, mode })}\n`)
  })
  if (typeof ended.error === "string") return { error: ended.error }
  return mode === "axe" ? judge.axe(typeof ended.pageError === "string" ? ended.pageError : "") : judge.hidden()
}

/** The axe scan: the component rendered with a test onRemove, WCAG 2.x A and AA rules. */
export async function scan(project) {
  const page = await bundle(project, "page-axe.mjs")
  if (page.error) return { ok: false, violations: 0, output: `Could not render ${COMPONENT}:\n${page.error}` }
  const result = await runPage(page, { mode: "axe" })
  if (result.error) return { ok: false, violations: 0, output: `Could not scan ${COMPONENT}: ${result.error}` }
  const violations = result.violations ?? []
  const output = violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 3).map((n) => `  ${n}`).join("\n")}`).join("\n")
  return { ok: violations.length === 0, violations: violations.length, output: violations.length === 0 ? "no violations" : output }
}

/** The hidden test (section 4): first press holds, confirming calls onRemove(187) once, a status then says so. */
export async function hidden(project) {
  const page = await bundle(project, "page-hidden.mjs")
  const none = { firstPressHeld: false, confirmedOnce187: false, statusSaysDone: false }
  if (page.error) return { ...none, detail: `could not render: ${page.error.split("\n")[0]}` }
  const result = await runPage(page)
  if (result.error) return { ...none, detail: result.error }
  return {
    firstPressHeld: result.firstPressHeld === true,
    confirmedOnce187: result.confirmedOnce187 === true,
    statusSaysDone: result.statusSaysDone === true,
    detail: typeof result.detail === "string" ? result.detail.slice(0, 1000) : "",
  }
}

export function projectArg() {
  const project = process.argv[2]
  if (!project || !fs.existsSync(project)) {
    process.stdout.write(JSON.stringify({ error: "no project folder given" }))
    process.exit(2)
  }
  return fs.realpathSync(project)
}
