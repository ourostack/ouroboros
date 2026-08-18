// "Both ways" gate: prove the harness runs the REAL friend flow THROUGH the
// extracted `@ouro.bot/friends` dependency — not an in-tree copy.
//
// Every symbol here is imported from the published package barrel. The package
// resolves out of `node_modules/@ouro.bot/friends` (a git dependency built on
// install via its `prepare` script), so a green run here is direct evidence the
// harness is wired to the package rather than `src/mind/friends/` (which is
// deleted). The flow exercises:
//   - FriendResolver + FileFriendStore resolving/creating a friend on disk
//   - the trust ladder via isTrustedLevel + describeTrustContext
//   - token accumulation via accumulateFriendTokens
//   - the observability seam: setNervesEmitter forwarding the package's
//     emitNervesEvent into the harness's real nerves runtime emitter.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  FriendResolver,
  FileFriendStore,
  accumulateFriendTokens,
  describeTrustContext,
  isTrustedLevel,
  isIdentityProvider,
  getAlwaysOnSenseNames,
  getChannelCapabilities,
  setNervesEmitter,
  _setMachineOwnerUsernameForTest,
  type FriendRecord,
} from "@ouro.bot/friends"

import { emitNervesEvent } from "../../nerves/runtime"

describe("friend flow through the @ouro.bot/friends dependency", () => {
  let friendsDir: string
  let store: FileFriendStore

  beforeEach(() => {
    // Wire the package's observability seam to the harness's real nerves emitter,
    // exactly as the daemon does at startup. Package events now flow into harness
    // nerves (and are observed by the global capture heartbeat).
    setNervesEmitter(emitNervesEvent)
    // Deterministic machine-owner so the second (non-owner) identity resolves as a
    // stranger rather than family.
    _setMachineOwnerUsernameForTest("integration-owner")
    friendsDir = mkdtempSync(join(tmpdir(), "ouro-friends-pkg-"))
    store = new FileFriendStore(friendsDir)
  })

  afterEach(() => {
    _setMachineOwnerUsernameForTest(undefined)
    setNervesEmitter(null)
    rmSync(friendsDir, { recursive: true, force: true })
  })

  it("consumes the exact released Telegram-capable Friends package", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "node_modules", "@ouro.bot", "friends", "package.json"), "utf8"),
    ) as { version: string }

    expect(packageJson.version).toBe("0.1.0-alpha.8")
    expect(getChannelCapabilities("telegram")).toMatchObject({
      channel: "telegram",
      senseType: "open",
      supportsHtml: true,
      chatStyle: true,
      supportsStreaming: false,
      maxMessageLength: 4096,
    })
    expect(getAlwaysOnSenseNames()).toContain("telegram")
    expect(isIdentityProvider("telegram-user")).toBe(true)
  })

  it("resolves a first-imprint friend as trusted and persists it to disk", async () => {
    // First identity to ever resolve against an empty store: the package imprints
    // it as the primary/family relationship — the top of the trust ladder.
    const resolver = new FriendResolver(store, {
      provider: "aad",
      externalId: "owner-aad-object-id",
      tenantId: "tenant-abc",
      displayName: "Primary Owner",
      channel: "teams",
    })

    const { friend, channel } = await resolver.resolve()

    expect(friend.trustLevel).toBe("family")
    expect(friend.name).toBe("Primary Owner")
    expect(channel.channel).toBe("teams")

    // Trust gating runs through the package's helpers.
    expect(isTrustedLevel(friend.trustLevel)).toBe(true)
    const explanation = describeTrustContext({ friend, channel: channel.channel })
    expect(explanation.level).toBe("family")
    expect(explanation.basis).toBe("direct")

    // The store is the real FileFriendStore — the friend is on disk and re-readable.
    const onDisk = readdirSync(friendsDir).filter((f) => f.endsWith(".json"))
    expect(onDisk).toHaveLength(1)
    const persisted = JSON.parse(readFileSync(join(friendsDir, onDisk[0]), "utf8")) as FriendRecord
    expect(persisted.id).toBe(friend.id)
    expect(persisted.externalIds[0].externalId).toBe("owner-aad-object-id")

    // Resolving the same identity again returns the SAME persisted friend (no dup).
    const again = await new FriendResolver(store, {
      provider: "aad",
      externalId: "owner-aad-object-id",
      tenantId: "tenant-abc",
      displayName: "Primary Owner",
      channel: "teams",
    }).resolve()
    expect(again.friend.id).toBe(friend.id)
    expect(readdirSync(friendsDir).filter((f) => f.endsWith(".json"))).toHaveLength(1)
  })

  it("resolves a later non-owner identity as an untrusted stranger", async () => {
    // Imprint the owner first so the store is non-empty.
    await new FriendResolver(store, {
      provider: "local",
      externalId: "integration-owner",
      displayName: "Owner",
      channel: "mcp",
    }).resolve()

    // A different AAD identity arriving afterward is a stranger — the trust ladder
    // discriminates, gating it out of trusted-only behavior.
    const { friend } = await new FriendResolver(store, {
      provider: "aad",
      externalId: "some-other-person",
      tenantId: "tenant-xyz",
      displayName: "Random Person",
      channel: "teams",
    }).resolve()

    expect(friend.trustLevel).toBe("stranger")
    expect(isTrustedLevel(friend.trustLevel)).toBe(false)
    const explanation = describeTrustContext({ friend, channel: "teams" })
    expect(explanation.level).toBe("stranger")
  })

  it("accumulates output tokens onto the resolved friend through the package helper", async () => {
    const { friend } = await new FriendResolver(store, {
      provider: "aad",
      externalId: "token-user",
      tenantId: "tenant-abc",
      displayName: "Token User",
      channel: "teams",
    }).resolve()
    expect(friend.totalTokens).toBe(0)

    await accumulateFriendTokens(store, friend.id, {
      input_tokens: 1000,
      output_tokens: 42,
      reasoning_tokens: 0,
      total_tokens: 1042,
    })
    await accumulateFriendTokens(store, friend.id, {
      input_tokens: 500,
      output_tokens: 8,
      reasoning_tokens: 0,
      total_tokens: 508,
    })

    // Only output tokens accumulate (input is mostly re-sent system prompt).
    const reread = await store.get(friend.id)
    expect(reread?.totalTokens).toBe(50)
  })
})
