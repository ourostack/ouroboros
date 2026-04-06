/**
 * Commerce self-test — per-service health checks for the agent's
 * commerce infrastructure (Stripe, Duffel, LiteAPI).
 *
 * Used by the setup wizard to verify configuration and provide
 * actionable error messages when services are misconfigured.
 */

import { createStripeClient } from "./stripe-client"
import { createDuffelClient } from "./duffel-client"
import { getCredentialStore } from "./credential-access"
import { emitNervesEvent } from "../nerves/runtime"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceTestResult {
  status: "ok" | "error"
  message: string
}

export interface SelfTestResult {
  overall: "healthy" | "partial" | "unhealthy"
  services: {
    stripe: ServiceTestResult
    duffel: ServiceTestResult
    liteapi: ServiceTestResult
  }
  summary: string
}

// ---------------------------------------------------------------------------
// Per-service tests
// ---------------------------------------------------------------------------

async function testStripe(): Promise<ServiceTestResult> {
  try {
    const client = await createStripeClient()
    // Create a test card and immediately deactivate it
    const card = await client.createVirtualCard({
      type: "single_use",
      spendLimit: 1,
      currency: "usd",
    })
    await client.deactivateCard(card.cardId)
    return { status: "ok", message: "Stripe Issuing working. Test card created and deactivated." }
  } catch (err) {
    /* v8 ignore next -- reason @preserve */
    const reason = err instanceof Error ? err.message : String(err)
    if (reason.includes("no credential found") || reason.includes("restrictedKey")) {
      return {
        status: "error",
        message: `Stripe key missing. Add your restricted key at https://dashboard.stripe.com/apikeys and store it in the vault as stripe.com/restrictedKey.`,
      }
    }
    if (reason.includes("401") || reason.includes("Invalid API Key")) {
      return {
        status: "error",
        message: `Stripe key returned 401. Verify it at https://dashboard.stripe.com/apikeys.`,
      }
    }
    return {
      status: "error",
      message: `Stripe error: ${reason}`,
    }
  }
}

async function testDuffel(): Promise<ServiceTestResult> {
  try {
    const client = await createDuffelClient()
    await client.searchFlights({
      origin: "SFO",
      destination: "JFK",
      departureDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      passengers: [{ type: "adult" }],
    })
    return { status: "ok", message: "Duffel Flights working. Test search completed." }
  } catch (err) {
    /* v8 ignore next -- reason @preserve */
    const reason = err instanceof Error ? err.message : String(err)
    if (reason.includes("no credential found") || reason.includes("apiKey")) {
      return {
        status: "error",
        message: `Duffel key missing. Add your API key from https://app.duffel.com/tokens and store it in the vault as duffel.com/apiKey.`,
      }
    }
    if (reason.includes("401") || reason.includes("Unauthorized")) {
      return {
        status: "error",
        message: `Your Duffel key returned 401. Verify it at https://app.duffel.com/tokens.`,
      }
    }
    return {
      status: "error",
      message: `Duffel error: ${reason}`,
    }
  }
}

async function testLiteApi(): Promise<ServiceTestResult> {
  try {
    const store = getCredentialStore()
    await store.getRawSecret("liteapi.travel", "apiKey")
    // If we can retrieve the key, the config is present.
    // LiteAPI is accessed via MCP, so we can't do a direct API call here.
    // The actual health check happens when the MCP server starts.
    return { status: "ok", message: "LiteAPI key found in vault. MCP server will use vault:liteapi.travel/apiKey." }
  } catch (err) {
    /* v8 ignore next -- reason @preserve */
    const reason = err instanceof Error ? err.message : String(err)
    if (reason.includes("no credential found")) {
      return {
        status: "error",
        message: `LiteAPI key missing. Get your API key from https://dashboard.liteapi.travel and store it in the vault as liteapi.travel/apiKey.`,
      }
    }
    return {
      status: "error",
      message: `LiteAPI error: ${reason}`,
    }
  }
}

// ---------------------------------------------------------------------------
// Main self-test
// ---------------------------------------------------------------------------

export async function commerceSelfTest(): Promise<SelfTestResult> {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_self_test_start",
    message: "starting commerce self-test",
    meta: {},
  })

  const [stripe, duffel, liteapi] = await Promise.all([
    testStripe(),
    testDuffel(),
    testLiteApi(),
  ])

  const services = { stripe, duffel, liteapi }
  const okCount = Object.values(services).filter((s) => s.status === "ok").length
  const total = Object.keys(services).length

  let overall: SelfTestResult["overall"]
  if (okCount === total) {
    overall = "healthy"
  } else if (okCount > 0) {
    overall = "partial"
  } else {
    overall = "unhealthy"
  }

  const lines: string[] = []
  if (stripe.status === "ok") lines.push("Stripe: working")
  else lines.push(`Stripe: ${stripe.message}`)
  if (duffel.status === "ok") lines.push("Duffel: working")
  else lines.push(`Duffel: ${duffel.message}`)
  if (liteapi.status === "ok") lines.push("LiteAPI: working")
  else lines.push(`LiteAPI: ${liteapi.message}`)

  const summary = `Commerce health: ${okCount}/${total} services ok.\n${lines.join("\n")}`

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.commerce_self_test_end",
    message: "commerce self-test complete",
    meta: { overall, okCount, total },
  })

  return { overall, services, summary }
}
