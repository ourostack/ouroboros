export interface TelegramApprovalDecision {
  approvalId: string
  decisionToken: string
  decision: "approve" | "deny"
  requesterId: string
  transport: "telegram"
  transportChatId: string
  transportMessageId: string
}

export interface TelegramApprovalUpdate {
  update_id: number
  callback_query?: {
    id: string
    from: { id: number }
    data?: string
    message?: {
      message_id: number
      chat: { id: number }
    }
  }
}

interface TelegramApiEnvelope {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

interface PendingApproval {
  approvalId: string
  decisionToken?: string
  messageId: string
  approveCallbackData: string
  denyCallbackData: string
  expiresAt: string
  terminal?: { accepted: boolean; terminalText: string }
}

export type TelegramPersistedPendingApproval = Omit<PendingApproval, "decisionToken">

export interface TelegramPendingApprovalStore {
  load(): TelegramPersistedPendingApproval[]
  save(records: TelegramPersistedPendingApproval[]): void
}

export interface TelegramApprovalAdapterOptions {
  botToken: string
  expectedUserId: string
  expectedChatId: string
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  sleep: (milliseconds: number) => Promise<void>
  createOpaqueHandle: () => string
  onDecision: (decision: TelegramApprovalDecision) => Promise<{ accepted: boolean; terminalText: string }>
  pendingStore?: TelegramPendingApprovalStore
  resolveDecisionToken?: (approvalId: string) => Promise<string>
}

export interface TelegramApprovalAdapter {
  sendApproval(input: {
    approvalId: string
    decisionToken: string
    prompt: string
    expiresAt: string
  }): Promise<{ messageId: string; approveCallbackData: string; denyCallbackData: string }>
  handleUpdate(update: TelegramApprovalUpdate): Promise<{ handled: boolean; accepted: boolean; reason: string }>
}

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function assertCallbackData(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes > 64) throw new Error("Telegram callback_data must be at most 64 bytes")
}

function parseEnvelope(value: unknown): TelegramApiEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Telegram returned an invalid response")
  return value as TelegramApiEnvelope
}

export function createTelegramApprovalAdapter(options: TelegramApprovalAdapterOptions): TelegramApprovalAdapter {
  const pendingByCallback = new Map<string, PendingApproval>()
  const apiRoot = `https://api.telegram.org/bot${options.botToken}`

  const persistPending = (): void => {
    if (!options.pendingStore) return
    const unique = [...new Set(pendingByCallback.values())]
    options.pendingStore.save(unique.map(({ decisionToken: _decisionToken, ...record }) => record))
  }

  const addPending = (pending: PendingApproval): void => {
    pendingByCallback.set(pending.approveCallbackData, pending)
    pendingByCallback.set(pending.denyCallbackData, pending)
  }

  const removePending = (pending: PendingApproval): void => {
    pendingByCallback.delete(pending.approveCallbackData)
    pendingByCallback.delete(pending.denyCallbackData)
  }

  for (const pending of options.pendingStore?.load() ?? []) {
    assertCallbackData(pending.approveCallbackData)
    assertCallbackData(pending.denyCallbackData)
    if (pendingByCallback.has(pending.approveCallbackData) || pendingByCallback.has(pending.denyCallbackData)) {
      throw new Error("Telegram persisted approval callback handle collision")
    }
    addPending(pending)
  }

  const request = async (method: string, body: Record<string, unknown>): Promise<TelegramApiEnvelope> => {
    for (;;) {
      const response = await options.fetch(`${apiRoot}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const envelope = parseEnvelope(await response.json())
      if (response.status === 429 && typeof envelope.parameters?.retry_after === "number") {
        await options.sleep(envelope.parameters.retry_after * 1_000)
        continue
      }
      if (!response.ok || envelope.ok !== true) {
        throw Object.assign(new Error(envelope.description ?? `Telegram ${method} failed with ${response.status}`), {
          status: response.status,
        })
      }
      return envelope
    }
  }

  const requestWithHtmlFallback = async (
    method: string,
    htmlBody: Record<string, unknown>,
    plainBody: Record<string, unknown>,
  ): Promise<TelegramApiEnvelope> => {
    try {
      return await request(method, htmlBody)
    } catch (error) {
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 400) throw error
      return request(method, plainBody)
    }
  }

  const isMessageNotModified = (error: unknown): boolean => error instanceof Error
    && "status" in error
    && error.status === 400
    && /message is not modified/i.test(error.message)

  const editTerminalMessage = async (
    htmlBody: Record<string, unknown>,
    plainBody: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await request("editMessageText", htmlBody)
    } catch (error) {
      if (isMessageNotModified(error)) return
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 400) throw error
      try {
        await request("editMessageText", plainBody)
      } catch (fallbackError) {
        if (!isMessageNotModified(fallbackError)) throw fallbackError
      }
    }
  }

  const acknowledge = async (callbackQueryId: string, invalid: boolean): Promise<void> => {
    try {
      await request("answerCallbackQuery", invalid ? {
        callback_query_id: callbackQueryId,
        text: "This approval is no longer valid.",
        show_alert: true,
      } : { callback_query_id: callbackQueryId })
    } catch (error) {
      const staleQuery = error instanceof Error
        && "status" in error
        && error.status === 400
        && /query is too old|query ID is invalid/i.test(error.message)
      if (!staleQuery) throw error
    }
  }

  return {
    async sendApproval(input) {
      const approveCallbackData = `a:${options.createOpaqueHandle()}`
      const denyCallbackData = `d:${options.createOpaqueHandle()}`
      assertCallbackData(approveCallbackData)
      assertCallbackData(denyCallbackData)
      if (pendingByCallback.has(approveCallbackData) || pendingByCallback.has(denyCallbackData)) {
        throw new Error("Telegram approval callback handle collision")
      }
      const replyMarkup = {
        inline_keyboard: [[
          { text: "Approve", callback_data: approveCallbackData },
          { text: "Deny", callback_data: denyCallbackData },
        ]],
      }
      const htmlBody = {
        chat_id: options.expectedChatId,
        text: escapeTelegramHtml(input.prompt),
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }
      const plainBody = {
        chat_id: options.expectedChatId,
        text: input.prompt,
        reply_markup: replyMarkup,
      }
      const envelope = await requestWithHtmlFallback("sendMessage", htmlBody, plainBody)
      const result = envelope.result
      if (!result || typeof result !== "object" || Array.isArray(result) || !("message_id" in result)) {
        throw new Error("Telegram sendMessage response did not include message_id")
      }
      const messageId = String(result.message_id)
      const pending: PendingApproval = {
        approvalId: input.approvalId,
        decisionToken: input.decisionToken,
        messageId,
        approveCallbackData,
        denyCallbackData,
        expiresAt: input.expiresAt,
      }
      addPending(pending)
      try {
        persistPending()
      } catch (error) {
        removePending(pending)
        throw error
      }
      return { messageId, approveCallbackData, denyCallbackData }
    },

    async handleUpdate(update) {
      const callback = update.callback_query
      if (!callback) return { handled: false, accepted: false, reason: "not_callback" }
      const callbackData = callback.data ?? ""
      const pending = pendingByCallback.get(callbackData)
      const callbackUserId = String(callback.from.id)
      const callbackChatId = callback.message ? String(callback.message.chat.id) : ""
      const callbackMessageId = callback.message ? String(callback.message.message_id) : ""
      let invalidReason: string | null = null
      if (!pending) invalidReason = "stale_callback"
      else if (callbackUserId !== options.expectedUserId) invalidReason = "foreign_user"
      else if (callbackChatId !== options.expectedChatId) invalidReason = "foreign_chat"
      else if (callbackMessageId !== pending.messageId) invalidReason = "foreign_message"
      if (invalidReason) {
        await acknowledge(callback.id, true)
        return { handled: true, accepted: false, reason: invalidReason }
      }

      removePending(pending!)
      await acknowledge(callback.id, false)
      let outcome = pending!.terminal
      try {
        if (!outcome) {
          const decisionToken = pending!.decisionToken ?? await options.resolveDecisionToken?.(pending!.approvalId)
          if (!decisionToken) throw new Error("Telegram approval restart requires a decision token resolver")
          const decision = callbackData === pending!.approveCallbackData ? "approve" : "deny"
          outcome = await options.onDecision({
            approvalId: pending!.approvalId,
            decisionToken,
            decision,
            requesterId: options.expectedUserId,
            transport: "telegram",
            transportChatId: options.expectedChatId,
            transportMessageId: pending!.messageId,
          })
          pending!.terminal = outcome
        }
        addPending(pending!)
        persistPending()
      } catch (error) {
        addPending(pending!)
        throw error
      }
      const emptyMarkup = { inline_keyboard: [] as never[] }
      await editTerminalMessage({
        chat_id: options.expectedChatId,
        message_id: Number(pending!.messageId),
        text: escapeTelegramHtml(outcome.terminalText),
        parse_mode: "HTML",
        reply_markup: emptyMarkup,
      }, {
        chat_id: options.expectedChatId,
        message_id: Number(pending!.messageId),
        text: outcome.terminalText,
        reply_markup: emptyMarkup,
      })
      removePending(pending!)
      persistPending()
      return {
        handled: true,
        accepted: outcome.accepted,
        reason: outcome.accepted ? "accepted" : "decision_refused",
      }
    },
  }
}
