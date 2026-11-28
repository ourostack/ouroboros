import { afterEach, describe, expect, it, vi } from "vitest"
import { butlerTurnContracts } from "../../products/butler"
import { loadProduct, productSenseTurnContracts } from "../../heart/product/active"
import { sanctuaryFullVisibilityRequiredToolCalls, sanctuaryStaleDockerCareRequiredToolCalls } from "../../senses/sanctuary-full-visibility-contract"
import { sanctuaryInstallStateRequiredToolCalls, sanctuaryVersionQuestionRequiredToolCalls } from "../../senses/sanctuary-install-state-contract"
import { sanctuaryMediaCatalogRequiredToolCalls } from "../../senses/sanctuary-media-catalog-contract"
import { sanctuaryStorageOptimizationRequiredToolCalls } from "../../senses/sanctuary-storage-optimization-contract"
import { useButlerProduct } from "../test-helpers/butler-product"

const tools = ["sanctuary_get_install_state", "sanctuary_search_media_catalog", "unraid_get_storage", "unraid_get_system", "unraid_list_containers", "unraid_get_notifications", "sanctuary_check_services"]
const base = { agentName: "butler", advertisedToolNames: tools, activeCares: [], careEvidenceNow: 1_000 }

/** The contracts the Telegram sense composed itself before they moved to the product, for the same turn. */
function composedBefore(profileId: string | undefined, userMessage: string): string[][] {
  const owner = profileId === "sanctuary-owner"
  const household = owner || profileId === "sanctuary-household"
  const stale = owner ? sanctuaryStaleDockerCareRequiredToolCalls([], 1_000, tools) : undefined
  return [
    owner ? sanctuaryStorageOptimizationRequiredToolCalls(userMessage, tools) : undefined,
    owner ? sanctuaryFullVisibilityRequiredToolCalls(userMessage, tools, () => stale?.currentRiskClaims() ?? []) : undefined,
    stale,
    household ? sanctuaryMediaCatalogRequiredToolCalls(userMessage, tools) : undefined,
    owner ? sanctuaryInstallStateRequiredToolCalls(userMessage, tools) : undefined,
    owner ? sanctuaryVersionQuestionRequiredToolCalls(userMessage, tools) : undefined,
  ].filter((contract) => contract !== undefined).map((contract) => [...contract!.names])
}

const turns: Array<[string | undefined, string]> = [
  ["sanctuary-owner", "What are you working on?"],
  ["sanctuary-owner", "Can you see the library now?"],
  ["sanctuary-owner", "Please run SANCTUARY_GET_INSTALL_STATE now."],
  ["sanctuary-owner", "How is Sanctuary?"],
  ["sanctuary-household", "Can you see the library now?"],
  ["sanctuary-household", "What are you working on?"],
  ["sanctuary-event", "What are you working on?"],
  [undefined, "Can you see the library now?"],
]

describe("the Butler's Telegram turn contracts", () => {
  it.each(turns)("for %s asking %j, are the ones Telegram composed itself, in the same order", async (profileId, userMessage) => {
    const { contracts } = await butlerTurnContracts({ ...base, profileId, userMessage })
    expect(contracts.map((contract) => [...contract.names])).toEqual(composedBefore(profileId, userMessage))
  })

  it("holds the owner to the house's tools for full visibility, with its empty-answer fallback, and the household to the catalog", async () => {
    const owner = await butlerTurnContracts({ ...base, profileId: "sanctuary-owner", userMessage: "What are you working on?" })
    expect(owner.contracts.length).toBeGreaterThan(0)
    expect(owner.emptyResponseFallback).toBeTypeOf("function")
    const household = await butlerTurnContracts({ ...base, profileId: "sanctuary-household", userMessage: "Can you see the library now?" })
    expect(household.contracts.map((contract) => [...contract.names])).toEqual([["sanctuary_search_media_catalog"]])
    expect(household.emptyResponseFallback).toBeUndefined()
    expect(await butlerTurnContracts({ ...base, profileId: "sanctuary-event", userMessage: "Can you see the library now?" })).toEqual({ contracts: [] })
  })
})

describe("a product's turn contracts", () => {
  afterEach(() => { loadProduct(undefined) })

  it("are none for an agent with no product", async () => {
    expect(await productSenseTurnContracts("telegram", { ...base, agentName: "slugger", profileId: "sanctuary-owner", userMessage: "What are you working on?" })).toEqual({ contracts: [] })
  })

  it("fail the turn when the product's contracts throw, after logging the hook error", async () => {
    const { product } = await import("../../products/butler")
    const telegram = { ...product.senses!.telegram!, turnContracts: vi.fn(async () => { throw new Error("contract module missing") }) }
    loadProduct("/fixture/product.js", () => ({ product: { ...product, senses: { telegram } } }))
    await expect(productSenseTurnContracts("telegram", { ...base, profileId: "sanctuary-owner", userMessage: "hi" })).rejects.toThrow("contract module missing")
  })
})

describe("on the Butler's image", () => {
  useButlerProduct()

  it("Telegram's turns for either Butler name get the Butler's contracts", async () => {
    for (const agentName of ["butler", "sanctuary"]) {
      const { contracts } = await productSenseTurnContracts("telegram", { ...base, agentName, profileId: "sanctuary-household", userMessage: "Can you see the library now?" })
      expect(contracts.map((contract) => [...contract.names])).toEqual([["sanctuary_search_media_catalog"]])
    }
  })
})
