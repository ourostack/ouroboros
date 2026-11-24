// The drivers' first step in the page, before they import the component: take the runner's one-shot hooks
// (runtime/page-runner.mjs) off the window, so the component's code never sees them, and freeze the page's own
// built-ins, so the component can't bend the driver's own steps through them. The verdicts themselves come from the
// runner's judge, outside the page. A second call, or a component that imports this module, gets nothing.
export function takeHooks() {
  const report = window.__u_report
  const step = window.__u_step
  delete window.__u_report
  delete window.__u_step
  const seen = new Set()
  const freeze = (o) => { if (o !== null && (typeof o === "object" || typeof o === "function") && !seen.has(o)) { seen.add(o); Object.freeze(o) } }
  for (const shared of [Object, Array, String, Number, Boolean, Symbol, RegExp, Map, Set, WeakMap, WeakSet, Promise, Error, Date]) { freeze(shared); freeze(shared.prototype) }
  for (const shared of [Function.prototype, JSON, Reflect, Math]) freeze(shared)
  const proto = Object.getPrototypeOf
  for (const it of [[][Symbol.iterator](), new Map()[Symbol.iterator](), new Set()[Symbol.iterator](), ""[Symbol.iterator]()]) { freeze(proto(it)); freeze(proto(proto(it))) }
  for (const name of ["setTimeout", "clearTimeout", "queueMicrotask", "Promise", "JSON"]) Object.defineProperty(window, name, { value: window[name], writable: false, configurable: false })
  return {
    report: typeof report === "function" ? report : () => undefined,
    step: typeof step === "function" ? step : () => null,
  }
}
