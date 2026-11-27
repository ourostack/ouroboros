import { emitNervesEvent } from "../../nerves/runtime"
import { PRODUCT_SEAM_VERSION, type OuroProduct } from "./types"

let active: OuroProduct | null = null

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
  if (modulePath === undefined) {
    active = null
    return null
  }
  let loaded: unknown
  try {
    loaded = load(modulePath)
  } catch (error) {
    throw invalid(modulePath, `it did not load (${error instanceof Error ? error.message : String(error)})`)
  }
  active = validProduct(loaded, modulePath)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.product_loaded",
    message: "product module loaded",
    meta: { modulePath, id: active.id, agents: [...active.agents] },
  })
  return active
}

/** The loaded product when this agent is one of its names, else null. */
export function productFor(agentName: string): OuroProduct | null {
  return active && active.agents.includes(agentName) ? active : null
}
