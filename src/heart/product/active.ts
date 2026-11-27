import { emitNervesEvent } from "../../nerves/runtime"
import { readContainerRuntimePolicy } from "../daemon/container-runtime"
import type { OuroProduct } from "./types"

/** The seam version this harness runs. A product built for another stops the start. */
export const PRODUCT_SEAM_VERSION = 1

let active: OuroProduct | null = null
// Whether this process has settled which product it runs: by an explicit load, or by the first productFor reading the image's policy.
let settled = false

function invalid(modulePath: string, problem: string): Error {
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.product_load_error",
    message: "product module is invalid",
    meta: { modulePath, problem },
  })
  return new Error(`product module ${modulePath} is invalid: ${problem}. Rebuild the image so its product module exports a valid \`product\`.`)
}

function validProduct(value: unknown, modulePath: string): OuroProduct {
  const product = value && typeof value === "object" ? (value as { product?: unknown }).product : undefined
  if (!product || typeof product !== "object") throw invalid(modulePath, "it does not export `product`")
  const { seamVersion, id, agents } = product as Record<string, unknown>
  if (seamVersion !== PRODUCT_SEAM_VERSION) throw invalid(modulePath, `it is for seam version ${String(seamVersion)}, and this harness runs version ${PRODUCT_SEAM_VERSION}`)
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(id)) throw invalid(modulePath, "its id is not a lowercase name")
  if (!Array.isArray(agents) || agents.length === 0 || !agents.every((name) => typeof name === "string" && /^[a-z][a-z0-9-]*$/u.test(name))) {
    throw invalid(modulePath, "its agents are not a list of agent names")
  }
  if (new Set(agents).size !== agents.length) throw invalid(modulePath, "its agents list a name twice")
  return product as OuroProduct
}

/**
 * Loads the product module the image names, and makes it the one `productFor` answers with. No path means no product:
 * on a Mac, in dev and in tests nothing loads, and core behaves as it always has. A module that fails to load or is
 * invalid stops the start.
 */
export function loadProduct(modulePath: string | undefined, load: (modulePath: string) => unknown = require): OuroProduct | null {
  active = null
  if (modulePath === undefined) {
    settled = true
    return null
  }
  // A module that fails stays unsettled, so every later productFor in this process fails the same way instead of answering null.
  settled = false
  let loaded: unknown
  try {
    loaded = load(modulePath)
  } catch (error) {
    throw invalid(modulePath, `it did not load (${error instanceof Error ? error.message : String(error)})`)
  }
  active = validProduct(loaded, modulePath)
  settled = true
  emitNervesEvent({
    component: "daemon",
    event: "daemon.product_loaded",
    message: "product module loaded",
    meta: { modulePath, id: active.id, agents: [...active.agents] },
  })
  return active
}

/**
 * Loads the product /opt/ouro/container-runtime.json names (`product`), or none when the file is absent or names none. The
 * daemon calls it first, so a broken product stops the start; every other process (each sense, the agent's own turns, the CLI)
 * settles it on its first `productFor`, so no child can run without the product its image names.
 */
export function loadImageProduct(options: { policyPath?: string; load?: (modulePath: string) => unknown } = {}): OuroProduct | null {
  const policy = readContainerRuntimePolicy(options.policyPath === undefined ? {} : { path: options.policyPath })
  return loadProduct(policy?.product, options.load)
}

/** The loaded product when this agent (or a saved record's `agent`) is one of its names, else null. */
export function productFor(agentName: unknown): OuroProduct | null {
  if (!settled) loadImageProduct()
  return active && typeof agentName === "string" && active.agents.includes(agentName) ? active : null
}

/** The one agent among `agents` that the product runs, or null when there is none or more than one. */
export function productAgentAmong(agents: readonly string[]): string | null {
  const owned = agents.filter((agent) => productFor(agent) !== null)
  return owned.length === 1 ? owned[0]! : null
}
