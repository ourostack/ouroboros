import { afterEach, beforeEach } from "vitest"
import { loadProduct } from "../../heart/product/active"
import { product } from "../../products/butler"

/** Where the Unraid image names the Butler's product module (deploy/unraid/container-runtime.json). */
export const BUTLER_PRODUCT_PATH = "/opt/ouro/dist/products/butler.js"

/** Runs each test in the calling file as the Butler image does: with the Butler's product loaded, so core knows its names. */
export function useButlerProduct(): void {
  beforeEach(() => { loadProduct(BUTLER_PRODUCT_PATH, () => ({ product })) })
  afterEach(() => { loadProduct(undefined) })
}
