import { afterEach, beforeEach } from "vitest"
import { loadProduct } from "../../heart/product/active"

/** Where the Unraid image names the Butler's product module (deploy/unraid/container-runtime.json). */
export const BUTLER_PRODUCT_PATH = "/opt/ouro/dist/products/butler.js"

/** Runs each test in the calling file as the Butler image does: with the Butler's product loaded, so core knows its names. */
export function useButlerProduct(): void {
  // Imported when the first test starts, not with the file: a test file that mocks nerves/runtime has set its mock up by then.
  beforeEach(async () => {
    const { product } = await import("../../products/butler")
    loadProduct(BUTLER_PRODUCT_PATH, () => ({ product }))
  })
  afterEach(() => { loadProduct(undefined) })
}
