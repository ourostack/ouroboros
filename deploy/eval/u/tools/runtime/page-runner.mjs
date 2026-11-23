// Runs one bundled page script in jsdom, in a process lib.mjs starts under Node's permission model: it may read only
// this folder and the tools' node_modules (never the hidden test, the grader or any project), and may not write files,
// start processes or open an inspector. jsdom is no sandbox (its DOM functions belong to this process's realm), so
// this process is the boundary.
//
// stdin: {"code","mac","axe"}. The driver in `code` takes the one-shot report function the runner leaves at
// window.__u_report before any of the component's code runs (it imports the component only afterwards, and freezes
// the page's built-ins first: page-start.mjs), and reports its JSON result through it. This runner answers on stdout
// with {"result","sig"}, where sig is the HMAC-SHA256 of result under `mac`, which never enters the page.
import { createHmac } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

// lib.mjs starts this process with --disallow-code-generation-from-strings, so this realm's Function constructor,
// the way a page's code could get from jsdom's objects to `process`, refuses to make code. jsdom's selector engine
// (nwsapi) compiles selectors with the global Function, so the global name is pointed at the Function of an empty
// context, which may make code but holds nothing a page could use. The page's own context keeps its own eval.
globalThis.Function = vm.runInNewContext("Function", {}, { contextCodeGeneration: { strings: true, wasm: false } })
const { JSDOM, VirtualConsole } = await import("jsdom")

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Remove a copy</title></head><body><main id="root"></main></body></html>'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULES = path.join(HERE, "..", "node_modules")

const input = JSON.parse(fs.readFileSync(0, "utf8"))
const { code, axe } = input
const sign = (() => { const mac = input.mac; return (text) => createHmac("sha256", mac).update(text).digest("hex") })()
delete input.mac

// A stack trace's call sites give each frame's `this`, and a sloppy-mode frame of this realm's code (jsdom's selector
// engine) has this realm's global object as its `this`, with `process` on it. So no realm may take call sites: the
// hooks are fixed to nothing in this realm, and in the page's before its code runs.
const LOCK_TRACES = `for (const name of ["prepareStackTrace", "captureStackTrace"]) Object.defineProperty(Error, name, { value: undefined, writable: false, configurable: false })`

async function run() {
  const virtualConsole = new VirtualConsole()
  const dom = new JSDOM(PAGE, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/", virtualConsole })
  const { window } = dom
  const errors = []
  window.addEventListener("error", (event) => errors.push(String(event.error?.message ?? event.message)))
  // Frames would give the page new realms (an iframe's window) whose hooks aren't fixed; the page gets none.
  for (const name of ["contentWindow", "contentDocument"]) Object.defineProperty(window.HTMLIFrameElement.prototype, name, { get: () => null, configurable: false })
  try {
    // jsdom's DOM classes belong to this process's realm, and a page reached this realm's Function constructor
    // through them (`document.constructor.constructor("return process")()`). This realm refuses code from strings
    // (above), and every function kind's constructor is also taken off this realm's prototypes before the page runs;
    // the page keeps its own realm's Function, which reaches only the page.
    for (const kind of [function () {}, async function () {}, function* () {}, async function* () {}]) {
      Object.defineProperty(Object.getPrototypeOf(kind), "constructor", { value: undefined, writable: false, configurable: false })
    }
    vm.runInThisContext(LOCK_TRACES)
    // The page can still reach this realm's other built-ins through jsdom's objects, so the ones the signing and the
    // runner use are frozen: a page can't redefine a method on them to see or bend what the runner does after it.
    for (const shared of [Object, Object.prototype, Function.prototype, Array.prototype, String.prototype, JSON, Promise, Promise.prototype, Reflect, Error]) Object.freeze(shared)
    // Compiled with the vm API, so the runner itself makes no code from strings either.
    const context = dom.getInternalVMContext()
    const load = (source, filename) => new vm.Script(source, { filename }).runInContext(context)
    load(LOCK_TRACES, "lock.js")
    load(fs.readFileSync(path.join(HERE, "shims.js"), "utf8"), "shims.js")
    if (axe) load(fs.readFileSync(path.join(MODULES, "axe-core", "axe.min.js"), "utf8"), "axe.min.js")
    let reported
    Object.defineProperty(window, "__u_report", { value: (text) => { if (reported === undefined && typeof text === "string") reported = text }, configurable: true })
    load(code, "page.js")
    if (Object.hasOwn(window, "__u_report")) return JSON.stringify({ error: "the driver didn't take its report hook" })
    const started = Date.now()
    while (reported === undefined) {
      if (Date.now() - started > 20_000) return JSON.stringify({ error: `the page gave no result in 20s${errors.length ? `: ${errors[0]}` : ""}` })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return reported
  } catch (error) {
    return JSON.stringify({ error: `the page failed: ${String(error?.message ?? error)}` })
  } finally {
    window.close()
  }
}

const result = String(await run())
process.stdout.write(JSON.stringify({ result, sig: sign(result) }))
process.exit(0)
