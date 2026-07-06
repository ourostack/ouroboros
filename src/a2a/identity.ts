import * as crypto from "node:crypto"
import * as os from "node:os"
import { didKeyIdentityFromEd25519, ready, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { emitNervesEvent } from "../nerves/runtime"
import {
  mergeMachineRuntimeCredentialConfig,
  readMachineRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  type RuntimeCredentialConfig,
} from "../heart/runtime-credentials"
import { loadOrCreateMachineIdentity } from "../heart/machine-identity"

/**
 * The agent's self A2A cryptographic identity: a did:key over an Ed25519 seed.
 *
 * The 32-byte seed is the durable secret (stored in the machine-local vault item
 * under `a2a.identity.ed25519Seed`). Everything else here is derived
 * deterministically from that seed via libsodium, so a reload reproduces the same
 * DID. The harness never persists raw key material beyond the seed.
 */
export interface A2AIdentity extends DidKeyIdentity {
  /** The base64url-encoded 32-byte Ed25519 seed this identity was derived from. */
  seed: string
}

/** The number of raw bytes in an Ed25519 seed. */
const ED25519_SEED_BYTES = 32

/** The machine-config key path for the persisted seed: `a2a.identity.ed25519Seed`. */
function a2aIdentityConfig(config: RuntimeCredentialConfig): Record<string, unknown> | undefined {
  const a2a = config.a2a
  if (!a2a || typeof a2a !== "object" || Array.isArray(a2a)) return undefined
  const identity = (a2a as { identity?: unknown }).identity
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined
  return identity as Record<string, unknown>
}

/** Read the stored Ed25519 seed string from a machine-config object, or undefined. */
export function readStoredA2ASeed(config: RuntimeCredentialConfig): string | undefined {
  const identity = a2aIdentityConfig(config)
  const seed = identity?.ed25519Seed
  return typeof seed === "string" && seed.length > 0 ? seed : undefined
}

/** Decode + validate a stored seed string into 32 raw bytes. Throws on malformed. */
function decodeSeed(seedString: string): Uint8Array {
  let decoded: Buffer
  try {
    decoded = Buffer.from(seedString, "base64url")
  } catch {
    /* v8 ignore next -- Buffer.from(base64url) does not throw on bad chars; this guards future decoders @preserve */
    throw new Error("malformed A2A identity seed: not decodable")
  }
  // base64url is lenient (it silently drops invalid chars), so the length check is
  // the real gate: a real Ed25519 seed is exactly 32 bytes.
  if (decoded.length !== ED25519_SEED_BYTES) {
    throw new Error(`malformed A2A identity seed: expected ${ED25519_SEED_BYTES}-byte seed, got ${decoded.length}`)
  }
  return new Uint8Array(decoded)
}

/** Mint a fresh 32-byte Ed25519 seed (Node keygen → JWK `d`, the raw seed). */
function mintSeed(): Uint8Array {
  const { privateKey } = crypto.generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" })
  /* v8 ignore next -- Node always emits the `d` field for an Ed25519 private JWK; guard protects future runtimes @preserve */
  if (typeof jwk.d !== "string") throw new Error("failed to mint A2A identity seed: missing JWK d")
  return decodeSeed(jwk.d)
}

/** Derive the full did:key identity from a 32-byte seed (deterministic). */
function deriveIdentity(sodium: Sodium, seed: Uint8Array): A2AIdentity {
  const keypair = sodium.crypto_sign_seed_keypair(seed)
  const didIdentity = didKeyIdentityFromEd25519({
    sodium,
    ed25519Pub: keypair.publicKey,
    ed25519Priv: keypair.privateKey,
  })
  return { ...didIdentity, seed: Buffer.from(seed).toString("base64url") }
}

export interface LoadOrMintA2AIdentityInput {
  agentName: string
  sodium: Sodium
  /** The machine-local runtime config object (carries `a2a.identity.ed25519Seed`). */
  config: RuntimeCredentialConfig
  /** Persist the merged machine config when a fresh seed is minted. */
  upsert: (config: RuntimeCredentialConfig) => Promise<void>
}

/**
 * Load the agent's A2A identity from the machine-local config, or mint + persist
 * one on first use. A malformed stored seed FAILS FAST (it never silently
 * re-mints, which would change the agent's DID). The mint path persists the new
 * seed via `upsert` before deriving; the load path performs no writes.
 */
export async function loadOrMintA2AIdentity(input: LoadOrMintA2AIdentityInput): Promise<A2AIdentity> {
  const stored = readStoredA2ASeed(input.config)
  if (stored) {
    // Load path: a malformed seed throws (no re-mint).
    const seed = decodeSeed(stored)
    const identity = deriveIdentity(input.sodium, seed)
    emitNervesEvent({
      component: "channels",
      event: "channel.a2a_identity_loaded",
      message: "loaded A2A identity from machine config",
      meta: { agentName: input.agentName, did: identity.did },
    })
    return identity
  }

  // Mint path: generate a seed, persist it under a2a.identity.*, then derive.
  const seed = mintSeed()
  const seedString = Buffer.from(seed).toString("base64url")
  const a2a = (input.config.a2a && typeof input.config.a2a === "object" && !Array.isArray(input.config.a2a)
    ? input.config.a2a
    : {}) as Record<string, unknown>
  const identityBlock = (a2a.identity && typeof a2a.identity === "object" && !Array.isArray(a2a.identity)
    ? a2a.identity
    : {}) as Record<string, unknown>
  const nextConfig: RuntimeCredentialConfig = {
    ...input.config,
    a2a: { ...a2a, identity: { ...identityBlock, ed25519Seed: seedString } },
  }
  await input.upsert(nextConfig)
  const identity = deriveIdentity(input.sodium, seed)
  emitNervesEvent({
    component: "channels",
    event: "channel.a2a_identity_minted",
    message: "minted new A2A identity and persisted seed to machine config",
    meta: { agentName: input.agentName, did: identity.did },
  })
  return identity
}

/**
 * Load (or mint-on-first-use) THIS agent's own A2A identity from the machine-local
 * runtime config — the convenience entry the main-process tools use to obtain the
 * self identity that signs outbound sealed envelopes. Mirrors the a2a sense
 * entrypoint's load (use a cached seed when present, otherwise refresh machine
 * config → `loadOrMintA2AIdentity` → merge a fresh seed under the right machine
 * id). `sodium` is optional (defaults to `ready()`).
 */
export async function loadSelfA2AIdentity(input: { agentName: string; sodium?: Sodium }): Promise<A2AIdentity> {
  const sodium = input.sodium ?? await ready()
  const machineId = loadOrCreateMachineIdentity({ homeDir: os.homedir() }).machineId
  const cached = readMachineRuntimeCredentialConfig(input.agentName)
  const read = cached.ok && readStoredA2ASeed(cached.config)
    ? cached
    : await refreshMachineRuntimeCredentialConfig(input.agentName, machineId)
  if (!read.ok && read.reason !== "missing") {
    throw new Error(`A2A identity requires readable machine runtime config at ${read.itemPath}: ${read.error}`)
  }
  const config = read.ok ? read.config : {}
  return loadOrMintA2AIdentity({
    agentName: input.agentName,
    sodium,
    config,
    upsert: async (next) => {
      const seed = readStoredA2ASeed(next) as string
      await mergeMachineRuntimeCredentialConfig(input.agentName, machineId, { a2a: { identity: { ed25519Seed: seed } } })
    },
  })
}
