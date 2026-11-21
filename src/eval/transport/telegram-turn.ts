/**
 * Runs one owner Telegram turn through the production path, in-process, with an injected provider: the real
 * Telegram sense (`createTelegramSenseApp`), the shared turn runner and `handleInboundTurn`, the production owner
 * relationship (`createProductionTelegramRelationshipComposition`, which reads `tool-profiles.json`), real tool
 * dispatch, and a fake Telegram transport that records what the Butler sent.
 *
 * What the pipeline needed, found by running it (slice 2's spike):
 * - The bundle must sit where the turn itself looks for it, `$HOME/AgentBundles/sanctuary.ouro`: the Telegram sense
 *   takes a root, but the shared turn runner re-derives it from `HOME`, so a bundle anywhere else splits the session
 *   in two. The container sets `HOME=/home/ouro`; the test points `HOME` at a temporary folder.
 * - One owner Friend with the `sanctuary-owner` profile, bound to the fake bot and private chat (written here), and
 *   the case prefix saved as that owner's Telegram session (written here). The Telegram identity key is created in
 *   the bundle's state on first use, as on a fresh host.
 * - `skipKeptNotes`, so the kept-notes judge does not ask for a provider of its own, and `providerRuntimeOverride`,
 *   which also empties the fallback chain. Both reach `runAgent` through the turn's `prepareRunAgentOptions` hook,
 *   after the relationship authorization is attached.
 * - Nothing from the live host. The Sanctuary tool context (Unraid, SABnzbd, Jellyfin) is left out, so those tools
 *   fail as they would with the services down, and the local interactive-control socket is not opened. Both are
 *   fidelity gaps of the sandbox, not of the books cases, which use `shell`.
 * - The owner's prompt does not list `skills/`: the relationship prompt has no skills section and `load_skill` is not
 *   in the `sanctuary-owner` profile, so a skill file reaches the model only when the agent reads it with a tool.
 */
import fs from "node:fs"
import path from "node:path"
import { FileFriendStore } from "@ouro.bot/friends"
import type { ProviderRuntime, RunAgentOptions } from "../../heart/core"
import { getAgentRoot, setAgentName } from "../../heart/identity"
import { saveSession } from "../../mind/context"
import { emitNervesEvent } from "../../nerves/runtime"
import { runSenseTurn, getSenseSessionPath, type RunSenseTurnResult } from "../../senses/shared-turn"
import { createProductionTelegramRelationshipComposition, createTelegramSenseApp, opaqueTelegramSubject } from "../../senses/telegram"
import type { TelegramInboundMessage } from "../../senses/telegram-client"
import { readOrCreateTelegramIdentityKey } from "../../senses/telegram-identity-key"
import type { Case, Observation, TraceCall } from "../domain/case"

const AGENT = "sanctuary"
const BOT_ID = "7001"
const OWNER_USER = "4242"
const OWNER_FRIEND_ID = "eval-owner"

export type TelegramTurnInput = {
  agentRoot: string
  prefix: Case["prefix"]
  userText: string
  providerRuntime: ProviderRuntime
}

export type TelegramTurnResult = Pick<Observation, "timeline" | "finalReply" | "outcome" | "steps">

async function writeOwner(agentRoot: string): Promise<void> {
  const now = new Date().toISOString()
  await new FileFriendStore(path.join(agentRoot, "friends")).put(OWNER_FRIEND_ID, {
    id: OWNER_FRIEND_ID, name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive",
    capabilityProfileId: "sanctuary-owner",
    externalIds: [{ provider: "telegram-user", externalId: OWNER_USER, tenantId: BOT_ID, linkedAt: now }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1,
  })
}

/**
 * Wraps a runtime to record the turn's tool calls in the order the model made them, each filled with the result the
 * turn handed back, and to count model calls. A Proxy, so a class-based runtime keeps its prototype methods.
 */
export function recordModelTraffic(inner: ProviderRuntime, timeline: TelegramTurnResult["timeline"]): { runtime: ProviderRuntime; steps: () => number } {
  const calls = new Map<string, TraceCall>()
  let steps = 0
  const streamTurn: ProviderRuntime["streamTurn"] = async (request) => {
    steps += 1
    const result = await inner.streamTurn(request)
    for (const call of result.toolCalls) {
      const entry: TraceCall = { kind: "call", name: call.name, args: call.arguments, result: "" }
      calls.set(call.id, entry)
      timeline.push(entry)
    }
    return result
  }
  const appendToolOutput: ProviderRuntime["appendToolOutput"] = (callId, output) => {
    Object.assign(calls.get(callId) ?? {}, { result: output })
    inner.appendToolOutput(callId, output)
  }
  const runtime = new Proxy(inner, {
    get(target, property) {
      if (property === "streamTurn") return streamTurn
      if (property === "appendToolOutput") return appendToolOutput
      const value: unknown = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { runtime, steps: () => steps }
}

const idle = async (): Promise<void> => undefined

export async function runTelegramTurn(input: TelegramTurnInput): Promise<TelegramTurnResult> {
  emitNervesEvent({ component: "eval", event: "eval.telegram_turn_start", message: "running one eval Telegram turn", meta: { steps: input.prefix.length } })
  try {
    const agentRoot = path.resolve(input.agentRoot)
    if (agentRoot !== getAgentRoot(AGENT)) throw new Error(`agentRoot must be the sanctuary bundle at ${getAgentRoot(AGENT)}, where the turn reads it`)
    setAgentName(AGENT)
    await writeOwner(agentRoot)
    const identityKey = readOrCreateTelegramIdentityKey(agentRoot)
    const sessionKey = `telegram:${opaqueTelegramSubject(identityKey, BOT_ID, OWNER_USER, OWNER_USER)}`
    const sessionPath = getSenseSessionPath(AGENT, OWNER_FRIEND_ID, "telegram", sessionKey, agentRoot)
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    saveSession(sessionPath, [{ role: "system", content: "" }, ...input.prefix])

    const timeline: TelegramTurnResult["timeline"] = []
    const recorded = recordModelTraffic(input.providerRuntime, timeline)
    let messageId = 1
    const api = {
      request: async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
        if (method === "sendMessage") timeline.push({ kind: "reply", text: String(body.text) })
        return { message_id: messageId++ } as T
      },
      stop: () => undefined,
    }
    const credentials = { botToken: `${BOT_ID}:eval-token`, authorizedUserId: OWNER_USER, authorizedChatId: OWNER_USER }
    let turn: RunSenseTurnResult | undefined
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    const app = createTelegramSenseApp({
      agentName: AGENT,
      credentials,
      identityKey,
      _agentRoot: agentRoot,
      _toolContext: { agentRoot } as never,
      api,
      createLongPoll: (options) => {
        onMessage = options.onMessage
        return { pollOnce: idle, run: idle, stop: idle } as never
      },
      _createInteractiveControl: (() => ({ socketPath: "unused", start: idle, stop: idle })) as never,
      migrateIdentity: idle,
      ...(await createProductionTelegramRelationshipComposition(AGENT, credentials, agentRoot)),
      _runTurn: async (options) => {
        turn = await runSenseTurn({
          ...options,
          prepareRunAgentOptions: async (prepare) => ({
            ...(await options.prepareRunAgentOptions!(prepare) as RunAgentOptions),
            providerRuntimeOverride: recorded.runtime,
            skipKeptNotes: true,
          }),
        })
        return turn
      },
    })
    try {
      await onMessage({ updateId: 1, messageId: "1", userId: OWNER_USER, chatId: OWNER_USER, text: input.userText })
    } finally {
      await app.stop()
    }
    const result: TelegramTurnResult = {
      timeline,
      finalReply: timeline.flatMap((entry) => entry.kind === "reply" ? [entry.text] : []).slice(-1).join(""),
      outcome: String(turn!.turnOutcome),
      steps: recorded.steps(),
    }
    emitNervesEvent({ component: "eval", event: "eval.telegram_turn_end", message: "eval Telegram turn finished", meta: { outcome: result.outcome, steps: result.steps } })
    return result
  } catch (error) {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.telegram_turn_error", message: "eval Telegram turn failed", meta: { error: (error as Error).message } })
    throw error
  }
}
