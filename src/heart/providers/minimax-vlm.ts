import { emitNervesEvent } from "../../nerves/runtime"
import { isNetworkError } from "./error-classification"

/**
 * Thin client for the MiniMax VLM endpoint used when the active chat model
 * has no vision capability. Lives in its own file so the reasoning chat
 * provider in `minimax.ts` stays focused on chat completions, and so the
 * BlueBubbles sense can import the helper directly without pulling the
 * whole provider runtime.
 *
 * Every error return path is AX-2 compliant: each throw says what went wrong
 * AND what the caller (usually an agent reading the tool result or a human
 * reading bluebubbles.ndjson) should try next. The prompt and description
 * text are never logged to nerves event meta — only lengths.
 */

export interface MinimaxVlmDescribeParams {
  /** MiniMax API key. Passed in explicitly — never pulled from process.env. */
  apiKey: string
  /** Targeted prompt/question for the VLM. "Describe this" is discouraged; prefer specifics. */
  prompt: string
  /** Data URL of the image. Must match `data:image/(png|jpeg|webp);base64,...`. */
  imageDataUrl: string
  /** Base URL for the MiniMax provider — usually `MINIMAX_PROVIDER_BASE_URL`. */
  baseURL: string
  /** Injected fetch for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Request timeout in milliseconds. Default 60000. */
  timeoutMs?: number
  /** Optional nerves event meta pass-throughs. Used so `bluebubbles.ndjson` grep surfaces the right call. */
  attachmentGuid?: string
  mimeType?: string
  chatModel?: string
}

// No default timeout — if the caller doesn't pass `timeoutMs`, we don't
// layer an AbortSignal on top of fetch, which means undici's own defaults
// (headersTimeout and bodyTimeout, both 5 minutes in the current Node) are
// the ceiling. That's the right ceiling: long enough to tolerate any
// legitimate MiniMax VLM slow window, short enough to eventually give up on
// a dead endpoint, and — unlike a number we picked — it's the stack's
// actual default rather than a harness-imposed fiction.
//
// Tests that want to exercise the timeout branch pass an explicit
// `timeoutMs`; production callers omit it and get undici's behavior.
//
// Same reasoning as PR #322 (dropped the 30s SDK timeout from the LLM
// providers): the harness shouldn't impose artificially tight request
// ceilings when the underlying stack already has correct defaults.
const MODEL_NAME = "minimax-vlm"
const SUPPORTED_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,/i

function buildVlmUrl(baseURL: string): string {
  const stripped = baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "")
  return `${stripped}/v1/coding_plan/vlm`
}

function extractMimeType(imageDataUrl: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/.exec(imageDataUrl)
  return match?.[1]?.toLowerCase()
}

function emitStart(params: MinimaxVlmDescribeParams): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_vlm_describe_start",
    message: "minimax vlm describe start",
    meta: {
      attachmentGuid: params.attachmentGuid,
      mimeType: params.mimeType,
      promptLength: params.prompt.length,
      model: MODEL_NAME,
      chatModel: params.chatModel,
    },
  })
}

function emitEnd(
  params: MinimaxVlmDescribeParams,
  descriptionLength: number,
  latencyMs: number,
): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_vlm_describe_end",
    message: "minimax vlm describe end",
    meta: {
      attachmentGuid: params.attachmentGuid,
      descriptionLength,
      latencyMs,
      model: MODEL_NAME,
    },
  })
}

function emitError(
  params: MinimaxVlmDescribeParams,
  reason: string,
  status?: number,
  traceId?: string,
): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_vlm_describe_error",
    message: "minimax vlm describe error",
    meta: {
      attachmentGuid: params.attachmentGuid,
      mimeType: params.mimeType,
      model: MODEL_NAME,
      reason,
      status,
      traceId,
    },
  })
}

function throwAndEmit(
  params: MinimaxVlmDescribeParams,
  message: string,
  status?: number,
  traceId?: string,
): never {
  emitError(params, message, status, traceId)
  const err = new Error(message) as Error & { status?: number; traceId?: string }
  if (status !== undefined) err.status = status
  if (traceId) err.traceId = traceId
  throw err
}

export async function minimaxVlmDescribe(params: MinimaxVlmDescribeParams): Promise<string> {
  if (!params.apiKey) {
    // We deliberately do NOT emit _start for param-validation errors — there's
    // no meaningful "started a request" to pair with. Only the _error fires.
    emitError(params, "minimax VLM: API key is empty — re-run credential setup or add a minimax key to secrets.json")
    throw new Error(
      "minimax VLM: API key is empty — re-run credential setup or add a minimax key to secrets.json",
    )
  }
  if (!params.prompt) {
    emitError(params, "minimax VLM: missing prompt — supply a targeted question (e.g. 'what's the flight number in the bottom-right?') and retry")
    throw new Error(
      "minimax VLM: missing prompt — supply a targeted question (e.g. 'what's the flight number in the bottom-right?') and retry",
    )
  }
  if (!params.imageDataUrl) {
    emitError(params, "minimax VLM: missing image data URL — verify the attachment downloaded OK or ask the user to resend the image")
    throw new Error(
      "minimax VLM: missing image data URL — verify the attachment downloaded OK or ask the user to resend the image",
    )
  }
  if (!SUPPORTED_DATA_URL_PATTERN.test(params.imageDataUrl)) {
    const mime = extractMimeType(params.imageDataUrl) ?? "unknown"
    const msg = `minimax VLM: image must be a data:image/(png|jpeg|webp);base64,... URL but got ${mime} — ask the user to resend as a screenshot (png or jpeg)`
    emitError({ ...params, mimeType: params.mimeType ?? mime }, msg)
    throw new Error(msg)
  }

  const fetchImpl = params.fetchImpl ?? fetch
  const url = buildVlmUrl(params.baseURL)

  emitStart(params)
  const startTs = Date.now()

  // Only layer an AbortSignal if the caller explicitly asked for one.
  // Omitting it lets undici's defaults (headersTimeout + bodyTimeout = 5min
  // each in current Node) act as the ceiling — see the long comment on
  // DEFAULT_TIMEOUT_MS above for the rationale.
  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      "MM-API-Source": "Ouroboros",
    },
    body: JSON.stringify({
      prompt: params.prompt,
      image_url: params.imageDataUrl,
    }),
  }
  if (typeof params.timeoutMs === "number" && params.timeoutMs > 0) {
    fetchOptions.signal = AbortSignal.timeout(params.timeoutMs)
  }

  let response: Response
  try {
    response = await fetchImpl(url, fetchOptions)
  } catch (error) {
    const err = (error instanceof Error ? error : new Error(String(error))) as Error & { name?: string }
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      const seconds = typeof params.timeoutMs === "number" ? Math.round(params.timeoutMs / 1000) : null
      const hint = seconds !== null
        ? `request timed out after ${seconds}s — retry or ask the user to resend the image`
        : `request timed out (underlying stack default) — retry or ask the user to resend the image`
      throwAndEmit(params, `minimax VLM: ${hint}`)
    }
    if (isNetworkError(err)) {
      throwAndEmit(
        params,
        `minimax VLM: network error talking to the vlm endpoint (${err.message}) — retry in a moment`,
      )
    }
    throwAndEmit(
      params,
      `minimax VLM: unexpected transport error (${err.message}) — retry, and if it persists surface 'image understanding is unavailable' to the user`,
    )
  }

  const traceId = response.headers.get("Trace-Id") ?? response.headers.get("trace-id") ?? undefined
  const status = response.status

  if (status === 401 || status === 403) {
    throwAndEmit(
      params,
      `minimax VLM: rejected credentials (HTTP ${status}) — the minimax key for this agent is invalid, re-run credential setup or rotate the key`,
      status,
      traceId,
    )
  }
  if (status === 429) {
    throwAndEmit(
      params,
      `minimax VLM: rate limited (HTTP 429) — wait and retry in a moment`,
      status,
      traceId,
    )
  }
  if (status >= 500) {
    throwAndEmit(
      params,
      `minimax VLM: server error (HTTP ${status}) — retry, and if it persists surface 'image understanding is unavailable' to the user`,
      status,
      traceId,
    )
  }
  if (!response.ok) {
    throwAndEmit(
      params,
      `minimax VLM: unexpected HTTP ${status} — retry, and if it persists surface 'image understanding is unavailable' to the user`,
      status,
      traceId,
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    const err = error as Error
    throwAndEmit(
      params,
      `minimax VLM: malformed response (not JSON: ${err.message}) — this is a provider bug, retry or surface 'image understanding is unavailable' to the user`,
      status,
      traceId,
    )
  }

  const parsed = body as {
    content?: unknown
    base_resp?: { status_code?: number; status_msg?: string }
  }
  const providerStatus = parsed?.base_resp?.status_code ?? 0
  if (providerStatus !== 0) {
    const providerMsg = parsed?.base_resp?.status_msg ?? "unknown"
    throwAndEmit(
      params,
      `minimax VLM: provider returned status_code=${providerStatus} (${providerMsg}) — check the minimax account or retry, and if it persists surface 'image understanding is unavailable' to the user`,
      status,
      traceId,
    )
  }

  const content = parsed?.content
  if (typeof content !== "string" || content.length === 0) {
    throwAndEmit(
      params,
      `minimax VLM: returned no description (empty content field) — this is a provider bug, retry or surface 'image understanding is unavailable' to the user`,
      status,
      traceId,
    )
  }

  const latencyMs = Date.now() - startTs
  emitEnd(params, (content as string).length, latencyMs)
  return content as string
}

/* v8 ignore start — module-level observability event */
emitNervesEvent({
  component: "engine",
  event: "engine.minimax_vlm_loaded",
  message: "minimax vlm client loaded",
  meta: {},
})
/* v8 ignore stop */
