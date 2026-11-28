import { emitNervesEvent } from "../../nerves/runtime"
import { readContainerRuntimePolicy } from "../daemon/container-runtime"
import type { ToolDefinition } from "../../repertoire/tools-base"
import type {
  OuroProduct, ProductAcceptanceMarker, ProductEventSource, ProductNotice, ProductOwnerReply, ProductHabit, ProductSense, ProductSenseReadiness, ProductSenseReadinessInput, ProductSenses, ProductStatusInput,
  ProductToolSelectionInput, ProductTools, ProductTurnContext, ProductTurnContextInput,
} from "./types"

/** The seam version this harness runs. A product built for another stops the start. */
export const PRODUCT_SEAM_VERSION = 1

let active: OuroProduct | null = null
// Unit tests run on machines with no image, often with fs mocked; their setup sets this before any module loads, so a
// process that hasn't loaded a product answers as one with no image policy, without reading it.
const TEST_NO_IMAGE_PRODUCT = Symbol.for("ouro.test.noImageProduct")
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
  const tools = (product as { tools?: { definitions?: unknown } }).tools
  if (tools !== undefined) {
    const definitions = tools?.definitions
    if (!Array.isArray(definitions)) throw invalid(modulePath, "its tools have no list of definitions")
    for (const definition of definitions as Array<{ tool?: { function?: { name?: unknown } }; ax?: { id?: unknown } } | null>) {
      const name = definition?.tool?.function?.name
      if (typeof name !== "string" || name.length === 0) throw invalid(modulePath, "one of its tools has no name")
      if (definition!.ax?.id !== `tool:${name}`) throw invalid(modulePath, `its tool ${name} has no Ouro AX card`)
    }
    const names = (definitions as Array<{ tool: { function: { name: string } } }>).map((definition) => definition.tool.function.name)
    if (new Set(names).size !== names.length) throw invalid(modulePath, "its tools list a name twice")
  }
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

function settle(): void {
  if (settled) return
  if ((globalThis as { [TEST_NO_IMAGE_PRODUCT]?: boolean })[TEST_NO_IMAGE_PRODUCT] === true) loadProduct(undefined)
  else loadImageProduct()
}

/** The loaded product when this agent (or a saved record's `agent`) is one of its names, else null. */
export function productFor(agentName: unknown): OuroProduct | null {
  settle()
  return active && typeof agentName === "string" && active.agents.includes(agentName) ? active : null
}

/** The one agent among `agents` that the product runs, or null when there is none or more than one. */
export function productAgentAmong(agents: readonly string[]): string | null {
  const owned = agents.filter((agent) => productFor(agent) !== null)
  return owned.length === 1 ? owned[0]! : null
}

/** The habit the product runs for this agent under this name, or null. Habit names come from bundle files, so only the product's own entries count. */
export function productHabit(agentName: string, habitName: string): ProductHabit | null {
  const habits = productFor(agentName)?.habits
  return habits && Object.hasOwn(habits, habitName) ? habits[habitName]! : null
}

/** The event source the product declares for this agent under this name, or null. Source names come from event records, so only the product's own entries count. */
export function productEventSource(agentName: string, source: string): ProductEventSource | null {
  const sources = productFor(agentName)?.eventSources
  return sources && Object.hasOwn(sources, source) ? sources[source]! : null
}

/**
 * The product's part of this turn's tool context (J4), or nothing when the agent has no product or the product adds none.
 * A rejection from the product fails the turn. On a `tolerant` turn it runs without the product's part instead, and says so.
 */
export async function productTurnContext(input: ProductTurnContextInput, options: { tolerant?: boolean } = {}): Promise<ProductTurnContext> {
  const product = productFor(input.agentName)
  if (!product?.turnContext) return {}
  try {
    return await product.turnContext(input)
  } catch (error) {
    emitNervesEvent({
      level: options.tolerant ? "warn" : "error",
      component: "daemon",
      event: "daemon.product_hook_error",
      message: options.tolerant ? "the product's turn context failed, so this turn runs without it" : "the product's turn context failed, so the turn or sense start that asked for it fails",
      meta: { productId: product.id, hook: "turnContext", agent: input.agentName, channel: input.channel, reason: error instanceof Error ? error.message : String(error) },
    })
    if (options.tolerant) return {}
    throw error
  }
}

function hookFailed(product: OuroProduct, hook: string, agent: string, error: unknown, message: string): void {
  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.product_hook_error",
    message,
    meta: { productId: product.id, hook, agent, reason: error instanceof Error ? error.message : String(error) },
  })
}

/** The tools the product adds for this agent's turns (J3), or null when the agent has no product or the product adds none. */
export function productTools(agentName: unknown): ProductTools | null {
  return productFor(agentName)?.tools ?? null
}

/** The loaded product's own tool definitions, whichever agent asks: they are registered for the whole process, as core's are. */
export function productToolDefinitions(): readonly ToolDefinition[] {
  settle()
  return active?.tools?.definitions ?? []
}

/** The tools the product adds to this turn's menu (J3), or none. A throw from the product fails the selection. */
export function productToolSelection(agentName: string | undefined, input: ProductToolSelectionInput): readonly ToolDefinition[] {
  const product = productFor(agentName)
  if (!product?.tools?.select) return []
  try {
    return product.tools.select(input)
  } catch (error) {
    hookFailed(product, "tools.select", agentName!, error, "the product's tool selection failed, so the turn's tools can't be selected")
    throw error
  }
}

/** The sections the product adds to `query_active_work` for this agent (J7), or null when it adds none. A rejection fails the call. */
export async function productActiveWorkSections(input: ProductStatusInput): Promise<string | null> {
  const product = productFor(input.agentName)
  if (!product?.status) return null
  try {
    return await product.status.activeWorkSections(input)
  } catch (error) {
    hookFailed(product, "status.activeWorkSections", input.agentName, error, "the product's status sections failed, so query_active_work fails")
    throw error
  }
}

/**
 * How this agent's product announces a delegated command to its owner (J8), or null when the agent takes none. A rejection
 * refuses the command, as the A2A server does for any failed notice, and is logged as the product's.
 */
export function productDelegationNotifier(agentName: string): ((notice: ProductNotice) => Promise<void>) | null {
  const product = productFor(agentName)
  const delegation = product?.a2a?.delegation
  if (!delegation) return null
  return async (notice) => {
    try {
      await delegation.notifyPrincipal(agentName, notice)
    } catch (error) {
      hookFailed(product!, "a2a.delegation.notifyPrincipal", agentName, error, "the product's delegated-command notice failed, so the command is refused")
      throw error
    }
  }
}

/** How this agent's product runs one of core's senses (J6), or null when it runs it core's way. */
export function productSense(agentName: unknown, sense: keyof ProductSenses): ProductSense | null {
  return productFor(agentName)?.senses?.[sense] ?? null
}

/** The product's repair line for a sense that isn't set up (J6), or null when core gives it. A throw from the product fails the status. */
export function productSenseRepairHint(agentName: string, sense: keyof ProductSenses): string | null {
  const product = productFor(agentName)
  const own = product?.senses?.[sense]
  if (!own) return null
  try {
    return own.repairHint(agentName)
  } catch (error) {
    hookFailed(product!, "senses.repairHint", agentName, error, "the product's sense repair line failed, so the sense's status can't be read")
    throw error
  }
}

/** The product's judgement of whether a sense is set up (J6), or null when core judges it. A throw from the product fails the status. */
export function productSenseReadiness(agentName: string, sense: keyof ProductSenses, input: ProductSenseReadinessInput): ProductSenseReadiness | null {
  const product = productFor(agentName)
  const own = product?.senses?.[sense]
  if (!own) return null
  try {
    return own.readiness(input)
  } catch (error) {
    hookFailed(product!, "senses.readiness", agentName, error, "the product's sense readiness failed, so the sense's status can't be read")
    throw error
  }
}

/** The name a sense shows for the admitted owner (J6): the product's, or "Owner". A throw from the product fails the turn. */
export function productSenseOwnerName(agentName: string, sense: keyof ProductSenses): string {
  const product = productFor(agentName)
  const own = product?.senses?.[sense]?.ownerName
  if (!own) return "Owner"
  try {
    return own(agentName)
  } catch (error) {
    hookFailed(product!, "senses.ownerName", agentName, error, "the product's owner name failed, so the owner's turn fails")
    throw error
  }
}

/** The text the owner gets for a reply (J6): the product's presentation of it, or the reply unchanged. A throw fails the send. */
export function productSenseOwnerReply(agentName: string, sense: keyof ProductSenses, reply: ProductOwnerReply): string {
  const product = productFor(agentName)
  const own = product?.senses?.[sense]?.presentOwnerReply
  if (!own) return reply.text
  try {
    return own(agentName, reply)
  } catch (error) {
    hookFailed(product!, "senses.presentOwnerReply", agentName, error, "the product's reply presentation failed, so the reply isn't sent")
    throw error
  }
}

/** The product's acceptance run in progress for this agent, or null (no product, or no run). A throw fails the caller. */
export function productAcceptanceMarker(agentName: string): ProductAcceptanceMarker | null {
  const product = productFor(agentName)
  const acceptance = product?.acceptance
  if (!acceptance) return null
  try {
    return acceptance.marker(agentName)
  } catch (error) {
    hookFailed(product!, "acceptance.marker", agentName, error, "the product's acceptance marker can't be read, so the caller fails")
    throw error
  }
}

/** The acceptance run's evidence fields for an event: its digest while a run is in progress, nothing otherwise. */
export function productAcceptanceEventMeta(agentName: string): { scenarioHandleDigest: string } | Record<string, never> {
  const marker = productAcceptanceMarker(agentName)
  return marker ? { scenarioHandleDigest: marker.scenarioHandleDigest } : {}
}

/** Runs an approved tool call bound to its approval inside the product's acceptance run; runs it plainly without a product. */
export function productRunAcceptanceApproved<T>(agentName: string, approval: { approvalId: string; argumentDigest: string }, operation: () => T): T {
  const acceptance = productFor(agentName)?.acceptance
  return acceptance ? acceptance.runApproved(approval, operation) : operation()
}
