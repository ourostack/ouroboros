// Runs one bundled page script in jsdom, in a process lib.mjs starts under Node's permission model: it may read only
// this folder and the tools' node_modules (never the hidden test's driver source, the grader or any project), and may
// not write files, start processes or open an inspector. jsdom is no sandbox (its DOM functions belong to this
// process's realm), so this process is the boundary.
//
// stdin: {"code","mac","mode"}, mode "hidden" or "axe". The driver in `code` only renders the component and presses
// controls. Before any of the component's code runs, it takes the runner's one-shot hooks off the window
// (page-start.mjs): `step`, which asks this runner's judge (judge.mjs) for each verdict, and `report`, which says the
// page is finished. The judge reads the live DOM from jsdom's own node tree and judges a script-free copy, so the
// verdicts never come from code the component can reach. This runner answers on stdout with {"result","sig"}, where
// sig is the HMAC-SHA256 of result under `mac`, which never enters the page.
import { createHmac } from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULES = path.join(HERE, "..", "node_modules")

// A stack trace's call sites give each frame's `this`, and a sloppy-mode frame of this realm's code (jsdom's selector
// engine) has this realm's global object as its `this`, with `process` on it. So no realm may take call sites: the
// hooks are fixed to nothing in this realm, the empty context's and the page's, before the page's code runs.
const LOCK_TRACES = `for (const name of ["prepareStackTrace", "captureStackTrace"]) Object.defineProperty(Error, name, { value: undefined, writable: false, configurable: false })`
// Freezes a realm's built-ins: every constructor and its prototype, the namespace objects and the iterator prototypes.
const FREEZE = `(() => {
  const seen = new Set()
  const freeze = (o) => { if (o !== null && (typeof o === "object" || typeof o === "function") && !seen.has(o)) { seen.add(o); Object.freeze(o) } }
  const names = ["Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "RegExp", "Date", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Promise", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Iterator"]
  for (const name of names) { const value = globalThis[name]; if (typeof value === "function") { freeze(value); freeze(value.prototype) } }
  for (const name of ["JSON", "Math", "Reflect", "Atomics", "Intl"]) freeze(globalThis[name])
  const proto = Object.getPrototypeOf
  for (const it of [[][Symbol.iterator](), new Map()[Symbol.iterator](), new Set()[Symbol.iterator](), ""[Symbol.iterator](), "a".matchAll(/a/g)]) { freeze(proto(it)); freeze(proto(proto(it))) }
  const gen = proto(function* () {}); freeze(gen); freeze(gen.prototype)
  const agen = proto(async function* () {}); freeze(agen); freeze(agen.prototype); freeze(proto(agen.prototype))
  freeze(proto(function () {})); freeze(proto(async function () {})); freeze(proto(Uint8Array)); freeze(proto(Uint8Array).prototype)
})()`

// lib.mjs starts this process with --disallow-code-generation-from-strings, so this realm's Function constructor,
// the way a page's code could get from jsdom's objects to `process`, refuses to make code. jsdom's selector engine
// (nwsapi) compiles selectors with the global Function, so the global name is pointed at the Function of an empty
// context, which may make code but holds nothing a page could use, with its call sites locked and built-ins frozen.
const empty = vm.createContext({}, { codeGeneration: { strings: true, wasm: false } })
vm.runInContext(`${LOCK_TRACES};${FREEZE}`, empty)
globalThis.Function = vm.runInContext("Function", empty)
const { JSDOM, VirtualConsole } = await import("jsdom")
const { createJudge } = await import("./judge.mjs")

// Frames would give the page new realms (a frame's window) whose call sites aren't locked; no frame loads a window.
const { implementation: FrameImpl } = require("jsdom/lib/jsdom/living/nodes/HTMLFrameElement-impl.js")
const { implementation: ElementImpl } = require("jsdom/lib/jsdom/living/nodes/HTMLElement-impl.js")
FrameImpl.prototype._attach = function () { ElementImpl.prototype._attach.call(this) }
FrameImpl.prototype._attrModified = function (...args) { ElementImpl.prototype._attrModified.apply(this, args) }

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Remove a copy</title></head><body><main id="root"></main></body></html>'
const AXE = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] }

const input = JSON.parse(fs.readFileSync(0, "utf8"))
const { code } = input
const mode = input.mode === "axe" ? "axe" : "hidden"
const sign = (() => { const mac = input.mac; return (text) => createHmac("sha256", mac).update(text).digest("hex") })()
delete input.mac

/** Freezes the prototypes of the classes jsdom shares between the page and the judge's copies (its node
 * implementations and its CSS objects), so a page that reaches one can't change how the judge's copy behaves. */
function freezeShared() {
  const protos = new Set()
  const chain = (proto) => { for (let at = proto; at && at !== Object.prototype && !protos.has(at); at = Object.getPrototypeOf(at)) protos.add(at) }
  const living = path.join(MODULES, "jsdom", "lib", "jsdom", "living")
  for (const file of fs.readdirSync(living, { recursive: true })) {
    // The event-handler mixins are copied onto each new window, which must stay able to redefine them; a copy runs no
    // handlers, so they don't bear on a verdict.
    if (!String(file).endsWith("-impl.js") || /EventHandlers-impl\.js$/.test(String(file))) continue
    const impl = require(path.join(living, String(file))).implementation
    if (typeof impl === "function") chain(impl.prototype)
  }
  for (const lib of ["cssstyle", "rrweb-cssom"]) {
    for (const value of Object.values(require(lib))) if (typeof value === "function" && value.prototype) chain(value.prototype)
  }
  // Every module is loaded before any prototype is frozen, so the mixins jsdom copies at load have been copied. jsdom
  // sets fields on its objects that share a name with a prototype's method, which a frozen data property would
  // refuse, so each data property becomes a fixed getter whose setter gives only that one object its own value.
  for (const proto of protos) {
    for (const key of Reflect.ownKeys(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, key)
      if (!("value" in d) || !d.configurable || key === "constructor") continue
      const value = d.value
      Object.defineProperty(proto, key, {
        get() { return value },
        set(next) {
          if (this === proto) throw new TypeError(`${String(key)} is fixed`)
          Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true })
        },
        enumerable: d.enumerable,
        configurable: false,
      })
    }
    Object.freeze(proto)
  }
}

async function run() {
  const virtualConsole = new VirtualConsole()
  const dom = new JSDOM(PAGE, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/", virtualConsole })
  const { window } = dom
  const errors = []
  window.addEventListener("error", (event) => errors.push(String(event.error?.message ?? event.message)))
  try {
    // jsdom's DOM classes belong to this process's realm, and a page reached this realm's Function constructor
    // through them (`document.constructor.constructor("return process")()`). This realm refuses code from strings
    // (above), and every function kind's constructor is also taken off this realm's prototypes before the page runs;
    // the page keeps its own realm's Function, which reaches only the page.
    for (const kind of [function () {}, async function () {}, function* () {}, async function* () {}]) {
      Object.defineProperty(Object.getPrototypeOf(kind), "constructor", { value: undefined, writable: false, configurable: false })
    }
    vm.runInThisContext(LOCK_TRACES)
    vm.runInThisContext(FREEZE)
    freezeShared()
    // Captured before the page's code runs: the judge reads each element's computed style with these.
    const computedStyle = window.getComputedStyle
    const getValue = window.CSSStyleDeclaration.prototype.getPropertyValue
    const computed = (el) => {
      const style = computedStyle.call(window, el)
      const parts = []
      if (getValue.call(style, "display") === "none") parts.push("display:none")
      if (getValue.call(style, "visibility") === "hidden") parts.push("visibility:hidden")
      return parts.join(";")
    }
    const judge = createJudge(window, computed)
    // Compiled with the vm API, so the runner itself makes no code from strings either.
    const context = dom.getInternalVMContext()
    const load = (source, filename) => new vm.Script(source, { filename }).runInContext(context)
    load(LOCK_TRACES, "lock.js")
    load(fs.readFileSync(path.join(HERE, "shims.js"), "utf8"), "shims.js")
    let finished = false
    Object.defineProperty(window, "__u_report", { value: () => { finished = true }, configurable: true })
    Object.defineProperty(window, "__u_step", { value: (name, a, b, c) => (finished ? null : judge.step(name, a, b, c)), configurable: true })
    load(code, "page.js")
    if (Object.hasOwn(window, "__u_report") || Object.hasOwn(window, "__u_step")) return JSON.stringify({ error: "the driver didn't take its hooks" })
    const started = Date.now()
    while (!finished) {
      if (Date.now() - started > 20_000) return JSON.stringify({ error: `the page gave no result in 20s${errors.length ? `: ${errors[0]}` : ""}` })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return JSON.stringify(mode === "axe" ? await judge.axe(AXE, errors[0]) : judge.hidden())
  } catch (error) {
    return JSON.stringify({ error: `the page failed: ${String(error?.message ?? error)}` })
  } finally {
    window.close()
  }
}

const result = String(await run())
process.stdout.write(JSON.stringify({ result, sig: sign(result) }))
process.exit(0)
