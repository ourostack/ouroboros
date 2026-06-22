import { beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  verifyCardDidBinding,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { buildA2AAgentCard } from "../../a2a/card"
import { loadOrMintA2AIdentity } from "../../a2a/identity"
import type { RuntimeCredentialConfig } from "../../heart/runtime-credentials"

let sodium: Sodium

beforeAll(async () => {
  sodium = await ready()
})

async function mintIdentity(agentName: string): Promise<{ did: string }> {
  let config: RuntimeCredentialConfig = {}
  return loadOrMintA2AIdentity({
    agentName,
    sodium,
    config,
    upsert: async (next) => {
      config = next
    },
  })
}

describe("a2a agent card serves did:key", () => {
  it("emits the agent's did:key as a top-level card.did when an identity is provided", async () => {
    const identity = await mintIdentity("card-did-present")
    const card = buildA2AAgentCard({
      agentName: "card-did-present",
      baseUrl: "https://agent.example",
      did: identity.did,
    })
    expect(card.did).toBe(identity.did)
    // did:key binding is "card.did === did" with a null DID document.
    expect(verifyCardDidBinding({ card, did: identity.did, didDoc: null })).toBe(true)
  })

  it("omits did and stays valid for non-friends consumers when no identity is present (backward compat)", async () => {
    const card = buildA2AAgentCard({
      agentName: "card-did-absent",
      baseUrl: "https://agent.example",
    })
    // No DID field on a legacy/no-identity card.
    expect(card.did).toBeUndefined()
    // Existing card fields are unchanged (the non-friends contract is preserved).
    expect(card.name).toBe("card-did-absent")
    expect(card.url).toBe("https://agent.example/a2a")
    expect(card.supportedInterfaces[0]?.url).toBe("https://agent.example/a2a")
    expect(card.skills[0]?.id).toBe("ouro-message")
  })

  it("fails the binding check when the card.did disagrees with the presented did", async () => {
    const a = await mintIdentity("card-did-a")
    const b = await mintIdentity("card-did-b")
    const card = buildA2AAgentCard({
      agentName: "card-did-a",
      baseUrl: "https://agent.example",
      did: a.did,
    })
    // A card claiming A's DID must not bind to B's DID.
    expect(verifyCardDidBinding({ card, did: b.did, didDoc: null })).toBe(false)
  })
})
