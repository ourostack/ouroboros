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
let afterRawSecretRead: ((name: string) => void) | null = null
const mockStore = {
  getRawSecret: async (name: string, field: string) => {
    if (field !== "password") throw new Error(`unexpected field ${field}`)
    const item = memory.get(name)
    if (!item) throw new Error(`no credential found for domain "${name}"`)
    afterRawSecretRead?.(name)
    return item.password
  },
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
  afterRawSecretRead = null
})

afterEach(() => {
  afterRawSecretRead = null
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

  it("preserves sibling machine-local sense config when minting from an empty process cache", async () => {
    memory.set("runtime/machines/machine_test/config", {
      username: "runtime/machines/machine_test/config",
      password: JSON.stringify({
        schemaVersion: 1,
        kind: "runtime-config",
        updatedAt: "2026-07-06T20:00:00.000Z",
        config: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "bb-password",
          },
          bluebubblesChannel: {
            port: 18790,
            webhookPath: "/bluebubbles-webhook",
          },
          voice: {
            whisperCliPath: "/opt/whisper.cpp/main",
            whisperModelPath: "/models/ggml-base.en.bin",
          },
        },
      }),
    })

    const { loadSelfA2AIdentity } = await import("../../a2a/identity")
    const identity = await loadSelfA2AIdentity({ agentName: "self-preserve-siblings", sodium })

    const raw = memory.get("runtime/machines/machine_test/config")?.password
    expect(raw).toBeDefined()
    const stored = JSON.parse(raw ?? "{}") as { config?: Record<string, unknown> }
    expect(stored.config).toMatchObject({
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "bb-password",
      },
      bluebubblesChannel: {
        port: 18790,
        webhookPath: "/bluebubbles-webhook",
      },
      voice: {
        whisperCliPath: "/opt/whisper.cpp/main",
        whisperModelPath: "/models/ggml-base.en.bin",
      },
      a2a: {
        identity: {
          ed25519Seed: identity.seed,
        },
      },
    })
  })

  it("does not overwrite sibling config changed between A2A refresh and seed merge", async () => {
    let readCount = 0
    memory.set("runtime/machines/machine_test/config", {
      username: "runtime/machines/machine_test/config",
      password: JSON.stringify({
        schemaVersion: 1,
        kind: "runtime-config",
        updatedAt: "2026-07-06T20:00:00.000Z",
        config: {
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "bb-password",
          },
          voice: {
            whisperCliPath: "/old/whisper",
            whisperModelPath: "/old/model.bin",
          },
        },
      }),
    })
    afterRawSecretRead = (name) => {
      if (name !== "runtime/machines/machine_test/config") return
      readCount += 1
      if (readCount !== 1) return
      memory.set(name, {
        username: name,
        password: JSON.stringify({
          schemaVersion: 1,
          kind: "runtime-config",
          updatedAt: "2026-07-06T20:01:00.000Z",
          config: {
            bluebubbles: {
              serverUrl: "http://localhost:1234",
              password: "bb-password",
            },
            voice: {
              whisperCliPath: "/new/whisper",
              whisperModelPath: "/new/model.bin",
            },
          },
        }),
      })
    }

    const { loadSelfA2AIdentity } = await import("../../a2a/identity")
    const identity = await loadSelfA2AIdentity({ agentName: "self-concurrent-sibling", sodium })

    const raw = memory.get("runtime/machines/machine_test/config")?.password
    const stored = JSON.parse(raw ?? "{}") as { config?: Record<string, unknown> }
    expect(stored.config).toMatchObject({
      bluebubbles: {
        serverUrl: "http://localhost:1234",
        password: "bb-password",
      },
      voice: {
        whisperCliPath: "/new/whisper",
        whisperModelPath: "/new/model.bin",
      },
      a2a: {
        identity: {
          ed25519Seed: identity.seed,
        },
      },
    })
  })

  it("fails before minting when the machine runtime item is unreadable", async () => {
    memory.set("runtime/machines/machine_test/config", {
      username: "runtime/machines/machine_test/config",
      password: JSON.stringify({
        schemaVersion: 1,
        kind: "wrong",
        updatedAt: "2026-07-06T20:00:00.000Z",
        config: {
          bluebubbles: {
            password: "must-not-be-replaced",
          },
        },
      }),
    })

    const { loadSelfA2AIdentity } = await import("../../a2a/identity")
    await expect(loadSelfA2AIdentity({ agentName: "self-invalid-machine-config", sodium }))
      .rejects.toThrow(/A2A identity requires readable machine runtime config/)

    const raw = memory.get("runtime/machines/machine_test/config")?.password
    expect(raw).toContain('"kind":"wrong"')
    expect(raw).toContain("must-not-be-replaced")
  })
})
