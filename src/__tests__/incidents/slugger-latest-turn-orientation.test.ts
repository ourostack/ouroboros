import { afterEach, expect, it, vi } from "vitest"
import type OpenAI from "openai"
import * as fs from "node:fs"
import * as path from "node:path"

import { applyPromptBudget } from "../../mind/prompt-budget"
import {
  createBlueBubblesCallbacks,
} from "../../senses/bluebubbles"
import { buildBlueBubblesContextPacket } from "../../senses/bluebubbles/context-packet"
import {
  __resetBlueBubblesLatestTurnsForTests,
  awaitDeliveryAdmission,
  finish,
  isCurrent,
  promote,
  reserveObservation,
} from "../../senses/bluebubbles/latest-turn"
import type { BlueBubblesNormalizedMessage } from "../../senses/bluebubbles/model"
import { classifyBlueBubblesReaction } from "../../senses/bluebubbles/reaction-policy"

const CHAT_GUID = "iMessage;-;ari@synthetic.test"
const CHAT_IDENTIFIER = "ari@synthetic.test"
const REQUEST_AT = Date.parse("2026-08-12T18:05:00.000Z")
const REQUEST_TEXT = "hey slugger wedding has happened, we can end this report :) thanks my dude"
const RSVP_TEXT = [
  "RSVP Update — Ari & Rachel",
  "No changes since last check.",
  "147 attending / 126 declined / 0 pending",
].join("\n")
const GROUNDED_REPLY = "got it — wedding happened, ending the daily RSVP report. congrats to you both 💜"

function message(input: {
  guid: string
  timestamp: number
  text: string
  fromMe: boolean
}): BlueBubblesNormalizedMessage {
  return {
    kind: "message",
    eventType: "new-message",
    messageGuid: input.guid,
    timestamp: input.timestamp,
    fromMe: input.fromMe,
    sender: {
      provider: "imessage-handle",
      externalId: input.fromMe ? "shared-account@synthetic.test" : CHAT_IDENTIFIER,
      rawId: input.fromMe ? "shared-account@synthetic.test" : CHAT_IDENTIFIER,
      displayName: input.fromMe ? "" : "Ari",
      observed: !input.fromMe,
    },
    chat: {
      chatGuid: CHAT_GUID,
      chatIdentifier: CHAT_IDENTIFIER,
      isGroup: false,
      sessionKey: `chat:${CHAT_GUID}`,
      sendTarget: { kind: "chat_guid", value: CHAT_GUID },
      participantHandles: [CHAT_IDENTIFIER],
    },
    text: input.text,
    textForAgent: input.text,
    attachments: [],
    hasPayloadData: false,
    requiresRepair: false,
  }
}

afterEach(() => {
  __resetBlueBubblesLatestTurnsForTests()
  vi.useRealTimers()
})

it("keeps capture-only reactions free of orphaned inference, target lookup, and progress timers", () => {
  const sourceByPath = new Map([
    ["src/heart/core.ts", fs.readFileSync(path.join(process.cwd(), "src/heart/core.ts"), "utf8")],
    ["src/repertoire/tools.ts", fs.readFileSync(path.join(process.cwd(), "src/repertoire/tools.ts"), "utf8")],
    ["src/senses/bluebubbles/index.ts", fs.readFileSync(path.join(process.cwd(), "src/senses/bluebubbles/index.ts"), "utf8")],
    ["src/senses/bluebubbles/client.ts", fs.readFileSync(path.join(process.cwd(), "src/senses/bluebubbles/client.ts"), "utf8")],
  ])
  const forbidden = [
    "restrictedReactionFeedback",
    "getRestrictedReactionFeedbackTools",
    "resolveReactionTarget",
    "getMessageDetails",
    "createStatusBatcher",
    "restricted_feedback_",
  ]

  for (const [sourcePath, source] of sourceByPath) {
    for (const token of forbidden) {
      expect(source, `${sourcePath} must not retain ${token}`).not.toContain(token)
    }
  }
})

it("replays the RSVP request, grounded response, and later reaction without losing causal orientation", async () => {
  __resetBlueBubblesLatestTurnsForTests()
  const currentEvent = message({
    guid: "synthetic-current-request",
    timestamp: REQUEST_AT,
    text: REQUEST_TEXT,
    fromMe: false,
  })
  const predecessor = message({
    guid: "synthetic-rsvp-predecessor",
    timestamp: REQUEST_AT - 60_000,
    text: RSVP_TEXT,
    fromMe: true,
  })
  const queryRecentMessagesWithMetadata = vi.fn().mockResolvedValue({
    messages: [currentEvent, predecessor],
    rawRowCount: 2,
    normalizedRowCount: 2,
    skippedRowCount: 0,
    invalidCausalTimestampRowCount: 0,
    request: {
      limit: 41,
      offset: 0,
      sort: "DESC",
      chatGuid: CHAT_GUID,
      beforeTimestamp: REQUEST_AT,
    },
  })

  const context = await buildBlueBubblesContextPacket({
    agentName: "synthetic-slugger",
    client: { queryRecentMessagesWithMetadata },
    event: currentEvent,
  })

  expect(queryRecentMessagesWithMetadata).toHaveBeenCalledWith({
    beforeTimestamp: REQUEST_AT,
    limit: 41,
    offset: 0,
    chatGuid: CHAT_GUID,
  })
  expect(context).not.toBeNull()
  if (!context) throw new Error("synthetic context was not verified")
  const evidence = String(context.verifiedPredecessorMessage.content)
  const evidenceJson = JSON.parse(evidence.split("\n").slice(1).join("\n"))
  expect(evidenceJson.predecessor.body).toBe(RSVP_TEXT)
  expect(evidence).toContain('"direction":"shared-account outbound"')
  expect(evidence).toContain('"agentAuthorship":"unverified"')
  expect(evidence).not.toMatch(/Rachel (said|read|saw|was seeing|is at|was at|located)/i)
  expect(evidence).not.toMatch(/restart|woke[- ]?up|shelly unstuck|glitch/i)

  const currentUserMessage = Object.freeze<OpenAI.ChatCompletionUserMessageParam>({
    role: "user",
    content: REQUEST_TEXT,
  })
  const providerMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: "current synthetic system prompt" },
    context.verifiedPredecessorMessage,
    currentUserMessage,
  ]
  const budgeted = applyPromptBudget({
    messages: providerMessages,
    requiredPromptEvidence: {
      currentUserMessage,
      verifiedPredecessorMessage: context.verifiedPredecessorMessage,
    },
    provider: "minimax",
    model: "synthetic-model",
    contextWindowTokens: 1_000,
  })
  const predecessorIndex = budgeted.messages.indexOf(context.verifiedPredecessorMessage)
  const currentIndex = budgeted.messages.indexOf(currentUserMessage)
  expect(predecessorIndex).toBeGreaterThanOrEqual(0)
  expect(currentIndex).toBe(predecessorIndex + 1)
  expect(budgeted.messages[predecessorIndex]).toBe(context.verifiedPredecessorMessage)
  expect(budgeted.messages[currentIndex]).toBe(currentUserMessage)

  const requestReservation = reserveObservation({
    chatGuid: CHAT_GUID,
    chatIdentifier: CHAT_IDENTIFIER,
  })
  const requestPromotion = promote(requestReservation, {
    chatGuid: CHAT_GUID,
    chatIdentifier: CHAT_IDENTIFIER,
  })
  expect(requestPromotion.status).toBe("promoted")
  if (requestPromotion.status !== "promoted") throw new Error("synthetic request was not promoted")
  const requestCapability = requestPromotion.capability

  const sendText = vi.fn(async () => ({ messageGuid: "synthetic-visible-response" }))
  const persistCanonicalProjection = vi.fn()
  const callbacks = createBlueBubblesCallbacks(
    {
      sendText,
      editMessage: vi.fn(),
      setTyping: vi.fn(async () => {}),
      markChatRead: vi.fn(async () => {}),
      checkHealth: vi.fn(async () => {}),
      repairEvent: vi.fn(async (event) => event),
      getMessageText: vi.fn(async () => null),
    } as any,
    currentEvent.chat,
    {
      getReplyToMessageGuid: () => currentEvent.messageGuid,
      setSelection: () => "ok",
    },
    false,
    undefined,
    {
      enableActivitySignals: false,
      isOutboundCurrent: () => isCurrent(requestCapability),
      admitOutbound: () => awaitDeliveryAdmission(requestCapability),
    },
  )
  requestCapability.signal.addEventListener("abort", () => callbacks.cancelOutbound("superseded"), { once: true })

  callbacks.onModelStart()
  callbacks.onTextChunk(GROUNDED_REPLY)
  await expect(callbacks.flush()).resolves.toEqual({ status: "accepted" })
  if (isCurrent(requestCapability)) {
    persistCanonicalProjection([
      currentUserMessage,
      { role: "assistant", content: GROUNDED_REPLY },
    ])
  }
  expect(sendText).toHaveBeenCalledTimes(1)
  expect(persistCanonicalProjection).toHaveBeenCalledTimes(1)

  const reactionReservation = reserveObservation({
    chatGuid: CHAT_GUID,
    chatIdentifier: CHAT_IDENTIFIER,
  })
  const reactionDecision = classifyBlueBubblesReaction({
    fromMe: false,
    action: "add",
    canonicalValue: "love",
  })
  const reactionPromotion = promote(reactionReservation, {
    chatGuid: CHAT_GUID,
    chatIdentifier: CHAT_IDENTIFIER,
  })

  expect(reactionDecision).toEqual({ route: "capture_only", outcome: "capture_only_positive" })
  expect(reactionPromotion.status).toBe("promoted")
  expect(requestCapability.signal.aborted).toBe(true)
  expect(isCurrent(requestCapability)).toBe(false)

  callbacks.onTextChunk("oh wait — that was a restart glitch and Rachel was reading something")
  await expect(callbacks.flush()).resolves.toEqual({ status: "not_invoked", reason: "closed" })
  if (isCurrent(requestCapability)) {
    persistCanonicalProjection([{ role: "assistant", content: "late stale result" }])
  }
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  await callbacks.finish()

  expect(sendText.mock.calls.map((call) => call[0]?.text)).toEqual([GROUNDED_REPLY])
  expect(sendText).not.toHaveBeenCalledWith(expect.objectContaining({ text: "still working on this..." }))
  expect(persistCanonicalProjection).toHaveBeenCalledTimes(1)

  if (reactionPromotion.status === "promoted") finish(reactionPromotion.capability)
})
