// The drivers' first step in the page, before they import the component: take the runner's one-shot report function
// (runtime/page-runner.mjs) off the window, so the component's code never sees it, and freeze the page's own
// built-ins (and pin axe's name, when loaded), so the component can't bend what the driver sees through them. Every kit's
// reference passes with them frozen (build-kits.sh). A second call, or a component that imports this module, gets
// nothing.
export function takeReport() {
  const report = window.__u_report
  delete window.__u_report
  for (const shared of [Object, Object.prototype, Array, Array.prototype, Function.prototype, String.prototype, Number.prototype, Boolean.prototype, RegExp.prototype, Map.prototype, Set.prototype, WeakMap.prototype, Promise, Promise.prototype, JSON, Reflect, Math, Error]) Object.freeze(shared)
  // axe keeps its own state on its object, so it can't be frozen; the name is pinned and the driver holds its run.
  for (const name of ["setTimeout", "clearTimeout", "queueMicrotask", "Promise", "JSON", ...(window.axe ? ["axe"] : [])]) Object.defineProperty(window, name, { value: window[name], writable: false, configurable: false })
  return typeof report === "function" ? report : () => undefined
}
