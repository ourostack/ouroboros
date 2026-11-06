import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore } from "@ouro.bot/friends"

const mocks = vi.hoisted(() => ({
  root: "",
  request: vi.fn(async (_method: string, _body: Record<string, unknown>) => ({ message_id: 71 })),
  stop: vi.fn(),
  run: vi.fn(async () => { throw new Error("one-shot caller must not poll") }),
}))

vi.mock("../../heart/identity", async (importActual) => ({
  ...await importActual<typeof import("../../heart/identity")>(),
  getAgentRoot: () => mocks.root,
}))
vi.mock("../../heart/runtime-credentials", async (importActual) => ({
  ...await importActual<typeof import("../../heart/runtime-credentials")>(),
  readRuntimeCredentialConfig: () => ({ ok: true, config: {
    telegramBotToken: "777:fixture", telegramAuthorizedUserId: "42", telegramAuthorizedChatId: "42",
  } }),
}))
vi.mock("../../senses/sanctuary-runtime", async (importActual) => ({
  ...await importActual<typeof import("../../senses/sanctuary-runtime")>(),
  createSanctuaryToolContext: () => ({ agentRoot: mocks.root }),
}))
vi.mock("../../senses/telegram-client", async (importActual) => ({
  ...await importActual<typeof import("../../senses/telegram-client")>(),
  createTelegramBotApi: () => ({ request: mocks.request, stop: mocks.stop }),
  createTelegramLongPoll: () => ({ pollOnce: vi.fn(), run: mocks.run, stop: vi.fn() }),
}))

import { createSanctuaryInteractiveControl, sanctuaryInteractiveControlReady } from "../../senses/sanctuary-interactive-control"
import { sendTelegramExternalEventDecision } from "../../senses/telegram"

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  fs.rmSync(mocks.root, { recursive: true, force: true })
})

describe("D-007 real one-shot disposal caller", () => {
  it.each(["accepted", "failed"] as const)("preserves the resident through %s delivery and native transient-app cleanup", async (outcome) => {
    mocks.root = fs.mkdtempSync("/tmp/d007-send-")
    fs.writeFileSync(path.join(mocks.root, "tool-profiles.json"), JSON.stringify({ version: 2, profiles: {
      "sanctuary-owner": { version: 1, contextScopes: ["household.private"], toolNames: [], effectScopes: ["telegram.owner_event", "telegram.proactive"] },
      "sanctuary-household": { version: 1, contextScopes: ["own_requests"], toolNames: [], effectScopes: ["telegram.request_return"] },
    } }))
    const friends = new FileFriendStore(path.join(mocks.root, "friends"))
    const now = new Date().toISOString()
    await friends.put("owner", {
      id: "owner", name: "Owner fixture", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive",
      capabilityProfileId: "sanctuary-owner", externalIds: [{ provider: "telegram-user", externalId: "42", tenantId: "777", linkedAt: now }],
      tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1,
    })
    const unused = async (): Promise<never> => { throw new Error("unexpected resident approval effect") }
    const resident = createSanctuaryInteractiveControl({
      agentRoot: mocks.root, authorizedUserId: "42", authorizedChatId: "42",
      transport: {
        sendApproval: unused, handleUpdate: unused, recoverDecisionAttempt: unused, reconcileExpired: unused,
        terminalizeOrphaned: unused, terminalizeRecovered: unused, listPendingDeliveries: () => [], validatePendingTerminalControl: unused,
      },
    })
    await resident.start()
    const before = fs.lstatSync(resident.socketPath, { bigint: true })
    if (outcome === "failed") mocks.request.mockRejectedValueOnce(new Error("isolated transport failure"))
    try {
      const delivery = sendTelegramExternalEventDecision("sanctuary", { source: "fixture", eventId: "owned", generation: 1, text: "Fixture receipt." })
      if (outcome === "failed") await expect(delivery).rejects.toThrow("isolated transport failure")
      else await expect(delivery).resolves.toBeUndefined()
      expect(mocks.request).toHaveBeenCalledTimes(1)
      expect(mocks.request.mock.calls[0]![0]).toBe("sendMessage")
      expect(mocks.request.mock.calls[0]![1]).toMatchObject({ chat_id: "42", text: "Fixture receipt.", parse_mode: "HTML" })
      expect(mocks.stop).toHaveBeenCalledTimes(1)
      expect(mocks.run).not.toHaveBeenCalled()
      expect(fs.lstatSync(resident.socketPath, { bigint: true })).toEqual(before)
      expect(await sanctuaryInteractiveControlReady(resident.socketPath)).toBe(true)
    } finally { await resident.stop() }
  })
})
