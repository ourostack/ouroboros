import { beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()
const setAgentName = vi.fn()
const resetIdentity = vi.fn()
const getAgentRoot = vi.fn(() => "/agents/slugger.ouro")
const loadOrCreateMachineIdentity = vi.fn(() => ({ machineId: "machine-test" }))
const refreshMachineRuntimeCredentialConfig = vi.fn().mockResolvedValue(undefined)
const normalizeBlueBubblesEvent = vi.fn()
const repairEvent = vi.fn()
const queryRecentMessagesWithMetadata = vi.fn()
const createBlueBubblesClient = vi.fn(() => ({ repairEvent, queryRecentMessagesWithMetadata }))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => emitNervesEvent(...args),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: (...args: any[]) => getAgentRoot(...args),
  setAgentName: (...args: any[]) => setAgentName(...args),
  resetIdentity: (...args: any[]) => resetIdentity(...args),
}))

vi.mock("../../../heart/machine-identity", () => ({
  loadOrCreateMachineIdentity: (...args: any[]) => loadOrCreateMachineIdentity(...args),
}))

vi.mock("../../../heart/runtime-credentials", () => ({
  refreshMachineRuntimeCredentialConfig: (...args: any[]) => refreshMachineRuntimeCredentialConfig(...args),
}))

vi.mock("../../../senses/bluebubbles/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../senses/bluebubbles/model")>()),
  normalizeBlueBubblesEvent: (...args: any[]) => normalizeBlueBubblesEvent(...args),
}))

vi.mock("../../../senses/bluebubbles/client", () => ({
  createBlueBubblesClient: (...args: any[]) => createBlueBubblesClient(...args),
}))

function message(overrides: Partial<any> = {}) {
  const timestamp = overrides.timestamp ?? Date.parse("2026-07-09T19:25:00.000Z")
  return {
    kind: "message" as const,
    eventType: "new-message",
    messageGuid: overrides.messageGuid ?? "anchor-guid",
    timestamp,
    fromMe: false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: "ari@mendelow.me",
      rawId: "ari@mendelow.me",
      displayName: "Ari",
    },
    chat: {
      chatGuid: "any;+;thread-guid",
      chatIdentifier: "thread-guid",
      isGroup: true,
      sessionKey: "chat:any;+;thread-guid",
      sendTarget: { kind: "chat_guid" as const, value: "any;+;thread-guid" },
      participantHandles: ["ari@mendelow.me"],
    },
    text: overrides.text ?? "anchor body",
    textForAgent: overrides.textForAgent ?? overrides.text ?? "anchor body",
    attachments: [],
    hasPayloadData: false,
    requiresRepair: false,
  }
}

function queryResult(anchor: ReturnType<typeof message>, history: ReturnType<typeof message>[]) {
  const messages = [anchor, ...history]
  return {
    messages,
    rawRowCount: messages.length,
    normalizedRowCount: messages.length,
    skippedRowCount: 0,
    invalidCausalTimestampRowCount: 0,
    request: {
      limit: 41,
      offset: 0,
      sort: "DESC" as const,
      chatGuid: anchor.chat.chatGuid,
      beforeTimestamp: anchor.timestamp,
    },
  }
}

describe("BlueBubbles context smoke default wiring", () => {
  beforeEach(() => {
    emitNervesEvent.mockReset()
    setAgentName.mockReset()
    resetIdentity.mockReset()
    getAgentRoot.mockClear()
    loadOrCreateMachineIdentity.mockClear()
    refreshMachineRuntimeCredentialConfig.mockClear()
    normalizeBlueBubblesEvent.mockReset()
    repairEvent.mockReset()
    queryRecentMessagesWithMetadata.mockReset()
    createBlueBubblesClient.mockClear()
  })

  it("uses default identity, credential refresh, normalizer, and live client wiring", async () => {
    const anchor = message()
    const prior = message({
      messageGuid: "prior-guid",
      timestamp: Date.parse("2026-07-09T19:23:00.000Z"),
      text: "prior context body",
    })
    normalizeBlueBubblesEvent.mockReturnValue(message({ messageGuid: "anchor-guid", requiresRepair: true }))
    repairEvent.mockResolvedValue(anchor)
    queryRecentMessagesWithMetadata.mockResolvedValue(queryResult(anchor, [prior]))

    const { smokeBlueBubblesContext } = await import("../../../senses/bluebubbles/context-smoke")
    const result = await smokeBlueBubblesContext({
      agentName: "slugger",
      messageGuid: "anchor-guid",
    })

    expect(loadOrCreateMachineIdentity).toHaveBeenCalledTimes(1)
    expect(refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith(
      "slugger",
      "machine-test",
      { preserveCachedOnFailure: true },
    )
    expect(createBlueBubblesClient).toHaveBeenCalledTimes(1)
    expect(normalizeBlueBubblesEvent).toHaveBeenCalledWith({
      type: "new-message",
      data: {
        guid: "anchor-guid",
        hasPayloadData: true,
      },
    })
    expect(setAgentName).toHaveBeenCalledWith("slugger")
    expect(resetIdentity).toHaveBeenCalledTimes(1)
    expect(result.contextMessages).toBe(1)
  })
})
