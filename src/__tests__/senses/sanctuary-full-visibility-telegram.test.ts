import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createTelegramSenseApp } from "../../senses/telegram"
import type { TelegramInboundMessage, TelegramLongPollOptions } from "../../senses/telegram-client"

const roots: string[] = []
const requiredNames = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers", "unraid_get_storage", "sanctuary_get_download_queue"]

describe("Sanctuary owner full-visibility activation", () => {
  afterEach(() => {
    while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it.each(["What are you working on?", "What's going on with Sanctuary?"])("binds current reads to the live owner turn for %j", async (text) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-full-visibility-")); roots.push(root)
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    let prepared: any
    const apiRequest = vi.fn(async () => ({ message_id: 71 }))
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken: "test-token", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43),
      _agentRoot: root,
      migrateIdentity: async () => undefined,
      api: { request: apiRequest, stop: vi.fn() },
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options: TelegramLongPollOptions) => {
        onMessage = options.onMessage
        return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }
      },
      runTurn: vi.fn(async (options: any) => {
        prepared = await options.prepareRunAgentOptions({ runAgentOptions: { toolContext: {} } })
        expect(options.emptyResponseFallback()).toBeUndefined()
        const results: Record<string, string> = {
          query_active_work: "this is my current top-level live world-state.\nhealthy",
          query_cares: "[]",
          unraid_get_system: JSON.stringify({ ok: true }),
          unraid_list_containers: JSON.stringify({ ok: true }),
          unraid_get_storage: JSON.stringify({ ok: true }),
          sanctuary_get_download_queue: JSON.stringify({ ok: false, error: { code: "request_unavailable" }, observedAt: "2026-08-30T04:00:00.000Z" }),
        }
        for (const name of requiredNames) expect(prepared.requiredToolCalls.validateRequiredToolResult(name, results[name])).toBe(true)
        return { response: options.emptyResponseFallback(), ponderDeferred: false, deliveries: [], deliveryFailures: [] }
      }),
      resolveRelationshipAuthorization: vi.fn(async (input) => ({
        subject: { friendId: input.friendId, trustLevel: "family", admissionState: "active", initiativePolicy: "proactive" },
        profileId: "sanctuary-owner",
        authorizedContextScopes: ["household.status", "household.policy"],
        advertisedToolNames: [...requiredNames, "settle"],
        actor: { friendId: "ari", trustLevel: "family", sessionEventId: input.sessionEventId },
        authorizeContext: vi.fn(), authorizeTool: vi.fn(async () => ({ allowed: true })), authorizeEffect: vi.fn(),
      } as any)),
    })

    await onMessage({ updateId: 1, messageId: "2", userId: "42", chatId: "42", text })

    expect(prepared.requiredToolCalls).toEqual({
      names: requiredNames,
      retryMessage: "Before answering, read current active work, cares, system health, service state, storage, and the download queue. Current tool facts outrank care history; a stale care is a recheck item, not a present-tense fact. Then give Ari one compact household summary; do not ask him to choose a status slice.",
      requireSuccessfulResults: true,
      validateRequiredToolResult: expect.any(Function),
      validateTerminalAnswer: expect.any(Function),
    })
    expect(apiRequest.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1)
    expect(apiRequest).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: expect.stringMatching(/won't guess or reuse old alerts/iu) }), undefined)
    await app.stop()
  })
})
