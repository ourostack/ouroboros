import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadImageProduct, loadProduct, PRODUCT_SEAM_VERSION, productAgentAmong, productEventSource, productFor, productHabit, productTurnContext } from "../../../heart/product/active"
import { product as butlerProduct } from "../../../products/butler"
import { cacheMachineRuntimeCredentialConfig } from "../../../heart/runtime-credentials"

const PATH = "/opt/example/dist/product.js"
const product = { seamVersion: PRODUCT_SEAM_VERSION, id: "example", agents: ["helper", "old-helper"] }

afterEach(() => { loadProduct(undefined) })

describe("the product seam", () => {
  it("loads nothing when the image names no product, so core behaves as before", () => {
    expect(loadProduct(undefined)).toBeNull()
    expect(productFor("helper")).toBeNull()
  })

  it("answers for each of the product's names, and for no other agent", () => {
    expect(loadProduct(PATH, () => ({ product }))).toBe(product)
    expect(productFor("helper")).toBe(product)
    expect(productFor("old-helper")).toBe(product)
    expect(productFor("slugger")).toBeNull()
  })

  it("loads the module with require by default", () => {
    expect(() => loadProduct("/opt/example/missing-product.js")).toThrow(/product module \/opt\/example\/missing-product.js is invalid: it did not load \(Cannot find module/u)
  })

  it("stops the start when the module is not a valid product", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /does not export `product`/u],
      [null, /does not export `product`/u],
      [{ product: "butler" }, /does not export `product`/u],
      [{ product: { ...product, seamVersion: 2 } }, /seam version 2, and this harness runs version 1/u],
      [{ product: { ...product, id: "Example" } }, /id is not a lowercase name/u],
      [{ product: { ...product, agents: [] } }, /agents are not a list/u],
      [{ product: { ...product, agents: "helper" } }, /agents are not a list/u],
      [{ product: { ...product, agents: ["helper", 7] } }, /agents are not a list/u],
      [{ product: { ...product, agents: ["helper", "helper"] } }, /list a name twice/u],
    ]
    for (const [exported, problem] of cases) {
      expect(() => loadProduct(PATH, () => exported)).toThrow(problem)
    }
    expect(() => loadProduct(PATH, () => { throw "boom" })).toThrow(/did not load \(boom\)/u)
    expect(() => loadProduct(PATH, () => ({}))).toThrow(/Rebuild the image/u)
  })

  it("loads the product the image's runtime policy names, and none when the policy names none or is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "product-policy-"))
    const policyPath = path.join(dir, "container-runtime.json")
    fs.writeFileSync(policyPath, JSON.stringify({ scheduler: "supercronic", updates: "disabled", product: PATH }))
    const load = vi.fn(() => ({ product }))
    expect(loadImageProduct({ policyPath, load })).toBe(product)
    expect(load).toHaveBeenCalledWith(PATH)
    fs.writeFileSync(policyPath, JSON.stringify({ scheduler: "supercronic", updates: "disabled" }))
    expect(loadImageProduct({ policyPath })).toBeNull()
    expect(loadImageProduct({ policyPath: path.join(dir, "absent.json") })).toBeNull()
    expect(productFor("helper")).toBeNull()
  })

  it("settles the product on the first question in a process that has not loaded one", async () => {
    vi.resetModules()
    let policy: { product?: string } | null = { product: "/opt/example/missing-product.js" }
    vi.doMock("../../../heart/daemon/container-runtime", () => ({ readContainerRuntimePolicy: () => policy }))
    try {
      const fresh = await import("../../../heart/product/active")
      // A product the image names but that will not load fails every question, never answering as if there were none.
      expect(() => fresh.productFor("butler")).toThrow(/did not load/u)
      expect(() => fresh.productFor("butler")).toThrow(/did not load/u)
      policy = null
      expect(fresh.productFor("butler")).toBeNull()
      expect(fresh.productFor(7)).toBeNull()
    } finally {
      vi.doUnmock("../../../heart/daemon/container-runtime")
      vi.resetModules()
    }
  })

  it("finds the one agent the product runs among a daemon's agents", () => {
    loadProduct(PATH, () => ({ product }))
    expect(productAgentAmong(["slugger", "old-helper"])).toBe("old-helper")
    expect(productAgentAmong(["slugger"])).toBeNull()
    expect(productAgentAmong(["helper", "old-helper"])).toBeNull()
  })

  it("registers the Butler under its name and its name from before the rename", () => {
    expect(loadProduct("/opt/ouro/dist/products/butler.js", () => ({ product: butlerProduct }))).toBe(butlerProduct)
    expect(butlerProduct.agents).toEqual(["butler", "sanctuary"])
    expect(productFor("sanctuary")).toBe(butlerProduct)
  })

  it("has the Butler prepare its packaged bundle only when the daemon is told to manage one", () => {
    const input = { mode: "production" as const, managedAgents: ["butler"], repoRoot: "/opt/ouro", bundlesRoot: "/bundles", runtimePackageVersion: "1.0.0" }
    const plain = butlerProduct.startup!({ ...input, argv: ["node", "daemon-entry.js"] })
    expect(() => plain.preflight()).not.toThrow()
    expect(() => plain.prepareManagedBundle()).not.toThrow()
    // Told to manage a bundle that isn't there: the start stops.
    const missing = butlerProduct.startup!({ ...input, bundlesRoot: path.join(os.tmpdir(), "no-such-bundles"), argv: ["node", "daemon-entry.js", "--package-managed-agent", "butler"] })
    expect(() => missing.preflight()).toThrow(/human-required/u)
    expect(() => missing.prepareManagedBundle()).toThrow(/human-required/u)
  })

  it("answers a habit only for the product's agent and the product's own habit names", () => {
    const sweep = { run: async () => ({ ok: true }), requiresSchedulerAttestation: true }
    loadProduct(PATH, () => ({ product: { ...product, habits: { sweep } } }))
    expect(productHabit("helper", "sweep")).toBe(sweep)
    expect(productHabit("old-helper", "sweep")).toBe(sweep)
    expect(productHabit("slugger", "sweep")).toBeNull()
    expect(productHabit("helper", "other")).toBeNull()
    // Habit names come from bundle files, so a name that is only an object's built-in is no habit.
    expect(productHabit("helper", "constructor")).toBeNull()
    loadProduct(PATH, () => ({ product }))
    expect(productHabit("helper", "sweep")).toBeNull()
  })

  it("has the Butler run its house check in the daemon, fired only with the scheduler's proof", () => {
    expect(Object.keys(butlerProduct.habits!)).toEqual(["sanctuary-health"])
    expect(butlerProduct.habits!["sanctuary-health"]!.requiresSchedulerAttestation).toBe(true)
  })

  it("answers an event source only for the product's agent and the product's own source names", () => {
    const watch = { ready: async () => undefined }
    loadProduct(PATH, () => ({ product: { ...product, eventSources: { watch } } }))
    expect(productEventSource("helper", "watch")).toBe(watch)
    expect(productEventSource("slugger", "watch")).toBeNull()
    expect(productEventSource("helper", "other")).toBeNull()
    expect(productEventSource("helper", "toString")).toBeNull()
    loadProduct(PATH, () => ({ product }))
    expect(productEventSource("helper", "watch")).toBeNull()
  })

  it("gives a turn the product's part of its tool context, and nothing for an agent without one", async () => {
    const turn = { agentName: "helper", channel: "telegram" }
    await expect(productTurnContext(turn)).resolves.toEqual({})
    loadProduct(PATH, () => ({ product }))
    await expect(productTurnContext(turn)).resolves.toEqual({})
    const answerGates = { brevity: true }
    const turnContext = vi.fn(async () => ({ answerGates, agentRoot: "/bundles/helper.ouro" }))
    loadProduct(PATH, () => ({ product: { ...product, turnContext } }))
    await expect(productTurnContext(turn)).resolves.toEqual({ answerGates, agentRoot: "/bundles/helper.ouro" })
    expect(turnContext).toHaveBeenCalledWith(turn)
    await expect(productTurnContext({ agentName: "slugger", channel: "telegram" })).resolves.toEqual({})
  })

  it("fails the turn when the product's turn context fails, unless the turn may run without it", async () => {
    let thrown: unknown = new Error("house config is missing")
    loadProduct(PATH, () => ({ product: { ...product, turnContext: async () => { throw thrown } } }))
    await expect(productTurnContext({ agentName: "helper", channel: "a2a" })).rejects.toThrow("house config is missing")
    await expect(productTurnContext({ agentName: "helper", channel: "inner" }, { tolerant: true })).resolves.toEqual({})
    thrown = "not an error"
    await expect(productTurnContext({ agentName: "helper", channel: "a2a" })).rejects.toBe("not an error")
  })

  it("gives the Butler's turns its house runtime, which needs the machine's house config", async () => {
    loadProduct("/opt/ouro/dist/products/butler.js", () => ({ product: butlerProduct }))
    await expect(productTurnContext({ agentName: "butler", channel: "telegram" })).rejects.toThrow(/machine runtime config is missing/u)
  })

  it("holds the Butler's house and Usenet events until its machine config has what each needs", async () => {
    cacheMachineRuntimeCredentialConfig("sanctuary", {})
    await expect(butlerProduct.eventSources!["sanctuary-health"]!.ready("sanctuary")).rejects.toThrow(/\[agent-runnable\] Sanctuary machine runtime/u)
    await expect(butlerProduct.eventSources!["sanctuary-usenet"]!.ready("sanctuary")).rejects.toThrow(/\[agent-runnable\] Sanctuary machine runtime/u)
  })
})
