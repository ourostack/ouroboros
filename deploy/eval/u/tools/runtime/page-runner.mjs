// Runs one bundled page script in jsdom, in a process lib.mjs starts under Node's permission model: it may read only
// this folder and the tools' node_modules (never the hidden test's driver source, the grader or any project), and may
// not write files, start processes or open an inspector. jsdom is no sandbox (its DOM functions belong to this
// process's realm), so this process is the boundary, and it judges nothing: every verdict comes from the grader's
// process (lib.mjs runPage, runtime/judge.mjs), where no page code runs.
//
// The protocol, one JSON object per line. stdin's first line is {"code","mode"}; mode is "hidden" or "axe". The
// driver in `code` only renders the component and presses controls. Before any of the component's code runs, it takes
// the runner's one-shot hooks off the window (page-start.mjs): `step`, and `report`, which says the page is finished.
// At each step this runner reads the live DOM into plain data from jsdom's own node tree, without running any of the
// page's code, and writes {"type":"step","name","a","b","c","snap"} to stdout; the grader answers on stdin with
// {"pick","value","delay"}: the id of the node the driver should press (or null), a yes or no for the driver, and how
// long to wait before answering. At the end it writes {"type":"end","error"?}.
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { types } from "node:util"
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
const { implForWrapper, wrapperForImpl } = require("jsdom/lib/jsdom/living/generated/utils.js")
const { domSymbolTree } = require("jsdom/lib/jsdom/living/helpers/internal-constants.js")

// Frames would give the page new realms (a frame's window) whose call sites aren't locked; no frame loads a window.
const { implementation: FrameImpl } = require("jsdom/lib/jsdom/living/nodes/HTMLFrameElement-impl.js")
const { implementation: ElementImpl } = require("jsdom/lib/jsdom/living/nodes/HTMLElement-impl.js")
FrameImpl.prototype._attach = function () { ElementImpl.prototype._attach.call(this) }
FrameImpl.prototype._attrModified = function (...args) { ElementImpl.prototype._attrModified.apply(this, args) }

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Remove a copy</title></head><body><main id="root"></main></body></html>'
const MAX_NODES = 20_000

// stdin: the first line is the page; each later line answers one step.
const lines = []
const waiting = []
let buffered = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffered += chunk
  for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
    const line = buffered.slice(0, at)
    buffered = buffered.slice(at + 1)
    if (waiting.length > 0) waiting.shift()(line)
    else lines.push(line)
  }
})
const nextLine = () => (lines.length > 0 ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiting.push(resolve)))
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const input = JSON.parse(await nextLine())
const { code } = input
const mode = input.mode === "axe" ? "axe" : "hidden"

/** Freezes the prototypes of the classes jsdom shares across its objects (its node implementations, its tree and its
 * CSS objects), so a page that reaches one can't change how jsdom behaves for this runner's own reads. */
function freezeShared() {
  const protos = new Set()
  const chain = (proto) => { for (let at = proto; at && at !== Object.prototype && !protos.has(at); at = Object.getPrototypeOf(at)) protos.add(at) }
  const living = path.join(MODULES, "jsdom", "lib", "jsdom", "living")
  for (const file of fs.readdirSync(living, { recursive: true })) {
    // The event-handler mixins are copied onto each new window, which must stay able to redefine them.
    if (!String(file).endsWith("-impl.js") || /EventHandlers-impl\.js$/.test(String(file))) continue
    const impl = require(path.join(living, String(file))).implementation
    if (typeof impl === "function") chain(impl.prototype)
  }
  for (const lib of ["cssstyle", "rrweb-cssom"]) {
    for (const value of Object.values(require(lib))) if (typeof value === "function" && value.prototype) chain(value.prototype)
  }
  chain(Object.getPrototypeOf(domSymbolTree))
  chain(require("symbol-tree/lib/SymbolTreeNode.js").prototype)
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

class Tampered extends Error {}
const ownKeys = Reflect.ownKeys
const describe = Reflect.getOwnPropertyDescriptor
const isProxy = types.isProxy
/** Every own property of a jsdom object must be plain data: a getter or a proxy the page put there would run the
 * page's code inside this runner's reads, so either one ends the run as tampered. */
function plain(object, what) {
  if (object === null || typeof object !== "object" || isProxy(object)) throw new Tampered(`${what} was replaced`)
  for (const key of ownKeys(object)) if (!("value" in describe(object, key))) throw new Tampered(`${what} has a getter`)
  return object
}
const field = (object, key, what) => describe(plain(object, what), key)?.value

async function run() {
  const virtualConsole = new VirtualConsole()
  const dom = new JSDOM(PAGE, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/", virtualConsole })
  const { window } = dom
  const errors = []
  window.addEventListener("error", (event) => errors.push(String(event.error?.message ?? event.message)))
  try {
    // jsdom's DOM classes belong to this process's realm, and a page reached this realm's Function constructor
    // through them (`document.constructor.constructor("return process")()`). This realm refuses code from strings
    // (above), and every function kind's constructor is also taken off this realm's prototypes before the page runs.
    for (const kind of [function () {}, async function () {}, function* () {}, async function* () {}]) {
      Object.defineProperty(Object.getPrototypeOf(kind), "constructor", { value: undefined, writable: false, configurable: false })
    }
    vm.runInThisContext(LOCK_TRACES)
    vm.runInThisContext(FREEZE)
    freezeShared()
    // Captured before the page's code runs: each element's computed display and visibility go into the snapshot.
    const computedStyle = window.getComputedStyle
    const getValue = window.CSSStyleDeclaration.prototype.getPropertyValue
    const PagePromise = window.Promise
    const docImpl = implForWrapper(window.document)
    const treeKey = domSymbolTree.symbol

    // Ids follow jsdom's nodes, so a control keeps its id from one snapshot to the next.
    const ids = new WeakMap()
    let nextId = 0
    let byId = new Map()
    /** The live page as plain data, read from jsdom's own fields (never through the page's objects). */
    const snapshot = () => {
      const seen = new Map()
      let count = 0
      const children = (node) => {
        const out = []
        const tree = field(node, treeKey, "a node")
        for (let child = tree ? field(tree, "firstChild", "the tree") : null; child; child = field(field(child, treeKey, "a node"), "nextSibling", "the tree")) {
          const taken = take(child)
          if (taken !== null) out.push(taken)
        }
        return out
      }
      const take = (node) => {
        count += 1
        if (count > MAX_NODES) throw new Tampered(`the page has more than ${MAX_NODES} nodes`)
        const type = field(node, "nodeType", "a node")
        if (type === 3) return String(field(node, "_data", "a text node"))
        if (type !== 1) return null
        const local = String(field(node, "_localName", "an element"))
        const ns = field(node, "_namespaceURI", "an element") ?? null
        const prefix = field(node, "_prefix", "an element") ?? null
        if (local === "script" || local === "template") return null
        if (!ids.has(node)) ids.set(node, (nextId += 1))
        const id = ids.get(node)
        seen.set(id, node)
        const list = plain(field(node, "_attributeList", "an element"), "an attribute list")
        if (!Array.isArray(list)) throw new Tampered("an attribute list was replaced")
        const attrs = []
        for (let i = 0; i < list.length; i += 1) {
          const attr = list[i]
          attrs.push([field(attr, "_namespace", "an attribute") ?? null, field(attr, "_namespacePrefix", "an attribute") ?? null, String(field(attr, "_localName", "an attribute")), String(field(attr, "_value", "an attribute"))])
        }
        const style = computedStyle.call(window, wrapperForImpl(node))
        const out = { i: id, e: [ns, prefix, local], a: attrs, d: String(getValue.call(style, "display")), v: String(getValue.call(style, "visibility")), k: children(node) }
        if (local === "input" && ns === "http://www.w3.org/1999/xhtml") out.val = String(field(node, "_value", "an input") ?? "")
        return out
      }
      let root = null
      for (let child = field(field(docImpl, treeKey, "the document"), "firstChild", "the tree"); child && !root; child = field(field(child, treeKey, "a node"), "nextSibling", "the tree")) {
        if (field(child, "nodeType", "a node") === 1) root = child
      }
      if (!root) throw new Tampered("the page has no root element")
      const snap = take(root)
      byId = seen
      return { snap }
    }

    // Compiled with the vm API, so the runner itself makes no code from strings either.
    const context = dom.getInternalVMContext()
    const load = (source, filename) => new vm.Script(source, { filename }).runInContext(context)
    load(LOCK_TRACES, "lock.js")
    load(fs.readFileSync(path.join(HERE, "shims.js"), "utf8"), "shims.js")
    let finished = false
    let busy = false
    let tampered = null
    const step = (name, a, b, c) => new PagePromise((resolve) => {
      if (finished || busy || tampered || typeof name !== "string") { resolve(null); return }
      busy = true
      let taken
      try {
        taken = snapshot()
      } catch (error) {
        tampered = error instanceof Tampered ? error.message : `the page couldn't be read: ${String(error?.message ?? error)}`
        busy = false
        resolve(null)
        return
      }
      send({ type: "step", name, a: typeof a === "number" ? a : -1, b: typeof b === "number" ? b : -1, c: typeof c === "string" ? c.slice(0, 2000) : "", ...taken })
      nextLine().then((line) => {
        let answer = {}
        try { answer = JSON.parse(line) } catch { /* no answer */ }
        const node = typeof answer.pick === "number" ? byId.get(answer.pick) : undefined
        const value = node ? wrapperForImpl(node) : answer.value === true
        const delay = typeof answer.delay === "number" ? Math.min(Math.max(answer.delay, 0), 5000) : 0
        setTimeout(() => { busy = false; resolve(value) }, delay)
      })
    })
    Object.defineProperty(window, "__u_report", { value: () => { finished = true }, configurable: true })
    Object.defineProperty(window, "__u_step", { value: step, configurable: true })
    load(code, "page.js")
    if (Object.hasOwn(window, "__u_report") || Object.hasOwn(window, "__u_step")) return { error: "the driver didn't take its hooks" }
    const started = Date.now()
    while (!finished && !tampered) {
      if (Date.now() - started > 30_000) return { error: `the page gave no result in 30s${errors.length ? `: ${errors[0]}` : ""}` }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (tampered) return { error: `tampered: ${tampered}` }
    return mode === "axe" && errors.length > 0 ? { pageError: errors[0].slice(0, 300) } : {}
  } catch (error) {
    return { error: `the page failed: ${String(error?.message ?? error)}` }
  } finally {
    window.close()
  }
}

const ended = await run()
process.stdout.write(`${JSON.stringify({ type: "end", ...ended })}\n`, () => process.exit(0))
