/**
 * The product seam: how a product built on the harness (the Butler is the first) tells core what it adds, so core files
 * never import product code. The image names the product's module in /opt/ouro/container-runtime.json (`product`); each
 * entry point loads it, and core asks `productFor(agentName)` for the job at hand. Each job gets one optional slot here,
 * added in the change that moves that job behind the seam.
 */
export const PRODUCT_SEAM_VERSION = 1

export interface OuroProduct {
  seamVersion: typeof PRODUCT_SEAM_VERSION
  /** Static id for logs and error text. Never compared with agent names. */
  id: string
  /** The names this product's agent answers to: its current name first, then former ones. */
  agents: readonly [string, ...string[]]
}

/** What a product module exports. */
export interface OuroProductModule {
  product: OuroProduct
}
