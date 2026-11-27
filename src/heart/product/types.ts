/**
 * The product seam: how a product built on the harness (the Butler is the first) tells core what it adds, so core files
 * never import product code. The image names the product's module in /opt/ouro/container-runtime.json (`product`); each
 * entry point loads it, and core asks `productFor(agentName)` for the job at hand. Each job gets one optional slot here,
 * added in the change that moves that job behind the seam.
 */
export interface OuroProduct {
  /** The seam version this product was built for; the harness refuses any other (see PRODUCT_SEAM_VERSION). */
  seamVersion: 1
  /** Static id for logs and error text. Never compared with agent names. */
  id: string
  /** The names this product's agent answers to: its current name first, then former ones. */
  agents: readonly [string, ...string[]]
  /**
   * Prepares the product's bundle when the daemon starts (J2). Called once, before the daemon starts anything, with what
   * the daemon knows about this start. `preflight` runs before and again after container credential bootstrap, and
   * `prepareManagedBundle` runs between them; a throw from either stops the start with the error's message.
   */
  startup?(input: ProductStartupInput): ProductStartup
}

/** What the daemon knows about this start when it asks the product to prepare. */
export interface ProductStartupInput {
  mode: "dev" | "production"
  /** The daemon's own argv, which carries the ENTRYPOINT's `--package-managed-agent`. */
  argv: readonly string[]
  /** The bundles homed on this machine. */
  managedAgents: readonly string[]
  repoRoot: string
  bundlesRoot: string
  runtimePackageVersion: string
}

export interface ProductStartup {
  preflight(): void
  prepareManagedBundle(): void
}

/** What a product module exports. */
export interface OuroProductModule {
  product: OuroProduct
}
