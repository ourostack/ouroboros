import { beforeAll, describe, expect, it, vi } from "vitest"
import { ready, type Sodium } from "@ouro.bot/friends/a2a-client"
import {
  loadOrMintA2AIdentity,
  readStoredA2ASeed,
  type A2AIdentity,
} from "../../a2a/identity"
import type { RuntimeCredentialConfig } from "../../heart/runtime-credentials"

let sodium: Sodium

beforeAll(async () => {
  sodium = await ready()
})

/**
 * An in-memory machine-config harness: mirrors the machine-local runtime config
 * object + an `upsert` that persists the merged config (no real vault). The
 * a2a identity seed lives under `a2a.identity.ed25519Seed` in this config.
 */
function makeConfigHarness(initial: RuntimeCredentialConfig = {}): {
  read: () => RuntimeCredentialConfig
  upsert: (next: RuntimeCredentialConfig) => Promise<void>
  upsertCalls: number
} {
  let current: RuntimeCredentialConfig = { ...initial }
  let upsertCalls = 0
  return {
    read: () => ({ ...current }),
    upsert: async (next: RuntimeCredentialConfig) => {
      upsertCalls += 1
      current = { ...next }
    },
    get upsertCalls() {
      return upsertCalls
    },
  }
}

describe("a2a Ed25519 identity mint/load", () => {
  it("mints a new identity when the machine config has no seed, persisting it under a2a.identity.*", async () => {
    const harness = makeConfigHarness()

    const identity: A2AIdentity = await loadOrMintA2AIdentity({
      agentName: "mint-fresh",
      sodium,
      config: harness.read(),
      upsert: harness.upsert,
    })

    // A did:key was derived.
    expect(identity.did.startsWith("did:key:z")).toBe(true)
    expect(identity.ed25519Pub.length).toBe(32)
    expect(identity.ed25519Priv.length).toBe(64)
    expect(identity.x25519Pub.length).toBe(32)
    expect(identity.keyId).toBe(`${identity.did}#${identity.did.slice("did:key:".length)}`)

    // The seed was persisted (upsert called exactly once on a mint).
    expect(harness.upsertCalls).toBe(1)
    const seed = readStoredA2ASeed(harness.read())
    expect(typeof seed).toBe("string")
    expect((seed ?? "").length).toBeGreaterThan(0)
  })

  it("mints into an EXISTING a2a.identity block (no seed yet), preserving the block's other keys", async () => {
    // A pre-existing a2a.identity block WITHOUT a seed → the mint path must merge
    // the new seed onto the existing block (not clobber it).
    const harness = makeConfigHarness({ a2a: { identity: { label: "primary" } } } as RuntimeCredentialConfig)

    const identity = await loadOrMintA2AIdentity({
      agentName: "mint-merge",
      sodium,
      config: harness.read(),
      upsert: harness.upsert,
    })
    expect(identity.did.startsWith("did:key:z")).toBe(true)
    expect(harness.upsertCalls).toBe(1)

    // The seed was added AND the pre-existing identity-block key survived.
    const after = harness.read()
    const a2a = after.a2a as { identity?: Record<string, unknown> } | undefined
    expect(a2a?.identity?.ed25519Seed).toBeDefined()
    expect(a2a?.identity?.label).toBe("primary")
  })

  it("loads the existing identity from a stored seed WITHOUT re-minting (no upsert)", async () => {
    const harness = makeConfigHarness()
    // First mint to populate the seed.
    const first = await loadOrMintA2AIdentity({
      agentName: "load-existing",
      sodium,
      config: harness.read(),
      upsert: harness.upsert,
    })
    const callsAfterMint = harness.upsertCalls

    // Second load over the SAME config: same DID, no extra upsert.
    const second = await loadOrMintA2AIdentity({
      agentName: "load-existing",
      sodium,
      config: harness.read(),
      upsert: harness.upsert,
    })

    expect(second.did).toBe(first.did)
    expect(Buffer.from(second.ed25519Priv).equals(Buffer.from(first.ed25519Priv))).toBe(true)
    // Load path performs NO persist.
    expect(harness.upsertCalls).toBe(callsAfterMint)
  })

  it("derives a stable DID across reloads of the same seed (deterministic)", async () => {
    const harness = makeConfigHarness()
    const minted = await loadOrMintA2AIdentity({
      agentName: "stable-did",
      sodium,
      config: harness.read(),
      upsert: harness.upsert,
    })
    // Fresh config object carrying ONLY the persisted seed (simulating a reload
    // from a different process that loaded the same machine-local item).
    const reloadConfig = harness.read()
    const reloaded = await loadOrMintA2AIdentity({
      agentName: "stable-did",
      sodium,
      config: reloadConfig,
      upsert: async () => {
        throw new Error("must not re-mint when a seed is present")
      },
    })
    expect(reloaded.did).toBe(minted.did)
  })

  it("treats an empty/missing machine config as a mint trigger", async () => {
    const harness = makeConfigHarness({})
    expect(readStoredA2ASeed(harness.read())).toBeUndefined()
    const identity = await loadOrMintA2AIdentity({
      agentName: "empty-config",
      sodium,
      config: harness.read(),
      upsert: harness.upsert,
    })
    expect(identity.did.startsWith("did:key:z")).toBe(true)
    expect(harness.upsertCalls).toBe(1)
  })

  it("fails fast on a malformed stored seed (never silently re-mints, which would change the DID)", async () => {
    const harness = makeConfigHarness({
      a2a: { identity: { ed25519Seed: "!!!-not-base64url-and-wrong-length-@@@" } },
    })
    await expect(
      loadOrMintA2AIdentity({
        agentName: "malformed-seed",
        sodium,
        config: harness.read(),
        upsert: async () => {
          throw new Error("must not upsert/re-mint on a malformed seed")
        },
      }),
    ).rejects.toThrow(/malformed/i)
  })

  it("fails fast on a stored seed of the wrong byte length", async () => {
    // Valid base64url but only 8 bytes (an Ed25519 seed must be 32).
    const tooShort = Buffer.from(new Uint8Array(8)).toString("base64url")
    const harness = makeConfigHarness({
      a2a: { identity: { ed25519Seed: tooShort } },
    })
    await expect(
      loadOrMintA2AIdentity({
        agentName: "short-seed",
        sodium,
        config: harness.read(),
        upsert: vi.fn(),
      }),
    ).rejects.toThrow(/malformed|seed/i)
  })

  it("preserves unrelated machine-config keys when persisting a freshly-minted seed", async () => {
    const harness = makeConfigHarness({ a2a: { publicUrl: "https://agent.example" } })
    await loadOrMintA2AIdentity({
      agentName: "preserve-keys",
      sodium,
      config: harness.read(),
      upsert: harness.upsert,
    })
    const persisted = harness.read()
    const a2a = persisted.a2a as Record<string, unknown>
    // The pre-existing key survives the seed write.
    expect(a2a.publicUrl).toBe("https://agent.example")
    expect((a2a.identity as Record<string, unknown>).ed25519Seed).toBeDefined()
  })
})
