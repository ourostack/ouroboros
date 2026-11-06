import { beforeEach, describe, expect, it, vi } from "vitest"

const vault = vi.hoisted(() => {
  const items = new Map<string, string>()
  let failRead = false
  return {
    items,
    failNextRead() { failRead = true },
    store: {
      get: vi.fn(async (domain: string) => items.has(domain) ? { domain, createdAt: "2026-11-06T00:00:00.000Z" } : null),
      getRawSecret: vi.fn(async (domain: string) => {
        if (failRead) {
          failRead = false
          throw new Error("vault locked")
        }
        const value = items.get(domain)
        if (value === undefined) throw new Error(`no credential found for domain "${domain}"`)
        return value
      }),
      store: vi.fn(async (domain: string, data: { password: string }) => { items.set(domain, data.password) }),
      list: vi.fn(async () => []),
      delete: vi.fn(async (domain: string) => items.delete(domain)),
      isReady: vi.fn(() => true),
    },
  }
})
vi.mock("../../repertoire/credential-access", () => ({ getCredentialStore: vi.fn(() => vault.store) }))

import { relayConfigFrom, vaultRelayConfigStore } from "../../a2a/relay-config-vault"
import { resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"

const ITEM = "runtime/machines/m1/config"
const registration = { relayUrl: "https://relay.example", handle: "h1", inboxAuth: "ia", sendCredential: "sc" }
const stored = (config: unknown) => JSON.parse(vault.items.get(ITEM)!).config as Record<string, unknown> & typeof config

beforeEach(() => {
  vault.items.clear()
  resetRuntimeCredentialConfigCache()
})

describe("relay settings in the vault", () => {
  it("reads nothing before any machine config exists", async () => {
    expect(await vaultRelayConfigStore("agent", "m1").read()).toEqual({})
  })

  it("merges a patch into a2a.relay beside the identity seed, and removes a key set to undefined", async () => {
    vault.items.set(ITEM, JSON.stringify({ schemaVersion: 1, kind: "runtime-config", updatedAt: "2026-11-06T00:00:00.000Z", config: { a2a: { identity: { ed25519Seed: "seed" }, relay: { url: "https://relay.example", inviteToken: "inv-1" } } } }))
    const config = vaultRelayConfigStore("agent", "m1")
    await config.write({ pendingRegistration: { relayUrl: "https://relay.example", handle: "h1" } })
    await config.write({ registration, pendingRegistration: undefined, inviteToken: undefined })
    expect(stored({})).toEqual({ a2a: { identity: { ed25519Seed: "seed" }, relay: { url: "https://relay.example", registration } } })
    expect(await config.read()).toEqual({ url: "https://relay.example", registration })
  })

  it("surfaces a vault that cannot be read instead of treating it as no relay", async () => {
    vault.items.set(ITEM, JSON.stringify({ schemaVersion: 1, kind: "runtime-config", updatedAt: "2026-11-06T00:00:00.000Z", config: {} }))
    vault.failNextRead()
    await expect(vaultRelayConfigStore("agent", "m1").read()).rejects.toThrow(/cannot read the A2A relay settings/)
  })

  it("keeps only well-formed relay fields", () => {
    expect(relayConfigFrom({})).toEqual({})
    expect(relayConfigFrom({ a2a: { relay: [] } })).toEqual({})
    expect(relayConfigFrom({ a2a: { relay: {
      url: "", inviteToken: 7, registration: { ...registration, inboxAuth: "" },
      pendingRegistration: { relayUrl: "https://relay.example" }, previousRegistration: null,
    } } })).toEqual({})
    expect(relayConfigFrom({ a2a: { relay: { inviteToken: "inv", pendingRegistration: { relayUrl: "https://r", handle: "h" }, previousRegistration: registration } } }))
      .toEqual({ inviteToken: "inv", pendingRegistration: { relayUrl: "https://r", handle: "h" }, previousRegistration: registration })
  })
})
