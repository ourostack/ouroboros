/**
 * Runs one owner Telegram turn through the production path, in-process, with an injected provider: the real
 * Telegram sense (`createTelegramSenseApp`), the shared turn runner and `handleInboundTurn`, the production owner
 * relationship (`createProductionTelegramRelationshipComposition`, which reads `tool-profiles.json`), the Sanctuary
 * answer checks at settle, real tool dispatch, and a fake Telegram transport that records what the Butler sent.
 *
 * Run it only inside the eval sandbox. The owner profile offers `shell`, `fetch_url`, `web_search`, `bundle_push`
 * and `send_message`, and in the process that runs the turn those tools are real.
 *
 * What the pipeline needed, found by running it (slice 2's spike):
 * - The bundle must sit where the turn itself looks for it, `$HOME/AgentBundles/sanctuary.ouro`: the Telegram sense
 *   takes a root, but the shared turn runner re-derives it from `HOME`, so a bundle anywhere else splits the session
 *   in two. The container sets `HOME=/home/ouro`; the test points `HOME` at a temporary folder.
 * - One owner Friend with the `sanctuary-owner` profile, bound to the fake bot and private chat, and the case prefix
 *   saved as that owner's Telegram session. Both are written here. The Telegram identity key is created in the
 *   bundle's state on first use, as on a fresh host.
 * - `skipKeptNotes`, so the kept-notes judge does not ask for a provider of its own, and `providerRuntimeOverride`,
 *   which also empties the fallback chain. Both reach `runAgent` through the turn's `prepareRunAgentOptions` hook,
 *   after the relationship authorization is attached.
 * - No retry of a provider error. Core retries an error unless it says `retryable: false`, and each retry refreshes
 *   the agent's credentials and rebuilds its runtime from `agent.json`, dropping the override. Every error from the
 *   injected runtime is marked not retryable, so a turn makes one call per step and never reaches a real provider.
 * - Nothing from the live host. The Sanctuary service context (Unraid, SABnzbd, Jellyfin) is synthetic
 *   (`synthetic-sanctuary.ts`): reads return fixed data, a restart or queue resume reports unavailable; the local
 *   interactive-control socket is not opened.
 *
 * What the turn writes in the bundle: `friends/eval-owner.json`, the session under `state/sessions/`, the identity
 * key and other runtime state under `state/`, and the flight recorder under `arc/`. A bundle runs one turn: the
 * message ids are fixed, so a second run on the same bundle fails. Bundle sync is on in `agent.json` and does
 * nothing only because the bundle is not a Git repository; a projection must not carry `.git`.
 *
 * Fidelity gaps: `sandbox/declared-gaps.ts` lists them, so every report does.
 */
import fs from "node:fs"
import path from "node:path"
import { FileFriendStore } from "@ouro.bot/friends"
import type { ProviderRuntime, RunAgentOptions } from "../../heart/core"
import { getAgentRoot, setAgentName } from "../../heart/identity"
import { saveSession } from "../../mind/context"
import { emitNervesEvent } from "../../nerves/runtime"
import { SANCTUARY_ANSWER_GATES } from "../../senses/sanctuary-runtime"
import { runSenseTurn, getSenseSessionPath, type RunSenseTurnResult } from "../../senses/shared-turn"
import { createProductionTelegramRelationshipComposition, createTelegramSenseApp, opaqueTelegramSubject } from "../../senses/telegram"
import type { TelegramInboundMessage } from "../../senses/telegram-client"
import { readOrCreateTelegramIdentityKey } from "../../senses/telegram-identity-key"
import type { Case, Observation, TraceCall, TraceReply } from "../domain/case"
import { createSyntheticSanctuary } from "./synthetic-sanctuary"

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
    let result: Awaited<ReturnType<ProviderRuntime["streamTurn"]>>
    try {
      result = await inner.streamTurn(request)
    } catch (error) {
      // Never retried: a retry is another billed call, and core's retry rebuilds the runtime from the agent's own
      // credentials, which would drop this override.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable: false })
    }
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" }

/** Telegram HTML as sent, back to the text the person reads. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_match, name: string) => ENTITIES[name]!)
}

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
    const withButtons = new Map<TraceReply, boolean>()
    let messageId = 1
    const api = {
      request: async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
        if (method === "sendMessage") {
          const entry: TraceReply = { kind: "reply", text: visibleText(String(body.text)) }
          timeline.push(entry)
          // A message with buttons (an approval card) is not part of the answer.
          withButtons.set(entry, Boolean(body.reply_markup))
        }
        return { message_id: messageId++ } as T
      },
      stop: () => undefined,
    }
    const credentials = { botToken: `${BOT_ID}:eval-token`, authorizedUserId: OWNER_USER, authorizedChatId: OWNER_USER }
    let turn: RunSenseTurnResult | undefined
    let turnError: unknown
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    const app = createTelegramSenseApp({
      agentName: AGENT,
      credentials,
      identityKey,
      _agentRoot: agentRoot,
      _toolContext: { agentRoot, answerGates: SANCTUARY_ANSWER_GATES, sanctuary: createSyntheticSanctuary() } as never,
      api,
      createLongPoll: (options) => {
        onMessage = options.onMessage
        return { pollOnce: idle, run: idle, stop: idle } as never
      },
      _createInteractiveControl: (() => ({ socketPath: "unused", start: idle, stop: idle })) as never,
      migrateIdentity: idle,
      ...(await createProductionTelegramRelationshipComposition(AGENT, credentials, agentRoot)),
      _runTurn: async (options) => {
        try {
          turn = await runSenseTurn({
            ...options,
            prepareRunAgentOptions: async (prepare) => ({
              ...(await options.prepareRunAgentOptions!(prepare) as RunAgentOptions),
              providerRuntimeOverride: recorded.runtime,
              skipKeptNotes: true,
            }),
          })
          return turn
        } catch (error) {
          // The sense reports a failed turn to the person and carries on; the eval needs the failure itself.
          turnError = error
          throw error
        }
      },
    })
    try {
      await onMessage({ updateId: 1, messageId: "1", userId: OWNER_USER, chatId: OWNER_USER, text: input.userText })
    } finally {
      await app.stop()
    }
    if (turnError) throw turnError
    // A bundle that already answered this message has its outcome recorded, and the sense does not run it again.
    if (!turn) throw new Error("the sense did not run the turn: this bundle already has an outcome for its message, so use a fresh bundle")
    // The answer is every message sent after the model's last tool call: Telegram splits a long one into several.
    const lastCall = timeline.findLastIndex((entry) => entry.kind === "call")
    const result: TelegramTurnResult = {
      timeline,
      finalReply: (timeline.slice(lastCall + 1) as TraceReply[]).filter((entry) => !withButtons.get(entry)).map((entry) => entry.text).join("\n"),
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
