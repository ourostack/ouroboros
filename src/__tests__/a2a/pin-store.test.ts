import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  ready,
  base58btcEncode,
  type PinnedDid,
  type Sodium,
} from "@ouro.bot/friends/a2a-client"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { FileA2APinStore } from "../../a2a/pin-store"

let sodium: Sodium
let tmp: TmpBundleHandle | null = null

beforeAll(async () => {
  sodium = await ready()
})

afterEach(() => {
  tmp?.cleanup()
  tmp = null
})

function makePinned(did: string): PinnedDid {
  // A deterministic 32-byte key derived from the did (test fixture, not real crypto).
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) bytes[i] = did.charCodeAt(i % did.length) & 0xff
  return { did, ed25519Pub: bytes }
}

/**
 * The harness OWNS the pin storage (the resolution): a durable file home under
 * `state/a2a/pins`, keyed `did → pinnedKey`, mirroring the `FileA2ATaskStore`
 * `state/a2a/tasks` precedent. Pins do NOT live on `AgentMeta.identity.pinnedKey`
 * (friends alpha.7's `FileFriendStore` silently drops `AgentMeta.identity` — a
 * latent library gap logged as a separate follow-up, NOT this store's concern).
 */
describe("durable a2a PinStore (harness-owned, backed by state/a2a/pins)", () => {
  it("reads back a pin it just set (first-contact set → get)", () => {
    tmp = createTmpBundle({ agentName: "pin-set-get" })
    const pinStore = new FileA2APinStore(tmp.agentRoot)

    const did = "did:key:zPinSetGetAAAAAAAAAAAAAAAAAAAAAAAAA"
    expect(pinStore.get(did)).toBeUndefined()
    const pinned = makePinned(did)
    pinStore.set(did, pinned)

    const read = pinStore.get(did)
    expect(read?.did).toBe(did)
    expect(Buffer.from(read!.ed25519Pub).equals(Buffer.from(pinned.ed25519Pub))).toBe(true)
  })

  it("persists the pin durably under state/a2a/pins (the harness-owned home)", () => {
    tmp = createTmpBundle({ agentName: "pin-home" })
    const pinStore = new FileA2APinStore(tmp.agentRoot)
    const did = "did:key:zPinHomeFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
    const pinned = makePinned(did)
    pinStore.set(did, pinned)

    const pinsDir = path.join(tmp.agentRoot, "state", "a2a", "pins")
    expect(fs.existsSync(pinsDir)).toBe(true)
    // Exactly one persisted pin file, carrying the did + the base58btc-encoded key.
    const files = fs.readdirSync(pinsDir)
    expect(files.length).toBe(1)
    const stored = JSON.parse(fs.readFileSync(path.join(pinsDir, files[0]!), "utf-8")) as {
      did: string
      pinnedKey: string
    }
    expect(stored.did).toBe(did)
    expect(stored.pinnedKey).toBe(base58btcEncode(pinned.ed25519Pub))
  })

  it("survives a simulated restart (new store instance over the same agent root)", () => {
    tmp = createTmpBundle({ agentName: "pin-restart" })
    const did = "did:key:zPinRestartBBBBBBBBBBBBBBBBBBBBBBBBB"
    const pinned = makePinned(did)

    {
      const pinStore = new FileA2APinStore(tmp.agentRoot)
      pinStore.set(did, pinned)
    }

    // Simulated restart: a brand-new store over the same agent root reloads the pin.
    const reloaded = new FileA2APinStore(tmp.agentRoot)
    const read = reloaded.get(did)
    expect(read?.did).toBe(did)
    expect(Buffer.from(read!.ed25519Pub).equals(Buffer.from(pinned.ed25519Pub))).toBe(true)
  })

  it("returns undefined for an unknown agentId", () => {
    tmp = createTmpBundle({ agentName: "pin-unknown" })
    const pinStore = new FileA2APinStore(tmp.agentRoot)
    expect(pinStore.get("did:key:zNeverPinnedDDDDDDDDDDDDDDDDDDDDDDDD")).toBeUndefined()
  })

  it("never treats an empty-string DID as a matchable key (get + set are inert)", () => {
    tmp = createTmpBundle({ agentName: "pin-empty" })
    const pinStore = new FileA2APinStore(tmp.agentRoot)
    expect(pinStore.get("")).toBeUndefined()
    // set on an empty DID must not crash and must not become a readable pin.
    pinStore.set("", makePinned("placeholder"))
    expect(pinStore.get("")).toBeUndefined()
    // No file was written for the empty key.
    const pinsDir = path.join(tmp.agentRoot, "state", "a2a", "pins")
    expect(fs.readdirSync(pinsDir).length).toBe(0)
  })

  it("re-pins idempotently to the same key (set twice → one file, same read-back)", () => {
    tmp = createTmpBundle({ agentName: "pin-idempotent" })
    const did = "did:key:zPinIdempotentEEEEEEEEEEEEEEEEEEEEEEE"
    const pinStore = new FileA2APinStore(tmp.agentRoot)
    const pinned = makePinned(did)
    pinStore.set(did, pinned)
    pinStore.set(did, pinned)
    expect(Buffer.from(pinStore.get(did)!.ed25519Pub).equals(Buffer.from(pinned.ed25519Pub))).toBe(true)
    const pinsDir = path.join(tmp.agentRoot, "state", "a2a", "pins")
    expect(fs.readdirSync(pinsDir).length).toBe(1)
  })

  it("overwrites the stored key on a rotation set (new key wins, still one file)", () => {
    tmp = createTmpBundle({ agentName: "pin-rotate" })
    const did = "did:key:zPinRotateGGGGGGGGGGGGGGGGGGGGGGGGGG"
    const pinStore = new FileA2APinStore(tmp.agentRoot)
    pinStore.set(did, makePinned(did))

    const rotated: PinnedDid = { did, ed25519Pub: new Uint8Array(32).fill(7) }
    pinStore.set(did, rotated)

    const read = pinStore.get(did)
    expect(Buffer.from(read!.ed25519Pub).equals(Buffer.from(rotated.ed25519Pub))).toBe(true)
    // And the rotation persists across restart.
    const reloaded = new FileA2APinStore(tmp.agentRoot)
    expect(Buffer.from(reloaded.get(did)!.ed25519Pub).equals(Buffer.from(rotated.ed25519Pub))).toBe(true)
    expect(fs.readdirSync(path.join(tmp.agentRoot, "state", "a2a", "pins")).length).toBe(1)
  })

  it("treats a malformed/corrupt pin file as absent (does not crash on load)", () => {
    tmp = createTmpBundle({ agentName: "pin-corrupt" })
    // Seed a corrupt file into the pins dir, then construct the store.
    const pinsDir = path.join(tmp.agentRoot, "state", "a2a", "pins")
    fs.mkdirSync(pinsDir, { recursive: true })
    fs.writeFileSync(path.join(pinsDir, "garbage.json"), "{ not valid json", "utf-8")
    const did = "did:key:zPinCorruptHHHHHHHHHHHHHHHHHHHHHHHHH"

    const pinStore = new FileA2APinStore(tmp.agentRoot)
    // The corrupt file is ignored; a fresh set/get still works.
    expect(pinStore.get(did)).toBeUndefined()
    const pinned = makePinned(did)
    pinStore.set(did, pinned)
    expect(Buffer.from(pinStore.get(did)!.ed25519Pub).equals(Buffer.from(pinned.ed25519Pub))).toBe(true)
  })

  it("ignores a pin file whose stored key is not decodable base58btc", () => {
    tmp = createTmpBundle({ agentName: "pin-baddecode" })
    const pinsDir = path.join(tmp.agentRoot, "state", "a2a", "pins")
    fs.mkdirSync(pinsDir, { recursive: true })
    const did = "did:key:zPinBadDecodeIIIIIIIIIIIIIIIIIIIIIIII"
    // Valid JSON shape but a pinnedKey that base58btcDecode rejects.
    fs.writeFileSync(
      path.join(pinsDir, "bad.json"),
      JSON.stringify({ did, pinnedKey: "0OIl-not-base58" }),
      "utf-8",
    )

    const pinStore = new FileA2APinStore(tmp.agentRoot)
    expect(pinStore.get(did)).toBeUndefined()
  })
})
