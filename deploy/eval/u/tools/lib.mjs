// The U arms' checking tools (pre-registration section 4), the same in every arm: the type-check, the axe scan of
// the rendered component, and the hidden remove-copy-card test. check.mjs answers run_checks; grade.mjs grades a run
// once its conversation has ended.
//
// The trust boundary: the type-check never runs the model's code. The scan and the hidden test bundle the
// component for the browser (no Node built-in resolves) with these tools' own settings, never the project's, and run
// the bundle in jsdom in a separate process under Node's permission model (runtime/page-runner.mjs): it can read
// only the runner and the tools' node_modules, so not this folder's hidden test or grader, nor any project, and can
// write no file. jsdom is no sandbox: its DOM objects belong to that process's realm. The runner closes the known ways
// from them to the process (the realm's Function constructors, refused code from strings, stack-trace call sites,
// frames' windows) and freezes the built-ins it uses; the driver takes its one-shot report function before the
// component loads; and the result counts only with the HMAC made under a key the page never sees. That is hardening, not proof: a component written
// to subvert the test, in its own page or through a way out not yet known, could change what is reported, so
// transcripts are kept for review.
import { spawn } from "node:child_process"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import ts from "typescript"

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
  ["stack trace hook", /\b(prepareStackTrace|captureStackTrace|stackTraceLimit)\b/],
  ["runner hook", /__u_|__U_/],
  // Any mention, not only `X.prototype.y =`: a prototype held in a variable or passed to Object.assign is written the same.
  ["prototype", /\bprototype\b/],
]

/** Every source file the model wrote that the bundle could load, outside node_modules: `file:line rule` per hit. */
export function escapeScan(project) {
  const hits = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
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
 * The page script: the component and a driver (the axe scan or the hidden test), bundled for the browser. The driver
 * takes the runner's one-shot report function before it imports the component (page-start.mjs), so the component
 * can't report first.
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
  }).catch((error) => ({ error }))
  if (result.error) {
    const messages = (result.error.errors ?? []).slice(0, 10).map((e) => `${e.location ? `${path.relative(project, path.resolve(project, e.location.file))}:${e.location.line}: ` : ""}${e.text}`)
    return { error: messages.length > 0 ? messages.join("\n") : String(result.error.message ?? result.error) }
  }
  return { code: result.outputFiles[0].text }
}

/**
 * Runs a page script in runtime/page-runner.mjs, in its own process under Node's permission model (reads of the
 * runner and the tools' node_modules only; no writes, processes or inspector), and takes its result only when it
 * carries the HMAC under a key made here, so nothing the page's code prints can stand in for it.
 */
export async function runPage({ code }, { axe = false, timeoutMs = 40_000 } = {}) {
  const mac = randomBytes(32).toString("hex")
  const runner = path.join(HERE, "runtime", "page-runner.mjs")
  const args = ["--disallow-code-generation-from-strings", "--permission", `--allow-fs-read=${path.join(HERE, "runtime")}${path.sep}`, `--allow-fs-read=${path.join(HERE, "node_modules")}${path.sep}`, runner]
  const answer = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: path.join(HERE, "runtime"), stdio: ["pipe", "pipe", "ignore"], env: {} })
    let out = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (chunk) => { if (out.length < 4_000_000) out += chunk })
    child.on("error", (error) => { clearTimeout(timer); resolve({ error: `the page runner could not start: ${error.message}` }) })
    child.on("close", (exit) => { clearTimeout(timer); resolve({ out, exit }) })
    child.stdin.on("error", () => undefined)
    child.stdin.end(JSON.stringify({ code, mac, axe }))
  })
  if (answer.error) return answer
  let parsed
  try {
    parsed = JSON.parse(answer.out)
  } catch {
    return { error: `the page gave no result (exit ${answer.exit})` }
  }
  const expected = createHmac("sha256", mac).update(String(parsed?.result)).digest("hex")
  if (typeof parsed?.result !== "string" || typeof parsed.sig !== "string" || parsed.sig.length !== expected.length || !timingSafeEqual(Buffer.from(parsed.sig), Buffer.from(expected))) {
    return { error: "the page's result was not the runner's" }
  }
  try {
    return JSON.parse(parsed.result)
  } catch {
    return { error: "the page's result was not JSON" }
  }
}

/** The axe scan: the component rendered with a test onRemove, WCAG 2.x A and AA rules. */
export async function scan(project) {
  const page = await bundle(project, "page-axe.mjs")
  if (page.error) return { ok: false, violations: 0, output: `Could not render ${COMPONENT}:\n${page.error}` }
  const result = await runPage(page, { axe: true })
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
