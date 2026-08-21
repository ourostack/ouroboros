import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createLogger, type LogEvent } from "../../nerves"
import { setRuntimeLogger } from "../../nerves/runtime"
import { digestJson, validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"
import { resolveToolDefinition } from "../../repertoire/tools"
import { createTelegramApprovalRuntime } from "../../senses/telegram-approval-runtime"
import { sanctuaryTelegramApprovalEvidenceMac, type TelegramUpdate } from "../../senses/telegram"
import { TelegramApiError, type TelegramBotApi } from "../../senses/telegram-client"

const identityKey = "k".repeat(43)
const scenarioHandleDigest = "a".repeat(64)
const subject = `tg_${"s".repeat(43)}`
const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-production-"))
  roots.push(value)
  return value
}

function proposalRequest() {
  const definition = resolveToolDefinition("unraid_restart_container")!
  const args = { container: "calibre-web" }
  const validated = validateAdvertisedToolArguments(JSON.stringify(args), definition.tool.function.parameters!)
  if (!validated.ok) throw new Error(validated.reason)
  const policy = definition.approvalPolicy!(args)
  if (policy.kind !== "required") throw new Error("restart policy is not protected")
  return {
    toolCall: { id: "call-restart", type: "function", function: { name: "unraid_restart_container", arguments: JSON.stringify(args) } },
    arguments: args,
    schemaDigest: validated.value.schemaDigest,
    toolDigest: digestJson({ name: "unraid_restart_container", schemaDigest: validated.value.schemaDigest, policyId: policy.policyId }),
    policyDigest: digestJson({ policyId: policy.policyId, actionClass: policy.actionClass, classification: "required" }),
    policyId: policy.policyId,
    frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-restart", type: "function", function: { name: "unraid_restart_container", arguments: JSON.stringify(args) } }] },
    preCallMessages: [{ role: "user", content: "restart calibre-web" }],
  } as const
}

function callback(data: string, queryId = "query-1"): TelegramUpdate {
  return { update_id: 1, callback_query: { id: queryId, from: { id: 42 }, data, message: { message_id: 101, chat: { id: 43 } } } }
}

function pending(agentRoot: string): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "approvals", "telegram-pending.json"), "utf8")) as Array<Record<string, unknown>>
}

afterEach(() => {
  setRuntimeLogger(null)
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("production-composed Telegram approval lifecycle", () => {
  it("binds a delayed approval through real durable stores, executes once, resumes, delivers, and terminalizes causally", async () => {
    const agentRoot = root()
    const sessionPath = path.join(agentRoot, "state", "sessions", "telegram.json")
    const emptyRevision = createHash("sha256").update("").digest("hex")
    const clock = { value: 1_000_000 }
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ sinks: [(event) => events.push(event)], now: () => new Date(clock.value) }))
    let messageId = 100
    let mutationCount = 0
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async (method) => {
        if (method === "sendMessage") { clock.value += 1; messageId += 1; return { message_id: messageId } }
        clock.value += 1
        return true
      }),
    }
    const runtime = createTelegramApprovalRuntime({
      agentName: "sanctuary", api, authorizedUserId: "42", authorizedChatId: "43", subject, identityKey, toolContext: {},
      dependencies: {
        agentRoot,
        now: () => clock.value,
        acceptanceMarker: () => ({ scenarioHandleDigest }),
        executeTool: async () => {
          mutationCount += 1
          clock.value += 1
          return JSON.stringify({ ok: true, data: { container: { id: "container-1", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } })
        },
        runProvider: async (_messages, callbacks) => {
          clock.value += 1
          callbacks.onTextChunk("Restart observed complete")
          return { outcome: "settled" }
        },
      },
    })
    const suspension = await runtime.coordinator({ sessionPath, baseSessionRevision: emptyRevision }).propose(proposalRequest() as never)
    const bound = pending(agentRoot)[0]!
    expect(bound).toMatchObject({ approvalId: suspension.approvalId, deliveryState: "bound", messageId: "101" })

    clock.value = Number(bound.expiresAt) - 120_000
    const result = await runtime.transport.handleUpdate(callback(String(bound.approveCallbackData)))
    expect(result).toMatchObject({ accepted: true, reason: "accepted" })
    expect(mutationCount).toBe(1)
    expect(pending(agentRoot)).toEqual([])

    const byName = (name: string) => events.find((event) => event.event === name)!
    const prompt = byName("senses.telegram_approval_prompt_bound")
    const continuation = byName("senses.telegram_approval_continuation_delivered")
    const terminal = byName("telegram.approval_prompt_terminalized")
    const settled = byName("telegram.callback_settled")
    for (const event of [prompt, continuation, terminal, settled]) {
      expect(event.meta.checkpointDigest).toBe(suspension.checkpointDigest)
      expect(event.meta.suspendedSessionRevisionDigest).toBe(createHash("sha256").update(suspension.suspendedSessionRevision).digest("hex"))
      expect(event.meta.evidenceMac).toBe(sanctuaryTelegramApprovalEvidenceMac(identityKey, event.event, event.meta))
    }
    expect(Number(settled.meta.callbackAt)).toBeLessThanOrEqual(Number(continuation.meta.deliveredAt))
    expect(Number(continuation.meta.deliveredAt)).toBeLessThanOrEqual(Number(terminal.meta.terminalEditStartedAt))
    expect(Number(terminal.meta.terminalEditStartedAt)).toBeLessThanOrEqual(Number(terminal.meta.terminalizedAt))
    await runtime.transport.handleUpdate(callback(String(bound.approveCallbackData), "query-duplicate"))
    expect(mutationCount).toBe(1)
    runtime.close()
  })

  it("recovers an expired prompt after restart, retries primary and fallback edits, and consumes one authenticated stale tap", async () => {
    const agentRoot = root()
    const sessionPath = path.join(agentRoot, "state", "sessions", "telegram-expiry.json")
    const emptyRevision = createHash("sha256").update("").digest("hex")
    const clock = { value: 2_000_000 }
    const events: LogEvent[] = []
    setRuntimeLogger(createLogger({ sinks: [(event) => events.push(event)], now: () => new Date(clock.value) }))
    let firstEditAttempt = true
    let mutationCount = 0
    const api = (recovering: boolean): TelegramBotApi => ({
      stop: vi.fn(),
      request: vi.fn(async (method, body) => {
        if (method === "sendMessage") return { message_id: 101 }
        if (method === "editMessageText" && body.parse_mode === "HTML") throw new TelegramApiError("HTML rejected", { status: 400 })
        if (method === "editMessageText" && !recovering && firstEditAttempt) {
          firstEditAttempt = false
          throw new TelegramApiError("fallback unavailable", { status: 503 })
        }
        return true
      }),
    })
    const dependencies = {
      agentRoot,
      now: () => clock.value,
      acceptanceMarker: () => ({ scenarioHandleDigest }),
      executeTool: async () => { mutationCount += 1; throw new Error("expired approval executed") },
      runProvider: async () => { throw new Error("expired approval resumed provider work") },
    }
    const first = createTelegramApprovalRuntime({ agentName: "sanctuary", api: api(false), authorizedUserId: "42", authorizedChatId: "43", subject, identityKey, toolContext: {}, dependencies })
    await first.coordinator({ sessionPath, baseSessionRevision: emptyRevision }).propose(proposalRequest() as never)
    const bound = pending(agentRoot)[0]!
    clock.value = Number(bound.expiresAt)
    await expect(first.transport.reconcileExpired()).rejects.toThrow("fallback unavailable")
    expect(pending(agentRoot)[0]).toMatchObject({ deliveryState: "bound" })
    first.close()

    const second = createTelegramApprovalRuntime({ agentName: "sanctuary", api: api(true), authorizedUserId: "42", authorizedChatId: "43", subject, identityKey, toolContext: {}, dependencies })
    await second.recover()
    expect(pending(agentRoot)).toEqual([expect.objectContaining({ deliveryState: "terminal_tombstone", messageId: "101" })])
    await second.transport.handleUpdate(callback(String(bound.approveCallbackData), "query-stale"))
    const stale = events.filter((event) => event.event === "telegram.approval_stale_callback_settled")
    expect(stale).toHaveLength(1)
    expect(stale[0]!.meta.evidenceMac).toBe(sanctuaryTelegramApprovalEvidenceMac(identityKey, stale[0]!.event, stale[0]!.meta))
    expect(pending(agentRoot)).toEqual([])
    await second.transport.handleUpdate(callback(String(bound.approveCallbackData), "query-stale-again"))
    expect(events.filter((event) => event.event === "telegram.approval_stale_callback_settled")).toHaveLength(1)
    expect(mutationCount).toBe(0)
    second.close()
  })
})
