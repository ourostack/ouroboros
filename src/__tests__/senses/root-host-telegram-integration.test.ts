import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore, getChannelCapabilities } from "@ouro.bot/friends"
import * as hostRuntime from "../../senses/root-host-approval-runtime"
import * as admission from "../../senses/telegram-admission"
import * as attachments from "../../senses/telegram-attachments"
import { createProductionTelegramRelationshipComposition, createTelegramSenseApp, readOrCreateTelegramIdentityKey } from "../../senses/telegram"
import { selectToolsForChannel } from "../../repertoire/tools"
import { getSenseSessionPath } from "../../senses/shared-turn"
import { loadSessionEnvelopeFile } from "../../heart/session-events"

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

async function fixture(enabled = true, duringCreate?: (options: Parameters<typeof hostRuntime.createRootHostApprovalRuntime>[0]) => void) {
  const base = path.resolve(".s5-telegram-tests", String(roots.length))
  roots.push(base)
  const agentRoot = path.join(base, "sanctuary.ouro")
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.copyFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", path.join(agentRoot, "tool-profiles.json"))
  const friends = new FileFriendStore(path.join(agentRoot, "friends"))
  const now = new Date().toISOString()
  const friend: any = { id: "owner", name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive", capabilityProfileId: "sanctuary-owner", externalIds: [{ provider: "telegram-user", tenantId: "777", externalId: "42", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 }
  await friends.put(friend.id, friend)
  const credentials = { botId: "777", authorizedUserId: "42", authorizedChatId: "42" }
  const composition = await createProductionTelegramRelationshipComposition("sanctuary", credentials, agentRoot)
  const hostPropose = vi.fn(async () => ({ approvalId: "root", checkpointDigest: "a".repeat(64), suspendedSessionRevision: "b".repeat(64) }))
  const ordinaryPropose = vi.fn(async () => ({ approvalId: "ordinary", checkpointDigest: "a".repeat(64), suspendedSessionRevision: "b".repeat(64) }))
  const host = { coordinator: vi.fn(() => ({ propose: hostPropose })), recover: vi.fn(async () => undefined), handleUpdate: vi.fn(async () => true) }
  const create = vi.spyOn(hostRuntime, "createRootHostApprovalRuntime").mockImplementation((options) => { duringCreate?.(options); return host })
  const ordinary = { coordinator: vi.fn(() => ({ propose: ordinaryPropose })), recover: vi.fn(async () => undefined), close: vi.fn(), transport: { handleUpdate: vi.fn(async () => ({ handled: true })), reconcileExpired: vi.fn(async () => undefined) } }
  const observation: any = { targetHost: "sanctuary", keyId: "issuer", publicKeyDigest: `sha256:${"a".repeat(64)}` }
  const port: any = { pins: { expectedTargetHost: "sanctuary", expectedBotId: "777", expectedOwnerUserId: "42", expectedOwnerChatId: "42", expectedKeyId: "issuer", expectedPublicKeyDigest: `sha256:${"a".repeat(64)}` }, refresh: vi.fn(async () => true), isHealthy: vi.fn(() => true), acceptsObservation: vi.fn((value) => value === observation), callbackForUpdate: vi.fn(() => ({ handled: true })) }
  let handlers: any
  let prepared: any
  let turn: any
  const api: any = { request: vi.fn(async () => ({ message_id: 901 })), stop: vi.fn() }
  const runTurn = vi.fn(async (input: any) => {
    turn = input
    const sessionPath = getSenseSessionPath("sanctuary", friend.id, "telegram", input.sessionKey, agentRoot)
    prepared = await input.prepareRunAgentOptions({ runAgentOptions: { toolContext: {
      ...input.toolContext, signin: async () => undefined, agentName: "sanctuary", agentRoot, friendStore: friends,
      context: { friend, channel: getChannelCapabilities("telegram") },
      currentSession: { friendId: friend.id, channel: "telegram", key: input.sessionKey, sessionPath },
    } } })
    return { response: "", deliveries: [], deliveryFailures: [], turnOutcome: "suspended", providerInvocationCount: 1, toolInvocationCount: 0 }
  })
  const transport = { api, settleTransport: vi.fn(), downloadFile: vi.fn(), admitChat: vi.fn(), revokeChat: vi.fn(), metadataForUpdate: vi.fn(() => observation), ...(enabled ? { hostApproval: port } : {}) }
  const app = createTelegramSenseApp({
    agentName: "sanctuary", credentials, ...composition, _agentRoot: agentRoot, identityKey: readOrCreateTelegramIdentityKey(agentRoot),
    authorityTransport: transport,
    approvalRuntime: ordinary as any, _toolContext: {} as any, _runTurn: runTurn,
    _createInteractiveControl: () => ({ start: vi.fn(), stop: vi.fn() }) as any,
    createLongPoll: (input: any) => { handlers = input; return { run: vi.fn(async () => undefined), stop: vi.fn(), pollOnce: vi.fn() } },
    migrateIdentity: async () => undefined,
  })
  const message = () => handlers.onMessage({ updateId: 10, messageId: "110", userId: "42", chatId: "42", text: "run id", authority: observation })
  return { app, handlers, create, host, port, transport, ordinary, message, observation, friend, friends, agentRoot, api, hostPropose, ordinaryPropose, prepared: () => prepared, turn: () => turn }
}

describe("root host Telegram production routing", () => {
  it("refuses an unpinned gateway bot and a host proposal before its runtime exists", async () => {
    expect(() => createTelegramSenseApp({ agentName: "sanctuary", credentials: { authorizedUserId: "42", authorizedChatId: "42" }, authorityTransport: {} as any })).toThrow("pinned bot id")
    const f = await fixture(true, (options) => {
      const coordinator = options.approvalCoordinatorFactory!({ sessionPath: "/uninitialized", baseSessionRevision: "b".repeat(64) })
      expect(() => coordinator.propose({ toolCall: { type: "function", function: { name: "sanctuary_host_execute" } } } as any)).toThrow("coordinator is unavailable")
    })
    await f.app.stop()
  })

  it("revalidates owner continuation coordinates and uses the existing authorized effect delivery", async () => {
    const f = await fixture()
    try {
      await f.message()
      const binding = f.prepared().toolContext.rootHost.binding
      const options = f.create.mock.calls[0]![0]
      for (const key of ["agentRoot", "friendId", "sessionKey", "sessionPath"]) {
        await expect(options.resolveContext({ ...binding, [key]: "changed" })).rejects.toThrow("session changed")
      }
      const resolved = await options.resolveContext(binding)
      await resolved.signin("fixture")
      await options.deliver("root receipt verified", "approval-fixture")
      expect(f.api.request).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ chat_id: "42", text: expect.stringContaining("root receipt verified") }), undefined)
      const get = vi.spyOn(FileFriendStore.prototype, "get").mockResolvedValueOnce(f.friend).mockResolvedValueOnce(null)
      await expect(options.resolveContext(binding)).rejects.toThrow("Friend is unavailable")
      get.mockRestore()
      f.port.acceptsObservation.mockReturnValue(false)
      await f.message()
      expect(f.prepared().toolContext.rootHost).toBeUndefined()
    } finally { await f.app.stop() }
  })

  it("keeps admission registry and tokenless attachment operations on the authority transport", async () => {
    const controller = vi.spyOn(admission, "createTelegramAdmissionController")
    const ingest = vi.spyOn(attachments, "ingestTelegramAttachments").mockResolvedValue({ attachments: [], notices: [] })
    const f = await fixture()
    try {
      const options = controller.mock.calls[0]![0]
      await options.registerCommunication!({ id: "admission-fixture", updateId: 11, userId: "84", chatId: "84" } as any)
      expect(f.transport.admitChat).toHaveBeenCalledWith({ admissionId: "admission-fixture", updateId: 11, userId: "84", chatId: "84" })
      await options.revokeCommunication!({ userId: "84", chatId: "84" })
      expect(f.transport.revokeChat).toHaveBeenCalledWith({ userId: "84", chatId: "84" })
      await f.handlers.onMessage({ updateId: 10, messageId: "110", userId: "42", chatId: "42", text: "run id", authority: f.observation, attachments: [{ fileId: "image", kind: "image", displayName: "image.png" }] })
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ downloadFile: f.transport.downloadFile }))
      expect(ingest.mock.calls[0]![0]).not.toHaveProperty("botToken")
    } finally { await f.app.stop() }
  })
  it("binds the owner observation, routes only host proposals, claims callbacks, and recovers separately", async () => {
    const f = await fixture()
    try {
      expect(f.create).toHaveBeenCalledOnce()
      await f.message()
      const ctx = f.prepared().toolContext
      expect(ctx.rootHost.observation).toBe(f.observation)
      expect(selectToolsForChannel(getChannelCapabilities("telegram"), undefined, ctx.context, new Set(["approval-continuation"]), undefined, undefined, ctx).ordinary.map((d) => d.tool.function.name)).toContain("sanctuary_host_execute")
      const coordinator = f.turn().approvalCoordinatorFactory({ sessionPath: ctx.currentSession.sessionPath, baseSessionRevision: "b".repeat(64) })
      await coordinator.propose({ toolCall: { type: "function", function: { name: "sanctuary_host_execute" } } })
      await coordinator.propose({ toolCall: { type: "function", function: { name: "unraid_restart_container" } } })
      expect(f.hostPropose).toHaveBeenCalledOnce()
      expect(f.ordinaryPropose).toHaveBeenCalledOnce()
      expect(await f.handlers.onUpdate({ update_id: 11, callback_query: {} })).toBe(true)
      expect(f.ordinary.transport.handleUpdate).not.toHaveBeenCalled()
      f.host.handleUpdate.mockResolvedValueOnce(false)
      expect(await f.handlers.onUpdate({ update_id: 12, callback_query: {} })).toBe(true)
      expect(f.ordinary.transport.handleUpdate).toHaveBeenCalledOnce()
      const binding = ctx.rootHost.binding
      const resolved = await f.create.mock.calls[0]![0].resolveContext(binding)
      expect(resolved.relationshipAuthorization!.requestId).toBe(binding.requestId)
      expect(resolved.currentSession!.sessionPath).toBe(binding.sessionPath)
      expect(loadSessionEnvelopeFile(binding.sessionPath)).not.toBeNull()
      await f.app.run()
      expect(f.host.recover).toHaveBeenCalledOnce()
      expect(f.ordinary.recover).toHaveBeenCalledOnce()
    } finally { await f.app.stop() }
  })

  it("preserves ordinary routing when the root provider is absent or health cannot authorize the owner", async () => {
    const absent = await fixture(false)
    try {
      expect(absent.create).not.toHaveBeenCalled()
      await absent.message()
      expect(absent.prepared().toolContext.rootHost).toBeUndefined()
      expect(await absent.handlers.onUpdate({ update_id: 11, callback_query: {} })).toBe(true)
      expect(absent.ordinary.transport.handleUpdate).toHaveBeenCalledOnce()
    } finally { await absent.app.stop() }
    const unhealthy = await fixture()
    try {
      unhealthy.port.refresh.mockResolvedValue(false)
      await unhealthy.message()
      expect(unhealthy.prepared().toolContext.rootHost).toBeUndefined()
    } finally { await unhealthy.app.stop() }
  })
})
