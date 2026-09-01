import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const probe = vi.hoisted(() => ({
  agentRoot: "",
  apiRequest: vi.fn(),
  apiStop: vi.fn(),
  runtimeClose: vi.fn(),
  deniedReason: "",
  unavailableCalls: [] as string[],
  mode: "live" as "live" | "unavailable",
}))

vi.mock("../../../heart/identity", () => ({ getAgentRoot: () => probe.agentRoot }))
vi.mock("../../../heart/runtime-credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/runtime-credentials")>(),
  refreshRuntimeCredentialConfig: async () => ({ ok: true, itemPath: "vault:test", revision: "test", updatedAt: "2026-08-29T00:00:00.000Z", config: {} }),
}))
vi.mock("../../../senses/telegram", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../senses/telegram")>(),
  loadTelegramSenseCredentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "43" }),
  readOrCreateTelegramIdentityKey: () => "k".repeat(43),
}))
vi.mock("../../../senses/telegram-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../senses/telegram-client")>(),
  createTelegramBotApi: () => ({ request: probe.apiRequest, stop: probe.apiStop }),
}))
vi.mock("../../../senses/sanctuary-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../senses/sanctuary-runtime")>(),
  createSanctuaryToolContext: () => ({ sanctuary: {} }),
}))
vi.mock("../../../senses/telegram-effect-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../senses/telegram-effect-adapter")>()
  return {
    ...actual,
    createTelegramApprovalEffectPort: (options: Parameters<typeof actual.createTelegramApprovalEffectPort>[0]) => {
      const port = actual.createTelegramApprovalEffectPort(options)
      return {
        ...port,
        sendText: async (input: Parameters<typeof port.sendText>[0]) => {
          try {
            await options.execute({
              idempotencyKey: "acceptance-unauthorized-target",
              target: { kind: "approved_relationship", friendId: "telegram-user:wrong", sessionKey: "telegram:wrong" },
              authorClass: "butler",
              effect: { kind: "text", text: "must not send" },
            })
          } catch (error) {
            probe.deniedReason = error instanceof Error ? error.message : String(error)
          }
          return port.sendText(input)
        },
      }
    },
  }
})
vi.mock("../../../senses/telegram-approval-runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../senses/telegram-approval-runtime")>(),
  createTelegramApprovalRuntime: (input: any) => ({
    transport: {
      handleUpdate: async () => {
        if (probe.mode === "unavailable") {
          for (const [name, operation] of [
            ["sendText", () => input.effects.sendText({ idempotencyKey: "unavailable-text", chatId: "43", text: "text", authorClass: "butler" })],
            ["sendCard", () => input.effects.sendCard({ idempotencyKey: "unavailable-card", chatId: "43", text: "card", buttons: [] })],
            ["edit", () => input.effects.edit({ idempotencyKey: "unavailable-edit", chatId: "43", messageId: 1, text: "edit" })],
            ["acknowledge", () => input.effects.acknowledge({ idempotencyKey: "unavailable-ack", callbackQueryId: "query-1" })],
          ] as const) {
            try { await operation() } catch { probe.unavailableCalls.push(name) }
          }
        } else {
          const messageIds = await input.effects.sendText({ idempotencyKey: "acceptance-text", chatId: "43", text: "text", authorClass: "butler" })
          const cardId = await input.effects.sendCard({ idempotencyKey: "acceptance-card", chatId: "43", text: "card", buttons: [[{ text: "Approve", callbackData: "approve" }]] })
          await input.effects.edit({ idempotencyKey: "acceptance-edit", chatId: "43", messageId: cardId, text: "edited" })
          await input.effects.acknowledge({ idempotencyKey: "acceptance-ack", callbackQueryId: "query-1", text: "done" })
          expect(messageIds).toEqual([101])
          expect(cardId).toBe(102)
        }
        return { handled: true, accepted: true, reason: "accepted" }
      },
    },
    close: probe.runtimeClose,
  }),
}))

describe("Sanctuary acceptance callback effect composition", () => {
  beforeEach(() => {
    probe.agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-acceptance-effects-"))
    probe.mode = "live"
    probe.deniedReason = ""
    probe.unavailableCalls = []
    probe.apiRequest.mockReset().mockImplementation(async (method: string) => method === "sendMessage" ? { message_id: probe.apiRequest.mock.calls.length + 100 } : true)
    probe.apiStop.mockReset()
    probe.runtimeClose.mockReset()
  })

  afterEach(() => fs.rmSync(probe.agentRoot, { recursive: true, force: true }))

  it("uses the default owner-authorized journal, session recorder, and cleanup boundary", async () => {
    const { createSanctuaryAcceptanceAdapterDependencies, executeSanctuaryAcceptanceAdapter, executeSanctuaryAcceptanceCallbackProbe } = await import("../../../heart/daemon/sanctuary-acceptance-adapter")

    const update = { update_id: 1, callback_query: { id: "query", data: "approval:data", from: { id: 42 }, message: { message_id: 7, chat: { id: 43 } } } }
    await expect(executeSanctuaryAcceptanceCallbackProbe(update, false)).resolves.toEqual({ settled: true, claimed: true, mutated: true })

    const adapterDependencies = createSanctuaryAcceptanceAdapterDependencies()
    adapterDependencies.readFixedFile = () => '{"nextUpdateId":1}\n'
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "callback_playback_preflight", update }, adapterDependencies)).resolves.toMatchObject({
      playbackCount: 1,
      coordinateDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      journalDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "callback_playback_preflight", update: { ...update, update_id: 2 } }, adapterDependencies)).resolves.toMatchObject({ playbackCount: 0 })
    const journalPath = path.join(probe.agentRoot, "state", "approvals", "sanctuary-callback-playback.sqlite")
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(journalPath).toString("utf8")).not.toMatch(/approval:data|query/u)

    expect(probe.deniedReason).toContain("authorization denied")
    expect(probe.apiRequest.mock.calls.map(([method]) => method)).toEqual(["sendMessage", "sendMessage", "editMessageText", "answerCallbackQuery"])
    expect(probe.runtimeClose).toHaveBeenCalledOnce()
    expect(probe.apiStop).toHaveBeenCalledOnce()
    expect(fs.readdirSync(path.join(probe.agentRoot, "state", "telegram", "effects"))).toHaveLength(4)
    const sessions = fs.readdirSync(path.join(probe.agentRoot, "state", "sessions"), { recursive: true }).map(String)
    expect(sessions.some((entry) => entry.endsWith(".json"))).toBe(true)
  })

  it("fails every effect method closed when an injected callback runtime omits the effect boundary", async () => {
    probe.mode = "unavailable"
    const { executeSanctuaryAcceptanceCallbackProbe } = await import("../../../heart/daemon/sanctuary-acceptance-adapter")
    const dependencies = {
      refresh: async () => ({ ok: true as const, itemPath: "vault:test", revision: "test", updatedAt: "2026-08-29T00:00:00.000Z", config: {} }),
      credentials: () => ({ botToken: "12345:abcdefghijklmnopqrst", authorizedUserId: "42", authorizedChatId: "43" }),
      identityKey: () => "k".repeat(43),
      createApi: () => ({ request: probe.apiRequest, stop: probe.apiStop }),
      createRuntime: (await import("../../../senses/telegram-approval-runtime")).createTelegramApprovalRuntime,
      toolContext: () => ({ sanctuary: {} }),
      recordCallbackPlayback: () => undefined,
    }

    await expect(executeSanctuaryAcceptanceCallbackProbe({ update_id: 1, callback_query: { id: "query", data: "approval:data", from: { id: 42 }, message: { message_id: 7, chat: { id: 43 } } } }, false, dependencies as any)).resolves.toEqual({ settled: true, claimed: true, mutated: true })
    expect(probe.unavailableCalls).toEqual(["sendText", "sendCard", "edit", "acknowledge"])
  })
})
