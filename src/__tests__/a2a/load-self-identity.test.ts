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

describe("readOwnA2ADid is read-only", () => {
  it("returns the DID from the cached machine config, null when nothing is cached, and null for a malformed seed, without touching the vault or the machine identity", async () => {
    const credentials = await import("../../heart/runtime-credentials")
    const { readOwnA2ADid } = await import("../../a2a/identity")
    credentials.resetRuntimeCredentialConfigCache()
    expect(await readOwnA2ADid("readonly-agent")).toBeNull()
    credentials.cacheMachineRuntimeCredentialConfig("readonly-agent", { a2a: { identity: { ed25519Seed: Buffer.alloc(32, 7).toString("base64url") } } })
    const did = await readOwnA2ADid("readonly-agent")
    expect(did).toMatch(/^did:key:/)
    expect(await readOwnA2ADid("readonly-agent")).toBe(did)
    credentials.cacheMachineRuntimeCredentialConfig("readonly-agent", { a2a: { identity: { ed25519Seed: "short" } } })
    expect(await readOwnA2ADid("readonly-agent")).toBeNull()
    credentials.resetRuntimeCredentialConfigCache()
  })
})

describe("readOwnA2ADid falls back to the DID published in the bundle", () => {
  it("reads the public identity file when no seed is cached, never mints, and ignores a missing, malformed or non-did value", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const credentials = await import("../../heart/runtime-credentials")
    const { readOwnA2ADid, publishOwnA2ADid, readPublishedA2ADid, PUBLIC_A2A_IDENTITY_FILE } = await import("../../a2a/identity")
    credentials.resetRuntimeCredentialConfigCache()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-did-"))
    try {
      expect(await readOwnA2ADid("published-agent", root)).toBeNull()
      publishOwnA2ADid(root, "did:key:z6MkPublished")
      expect(JSON.parse(fs.readFileSync(path.join(root, PUBLIC_A2A_IDENTITY_FILE), "utf8"))).toEqual({ did: "did:key:z6MkPublished" })
      expect(await readOwnA2ADid("published-agent", root)).toBe("did:key:z6MkPublished")
      const before = fs.statSync(path.join(root, PUBLIC_A2A_IDENTITY_FILE)).mtimeMs
      publishOwnA2ADid(root, "did:key:z6MkPublished")
      expect(fs.statSync(path.join(root, PUBLIC_A2A_IDENTITY_FILE)).mtimeMs).toBe(before)
      // a cached seed wins over the published file
      credentials.cacheMachineRuntimeCredentialConfig("published-agent", { a2a: { identity: { ed25519Seed: Buffer.alloc(32, 9).toString("base64url") } } })
      expect(await readOwnA2ADid("published-agent", root)).not.toBe("did:key:z6MkPublished")
      credentials.resetRuntimeCredentialConfigCache()
      fs.writeFileSync(path.join(root, PUBLIC_A2A_IDENTITY_FILE), JSON.stringify({ did: "not-a-did" }))
      expect(readPublishedA2ADid(root)).toBeNull()
      fs.writeFileSync(path.join(root, PUBLIC_A2A_IDENTITY_FILE), "{broken")
      expect(readPublishedA2ADid(root)).toBeNull()
      // a read-only bundle: publishing is a silent no-op
      const blocked = path.join(root, "blocked")
      fs.writeFileSync(blocked, "file, not a directory")
      expect(() => publishOwnA2ADid(blocked, "did:key:z6MkX")).not.toThrow()
      // the default root comes from the agent name
      expect(await readOwnA2ADid("no-such-published-agent")).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
