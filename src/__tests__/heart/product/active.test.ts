import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadImageProduct, loadProduct, PRODUCT_SEAM_VERSION, productAgentAmong, productFor } from "../../../heart/product/active"
import { product as butlerProduct } from "../../../products/butler"

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
    vi.doMock("../../../heart/daemon/container-runtime", () => ({ readContainerRuntimePolicy: () => null }))
    try {
      const fresh = await import("../../../heart/product/active")
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
})
