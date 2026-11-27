import { afterEach, describe, expect, it } from "vitest"
import { loadProduct, productFor } from "../../../heart/product/active"
import { PRODUCT_SEAM_VERSION } from "../../../heart/product/types"

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
})
