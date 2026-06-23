import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ready, parseDidKey, type Sodium } from "@ouro.bot/friends/a2a-client"

/**
 * Hermetic coverage for the `loadSelfA2AIdentity` WRAPPER (the glue over the
 * already-tested `loadOrMintA2AIdentity`): the real machine-id read, the
 * machine-config read + `read.ok` fallback, and the upsert callback (mint path).
 *
 * `getCredentialStore` is mocked with an in-memory store so the mint path's
 * `upsertMachineRuntimeCredentialConfig` persists into memory (no real vault), and
 * `loadOrCreateMachineIdentity` is mocked to a deterministic machine id (no real
 * `~/.ouro-cli` write). Mirrors the runtime-credentials test pattern.
 */
const memory = new Map<string, { username: string; password: string; notes?: string }>()
const mockStore = {
  store: async (name: string, item: { username: string; password: string; notes?: string }) => { memory.set(name, item) },
  retrieve: async (name: string) => memory.get(name) ?? null,
  delete: async (name: string) => { memory.delete(name) },
  list: async () => [...memory.keys()],
}

vi.mock("../../repertoire/credential-access", () => ({
  getCredentialStore: () => mockStore,
  resetCredentialStore: () => {},
}))

vi.mock("../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: () => ({ machineId: "machine_test", createdAt: "now" }),
}))

let sodium: Sodium

beforeAll(async () => { sodium = await ready() })

beforeEach(() => {
  memory.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("loadSelfA2AIdentity (wrapper glue over loadOrMintA2AIdentity)", () => {
  it("mints + persists a self identity when no machine config seed exists, then reloads the SAME did", async () => {
    const { loadSelfA2AIdentity } = await import("../../a2a/identity")
    // First call: no config → read.ok fallback → mint → upsert callback persists the seed.
    const first = await loadSelfA2AIdentity({ agentName: "self-mint", sodium })
    expect(first.did.startsWith("did:key:z")).toBe(true)
    expect(parseDidKey(first.did)).not.toBeNull()

    // Second call: the persisted seed is read back → the SAME did (stable, no re-mint).
    const second = await loadSelfA2AIdentity({ agentName: "self-mint", sodium })
    expect(second.did).toBe(first.did)
  })

  it("defaults sodium via ready() when not provided", async () => {
    const { loadSelfA2AIdentity } = await import("../../a2a/identity")
    const id = await loadSelfA2AIdentity({ agentName: "self-default-sodium" })
    expect(id.did.startsWith("did:key:z")).toBe(true)
  })
})
