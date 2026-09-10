import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore } from "@ouro.bot/friends"
import { createProductionTelegramRelationshipComposition, createTelegramSenseApp, opaqueTelegramSubject, readOrCreateTelegramIdentityKey } from "../../senses/telegram"
import { createTelegramApprovalRuntime, type TelegramApprovalRuntime } from "../../senses/telegram-approval-runtime"
import { createMinimaxProviderRuntime } from "../../heart/providers/minimax"
import { buildCanonicalSessionEnvelope } from "../../heart/session-events"
import { readSessionTransaction, withSessionTurnLease } from "../../mind/session-transaction"
import { openApprovalStore } from "../../heart/approval-store"
import { digestApprovalToolDefinition } from "../../heart/tool-approval"
import { digestJson, validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"
import { resolveToolDefinition } from "../../repertoire/tools"
import { getSenseSessionPath } from "../../senses/shared-turn"
import { createLogger, createNdjsonFileSink } from "../../nerves"
import { setRuntimeLogger } from "../../nerves/runtime"

const roots: string[] = []
afterEach(() => {
  setRuntimeLogger(null)
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("configured-owner Telegram approval authority", () => {
  it.each(["unchanged", "revoked", "trust", "profile", "tool", "bot", "missing-profile", "missing-friend", "expired-revoked", "wrong-session", "missing-ingress", "producer-profile", "late-missing-friend", "missing-resolver"] as const)(
    "uses the real current Friend/profile producer at decision and continuation: %s",
    async (change) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-owner-"))
      roots.push(root)
      setRuntimeLogger(createLogger({ sinks: [createNdjsonFileSink(path.join(root, "nerves.ndjson"))] }))
      const profilePath = path.join(root, "tool-profiles.json")
      fs.copyFileSync(path.resolve(__dirname, "../../../deploy/unraid/sanctuary.ouro/tool-profiles.json"), profilePath)
      const friends = new FileFriendStore(path.join(root, "friends"))
      const friendId = "11111111-1111-4111-8111-111111111111"
      const now = "2026-09-10T00:00:00.000Z"
      await friends.put(friendId, {
        id: friendId, name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive",
        capabilityProfileId: "sanctuary-owner",
        externalIds: [{ provider: "telegram-user", externalId: "42", tenantId: "777", linkedAt: now }],
        tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
        createdAt: now, updatedAt: now, schemaVersion: 1,
      })
      const credentials = { botToken: "777:fixture", botId: "777", authorizedUserId: "42", authorizedChatId: "42" }
      const identityKey = readOrCreateTelegramIdentityKey(root)
      const subject = opaqueTelegramSubject(identityKey, "777", "42", "42")
      const key = `telegram:${subject}`
      const sessionPath = getSenseSessionPath("sanctuary", friendId, "telegram", key, root)
      const messages = [{ role: "user" as const, content: "restart calibre-web" }]
      const envelope = buildCanonicalSessionEnvelope({
        existing: null, previousMessages: [], currentMessages: messages, trimmedMessages: messages,
        recordedAt: now, projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      }).envelope
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
      fs.writeFileSync(sessionPath, JSON.stringify(envelope))
      const unused = vi.fn(async () => { throw new Error("unexpected fixture service call") })
      const mutation = vi.fn(async () => ({
        ok: true,
        data: { container: { id: "fixture-container", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false },
      }))
      const provider = vi.fn(async (_messages, callbacks) => {
        callbacks.onTextChunk("The requested action completed.")
        return { outcome: "settled" as const }
      })
      let messageId = 100
      const api = { request: vi.fn(async (method: string, _body: Record<string, unknown>) => method === "sendMessage" ? { message_id: ++messageId } : true), stop: vi.fn() }
      const clock = { value: Date.now() }
      const composition = await createProductionTelegramRelationshipComposition("sanctuary", credentials, root)
      const observedScopes: Array<string | undefined> = []
      let authorityChecks = 0
      let faultActive = false
      let runtime!: TelegramApprovalRuntime
      const appOptions: Parameters<typeof createTelegramSenseApp>[0] = {
        agentName: "sanctuary", credentials, identityKey, _agentRoot: root, ...composition, api,
        resolveRelationshipAuthorization: async (input) => {
          const authorization = await composition.resolveRelationshipAuthorization!(input)
          if (faultActive && change === "late-missing-friend") fs.unlinkSync(path.join(root, "friends", `${friendId}.json`))
          return faultActive && change === "producer-profile" ? { ...authorization, profileId: "sanctuary-household" } : authorization
        },
        offsetStore: { load: () => 0, save: vi.fn() },
        createLongPoll: () => ({ pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }),
        migrateIdentity: async () => undefined,
        acceptanceMarker: () => null,
        healthSweep: unused,
        _createInteractiveControl: () => ({ socketPath: path.join(root, "unused.sock"), start: unused, stop: async () => undefined }),
        _toolContext: { agentRoot: root, sanctuary: {
          listContainers: unused, getContainerLogs: unused, getStorage: unused, getDisks: unused,
          getNotifications: unused, getSystem: unused, getInstallState: unused, checkServices: unused,
          getDownloadQueue: unused, getMediaOptimization: unused, searchMediaCatalog: unused,
          resumeDownloadQueue: unused, restartContainer: mutation,
        } },
        _createApprovalRuntime: (options) => {
          observedScopes.push(options.dependencies?.agentRoot)
          runtime = createTelegramApprovalRuntime({
            ...options,
            resolveLiveToolContext: async (record) => {
              authorityChecks += 1
              if (!options.resolveLiveToolContext) throw new Error("current configured-owner producer is unavailable")
              if (faultActive && change === "missing-ingress" && fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath)
              const context = await options.resolveLiveToolContext(faultActive && change === "wrong-session"
                ? { ...record, sessionPath: path.join(root, "wrong-session.json") }
                : record)
              if (change === "unchanged") {
                await context.signin()
                expect((await context.relationshipAuthorization!.resolveCurrent!()).profileId).toBe("sanctuary-owner")
              }
              return context
            },
            dependencies: {
              ...options.dependencies, agentRoot: root, runProvider: provider, now: () => clock.value,
              getProviderRuntime: async (_facing, owner) => {
                expect(owner).toEqual({ agentName: "sanctuary", agentRoot: root })
                return createMinimaxProviderRuntime("MiniMax-M3", { apiKey: "isolated-provider-fixture" })
              },
              getSharedMcpManager: async () => null,
            },
          })
          return runtime
        },
      }
      const app = createTelegramSenseApp(appOptions)
      try {
        const definition = resolveToolDefinition("unraid_restart_container")!
        const args = { container: "calibre-web" }
        const validated = validateAdvertisedToolArguments(JSON.stringify(args), definition.tool.function.parameters!)
        if (!validated.ok) throw new Error(validated.reason)
        const policy = definition.approvalPolicy!(args)
        if (policy.kind !== "required") throw new Error("fixture action requires approval")
        const call = { id: "owner-restart", type: "function" as const, function: { name: "unraid_restart_container", arguments: JSON.stringify(args) } }
        const suspension = await withSessionTurnLease(sessionPath, async (lease) => runtime.coordinator({ sessionPath, baseSessionRevision: readSessionTransaction(sessionPath, lease).revision }).propose({
          toolCall: call, arguments: args, preCallMessages: messages,
          frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [call] },
          schemaDigest: validated.value.schemaDigest,
          toolDigest: digestApprovalToolDefinition(definition, validated.value.schemaDigest, policy.policyId),
          policyDigest: digestJson({ policyId: policy.policyId, actionClass: policy.actionClass, classification: "required" }),
          policyId: policy.policyId, actionClass: policy.actionClass,
        }))
        const friend = (await friends.get(friendId))!
        faultActive = true
        if (change === "missing-resolver") delete appOptions.resolveRelationshipAuthorization
        if (change === "revoked" || change === "expired-revoked") await friends.put(friendId, { ...friend, admissionState: "revoked" })
        if (change === "trust") await friends.put(friendId, { ...friend, trustLevel: "friend" })
        if (change === "profile") await friends.put(friendId, { ...friend, capabilityProfileId: "sanctuary-household" })
        if (change === "bot") await friends.put(friendId, { ...friend, externalIds: [{ ...friend.externalIds[0], tenantId: "999" }] })
        if (change === "missing-friend") fs.unlinkSync(path.join(root, "friends", `${friendId}.json`))
        if (change === "tool" || change === "missing-profile") {
          const profiles = JSON.parse(fs.readFileSync(profilePath, "utf8"))
          if (change === "missing-profile") delete profiles.profiles["sanctuary-owner"]
          else profiles.profiles["sanctuary-owner"].toolNames = profiles.profiles["sanctuary-owner"].toolNames.filter((name: string) => name !== "unraid_restart_container")
          fs.writeFileSync(profilePath, JSON.stringify(profiles))
        }
        const [pending] = runtime.transport.listPendingDeliveries()
        if (change === "expired-revoked") {
          clock.value = pending.expiresAt + 1
          await runtime.transport.reconcileExpired()
        } else {
          expect(await runtime.transport.handleUpdate({
            update_id: 1, callback_query: {
              id: "owner-decision", from: { id: 42 }, data: pending.approveCallbackData,
              message: { message_id: Number(pending.messageId), chat: { id: 42 } },
            },
          })).toMatchObject({ handled: true })
          expect(authorityChecks).toBeGreaterThan(0)
        }
        expect(observedScopes).toEqual([root])
        const store = openApprovalStore({ databasePath: path.join(root, "state", "approvals", "approvals.sqlite") })
        try {
          expect(store.read(suspension.approvalId)?.state).toBe(change === "unchanged" ? "succeeded" : change === "expired-revoked" ? "expired" : "drifted")
        } finally { store.close() }
        expect(mutation).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0)
        expect(provider).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0)
        expect(unused).not.toHaveBeenCalled()
        expect(runtime.transport.listPendingDeliveries()).toEqual([])
        const terminalText = String(api.request.mock.calls.find(([method]) => method === "editMessageText")![1].text)
        expect(await runtime.isPendingTerminalControl?.({
          authorClass: "control",
          effect: { kind: "edit", messageId: Number(pending.messageId), text: terminalText },
          idempotencyKey: `approval:${pending.approvalId}:edit:${createHash("sha256").update(terminalText).digest("hex")}`,
        })).toBe(false)
        if (["revoked", "trust", "profile", "bot", "missing-profile", "missing-friend", "expired-revoked"].includes(change)) {
          await expect(app.sendProactive("This private message is not authorized.")).rejects.toThrow(/authorization denied/)
          expect(api.request.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1)
        }
      } finally {
        await app.stop()
      }
    },
  )
})
