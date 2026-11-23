// An approval card the Butler wants from Ari (a tool approval's prompt, a newcomer's admission card) goes to Ari's primary
// agent over a real sealed A2A chat first, and the card reaches Telegram silently. When that agent is down, the card
// reaches Telegram loudly with the fallback line. Telegram is a fake Bot API; the primary agent is a real A2A server.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { didKeyIdentityFromEd25519, ready, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startA2AServer, type A2AServerHandle } from "../../a2a/server"
import { loadOrMintA2AIdentityFile, type A2AIdentity } from "../../a2a/identity"
import { createTelegramSenseApp } from "../../senses/telegram"
import { createA2AOwnerRoute, OWNER_ROUTE_FALLBACK_PREFIX } from "../../senses/telegram-owner-route"
import { FileTelegramUpdateInboxStore, type TelegramLongPollOptions } from "../../senses/telegram-client"
import { APPROVAL_RELAY_FILE } from "../../a2a/approval-relay"
import { operatorTrustDir } from "../../a2a/operator-trust"
import type { OwnerRouteItem } from "../../senses/telegram-owner-route"

const CARD_URL_FOR_RELAY = "https://slugger.example/.well-known/agent-card.json"
const PROFILES = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", "utf8"))

let sodium: Sodium
const cleanups: Array<() => Promise<void> | void> = []
beforeAll(async () => { sodium = await ready() })
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A stand-in for Slugger: a real A2A server that knows the Butler as a family peer and records what it is told. */
async function primaryAgent() {
  const slugger: TmpBundleHandle = createTmpBundle({ agentName: `slugger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
  cleanups.push(() => slugger.cleanup())
  fs.writeFileSync(path.join(slugger.agentRoot, "tool-profiles.json"), JSON.stringify(PROFILES))
  const keys = sodium.crypto_sign_keypair()
  const identity: A2AIdentity = { ...didKeyIdentityFromEd25519({ sodium, ed25519Pub: keys.publicKey, ed25519Priv: keys.privateKey }), seed: Buffer.from(sodium.randombytes_buf(32)).toString("base64url") }
  const butler = await loadOrMintA2AIdentityFile({ filePath: path.join(slugger.bundlesRoot, "butler", "identity.json"), sodium })
  const store = new FileFriendStore(`${slugger.agentRoot}/friends`)
  const record = await upsertAgentPeer(store, { name: "the Butler", agentId: butler.did, trustLevel: "family", a2a: { did: butler.did, agentId: butler.did, endpointUrl: "https://butler.example/a2a" } })
  await store.put(record.id, { ...record, admissionState: "active", initiativePolicy: "reactive_only", capabilityProfileId: "sanctuary-agent-peer" })
  const heard: string[] = []
  let server: A2AServerHandle | null = await startA2AServer({
    agentName: slugger.agentName, agentRoot: slugger.agentRoot, port: 0, identity,
    turnRunner: async (input) => { heard.push(input.message); return { response: "noted" } },
  })
  const stop = async () => { if (server) { await server.close(); server = null } }
  cleanups.push(stop)
  const cardUrl = new URL("/.well-known/agent-card.json", server.url).toString()
  const route = createA2AOwnerRoute({ cardUrl, did: identity.did, loadIdentity: async () => butler, send: (input) => import("../../a2a/client").then(({ sendSealedA2AChat }) => sendSealedA2AChat({ ...input, sodium })) })
  return { route, heard, stop }
}

function fakeTelegram() {
  let nextMessageId = 100
  const requests: Array<{ method: string; body: Record<string, unknown> }> = []
  const api = { request: vi.fn(async (method: string, body: Record<string, unknown>) => { requests.push({ method, body: structuredClone(body) }); return { message_id: nextMessageId++ } }), stop: vi.fn() }
  const cards = () => requests.filter(({ method, body }) => method === "sendMessage" && body.reply_markup).map(({ body }) => body)
  return { api, requests, cards }
}

function root(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("approval cards go to the primary agent over A2A first", () => {
  it("sends a tool approval's prompt to the primary agent and the card to Telegram silently, or loudly with the fallback line when it is down", async () => {
    const slugger = await primaryAgent()
    const telegram = fakeTelegram()
    let effects!: { sendCard(input: { idempotencyKey: string; chatId: string; text: string; buttons: Array<Array<{ text: string; callbackData: string }>> }): Promise<number> }
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "777:secret", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: root("telegram-route-approval-"), _toolContext: {} as never,
      migrateIdentity: async () => undefined, api: telegram.api, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      ownerRoute: slugger.route,
      _createApprovalRuntime: ((input: { effects: typeof effects }) => {
        effects = input.effects
        return {
          transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []) },
          coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
        }
      }) as never,
    })
    cleanups.push(() => app.stop())
    const buttons = [[{ text: "Approve", callbackData: "a:1" }, { text: "Deny", callbackData: "d:1" }]]

    await effects.sendCard({ idempotencyKey: "approval:restart-1:prompt", chatId: "42", text: "Restart calibre-web?", buttons })
    expect(slugger.heard).toHaveLength(1)
    expect(slugger.heard[0]).toContain("urgency: now")
    expect(slugger.heard[0]).toContain("Restart calibre-web?\n\nOptions: Approve, Deny. The buttons are on the card in the Butler's Telegram chat.")
    expect(slugger.heard[0]).toMatch(/dedupe key: butler-approval-c4d7bee81059802e-prompt$/u)
    expect(slugger.heard[0]).not.toContain("restart-1")
    expect(telegram.cards()).toEqual([expect.objectContaining({ chat_id: "42", text: "Restart calibre-web?", disable_notification: true })])

    await slugger.stop()
    await effects.sendCard({ idempotencyKey: "approval:restart-2:prompt", chatId: "42", text: "Restart sonarr?", buttons })
    expect(slugger.heard).toHaveLength(1)
    const loud = telegram.cards()[1]!
    expect(loud.text).toBe(`${OWNER_ROUTE_FALLBACK_PREFIX}\n\nRestart sonarr?`)
    expect(loud).not.toHaveProperty("disable_notification")
  })

  it("sends a newcomer's admission card to the primary agent and the card to Telegram silently, and the newcomer's acknowledgement never goes there", async () => {
    const slugger = await primaryAgent()
    const telegram = fakeTelegram()
    const agentRoot = root("telegram-route-admission-")
    let pollOptions!: TelegramLongPollOptions
    const app = createTelegramSenseApp({
      agentName: "butler", credentials: { botToken: "777:secret", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: agentRoot,
      api: telegram.api, offsetStore: { load: () => 0, save: vi.fn() },
      inboxStore: new FileTelegramUpdateInboxStore(path.join(agentRoot, "telegram-inbox.json")),
      createLongPoll: (options) => { pollOptions = options; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      runTurn: vi.fn(), migrateIdentity: async () => undefined,
      ownerRoute: slugger.route,
      admission: { ownerFriendId: "ari", resolveOwner: vi.fn(async ({ userId, chatId }) => userId === "42" && chatId === "42" ? { friendId: "ari" } : null), resolveApprovedFriend: vi.fn(async () => null), claimFriend: vi.fn(), revokeFriend: vi.fn(async () => ({ kind: "revoked" as const })), createDisplayCode: () => "PINE-4821" },
      authorizeRelationshipEffect: vi.fn(async (input) => ({ allowed: true, receiptId: "friends:test", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: input.target.kind === "approved_relationship" && input.target.friendId === "ari" ? "42" : "888" } })),
    })
    cleanups.push(() => app.stop())

    await pollOptions.onUnknownMessage!({ updateId: 11, messageId: 22, botId: "777", userId: "888", chatId: "888", text: "hi", displayLabel: "Sam", hasAttachments: false, attachments: [] })
    expect(slugger.heard).toHaveLength(1)
    expect(slugger.heard[0]).toContain("urgency: now")
    expect(slugger.heard[0]).toContain("Options: Allow, Deny, Block. The buttons are on the card in the Butler's Telegram chat.")
    expect(slugger.heard[0]).toMatch(/dedupe key: butler-owner-card-/u)
    const [card] = telegram.cards().filter((body) => body.chat_id === "42")
    expect(card).toMatchObject({ disable_notification: true })
    expect(String(card!.text).startsWith(OWNER_ROUTE_FALLBACK_PREFIX)).toBe(false)
  })

  it("hands the route a relay request for a tool approval while the relay switch names the route's peer, and none once it's off", async () => {
    const bundle = createTmpBundle({ agentName: `relay-${Math.random().toString(36).slice(2, 8)}` })
    cleanups.push(() => bundle.cleanup())
    const peerDid = "did:key:z6MkSyntheticSluggerRoute"
    const config = JSON.parse(fs.readFileSync(bundle.agentConfigPath, "utf8"))
    // A Sanctuary agent.json must set its habit budget, as the deployed one does.
    config.habitPaidTurnsPerDay = 24
    config.senses = { ...config.senses, telegram: { ...config.senses?.telegram, enabled: true, ownerNoticesTo: { cardUrl: CARD_URL_FOR_RELAY, did: peerDid } } }
    fs.writeFileSync(bundle.agentConfigPath, JSON.stringify(config))
    const trust = operatorTrustDir(bundle.agentRoot)
    fs.mkdirSync(trust, { recursive: true, mode: 0o755 })
    const switchFile = path.join(trust, APPROVAL_RELAY_FILE)
    fs.writeFileSync(switchFile, JSON.stringify({ schemaVersion: 1, did: peerDid, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), approveTools: [], source: "synthetic test switch" }), { mode: 0o644 })
    cleanups.push(() => fs.rmSync(trust, { recursive: true, force: true }))

    const routed: OwnerRouteItem[] = []
    const relayToken = "r".repeat(43)
    const approvalRelayRequest = vi.fn(() => ({ relayToken, prompt: "Restart calibre-web?", expiresAt: Date.now() + 300_000 }))
    let effects!: { sendCard(input: { idempotencyKey: string; chatId: string; text: string; buttons: Array<Array<{ text: string; callbackData: string }>> }): Promise<number> }
    const app = createTelegramSenseApp({
      agentName: "sanctuary", credentials: { botToken: "777:secret", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), _agentRoot: bundle.agentRoot, _toolContext: {} as never,
      migrateIdentity: async () => undefined, api: fakeTelegram().api, offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
      ownerRoute: Object.assign(async (item: OwnerRouteItem) => { routed.push(item); return { status: "delivered" as const } }, { peerDid }),
      _createApprovalRuntime: ((input: { effects: typeof effects }) => {
        effects = input.effects
        return {
          transport: { sendApproval: vi.fn(), handleUpdate: vi.fn(), recoverDecisionAttempt: vi.fn(), reconcileExpired: vi.fn(), terminalizeOrphaned: vi.fn(), terminalizeRecovered: vi.fn(), listPendingDeliveries: vi.fn(() => []), approvalRelayRequest },
          coordinator: vi.fn(), recover: vi.fn(), close: vi.fn(),
        }
      }) as never,
    })
    cleanups.push(() => app.stop())
    const buttons = [[{ text: "Approve", callbackData: "a:1" }, { text: "Deny", callbackData: "d:1" }]]

    await effects.sendCard({ idempotencyKey: "approval:restart-1:prompt", chatId: "42", text: "Restart calibre-web?", buttons })
    expect(approvalRelayRequest).toHaveBeenCalledWith({ approvalId: "restart-1", routeDid: peerDid })
    expect(routed[0]!.approvalRequest).toEqual({ relayToken, code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}$/u), actionLine: "Restart calibre-web?", decisions: ["deny"], expiresAt: expect.any(String) })

    fs.rmSync(switchFile)
    await effects.sendCard({ idempotencyKey: "approval:restart-2:prompt", chatId: "42", text: "Restart sonarr?", buttons })
    expect(routed[1]).not.toHaveProperty("approvalRequest")
    expect(approvalRelayRequest).toHaveBeenCalledTimes(1)

    // Building the request fails: the card still goes, with no request.
    fs.writeFileSync(switchFile, JSON.stringify({ schemaVersion: 1, did: peerDid, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), approveTools: [], source: "synthetic test switch" }), { mode: 0o644 })
    approvalRelayRequest.mockImplementationOnce(() => { throw new Error("store unreadable") })
    await expect(effects.sendCard({ idempotencyKey: "approval:restart-3:prompt", chatId: "42", text: "Restart radarr?", buttons })).resolves.toEqual(expect.any(Number))
    expect(routed).toHaveLength(3)
    expect(routed[2]).not.toHaveProperty("approvalRequest")
  })
})
