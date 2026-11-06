import { emitNervesEvent } from "../nerves/runtime"

export interface RuntimeCapabilityCheckResult {
  ok: boolean
  summary: string
}

type RuntimeCapability = "perplexity-search" | "memory-embeddings"

function sanitizeCapabilityError(message: string): string {
  const statusMatch = message.match(/^(\d{3})\s/)
  if (!statusMatch) return message

  const status = statusMatch[1]
  const body = message.slice(status.length).trim()
  if (body.startsWith("<") || body.includes("<!DOCTYPE") || body.includes("<html")) {
    return `HTTP ${status}`
  }
  if (body.startsWith("{")) {
    try {
      const json = JSON.parse(body)
      const inner = json?.error?.message
      if (typeof inner === "string" && inner && inner !== "Error") {
        return `${status} ${inner}`
      }
    } catch {
      // Keep the HTTP status fallback below.
    }
    return `HTTP ${status}`
  }
  return message
}

async function readHttpFailureSummary(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`.trim()
  try {
    const json = await response.json() as Record<string, unknown>
    if (typeof json.error === "string" && json.error.trim()) {
      detail = `${response.status} ${json.error}`
    } else if (typeof json.error === "object" && json.error !== null) {
      const errObj = json.error as Record<string, unknown>
      if (typeof errObj.message === "string" && errObj.message.trim()) {
        detail = `${response.status} ${errObj.message}`
      }
    } else if (typeof json.message === "string" && json.message.trim()) {
      detail = `${response.status} ${json.message}`
    }
  } catch {
    // Keep the HTTP status summary if the body is not JSON.
  }
  return sanitizeCapabilityError(detail)
}

function reportRuntimeCapabilityCheckStart(capability: RuntimeCapability, url: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.runtime_capability_check_start",
    message: "starting runtime capability check",
    meta: { capability, url },
  })
}

function reportRuntimeCapabilityCheckEnd(capability: RuntimeCapability, url: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.runtime_capability_check_end",
    message: "runtime capability check passed",
    meta: { capability, url },
  })
}

function reportRuntimeCapabilityCheckError(capability: RuntimeCapability, url: string, summary: string): void {
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.runtime_capability_check_error",
    message: "runtime capability check failed",
    meta: { capability, url, summary },
  })
}

export async function verifyPerplexityCapability(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeCapabilityCheckResult> {
  const url = "https://api.perplexity.ai/search"
  reportRuntimeCapabilityCheckStart("perplexity-search", url)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: "ping",
        max_results: 1,
      }),
    })
    if (!response.ok) {
      const summary = await readHttpFailureSummary(response)
      reportRuntimeCapabilityCheckError("perplexity-search", url, summary)
      return {
        ok: false,
        summary,
      }
    }

    const payload = await response.json() as { results?: Array<{ title?: string; url?: string; snippet?: string }> }
    if (!Array.isArray(payload.results) || payload.results.length === 0) {
      const summary = "Perplexity returned no search results"
      reportRuntimeCapabilityCheckError("perplexity-search", url, summary)
      return {
        ok: false,
        summary,
      }
    }

    reportRuntimeCapabilityCheckEnd("perplexity-search", url)
    return {
      ok: true,
      summary: "live check passed",
    }
  } catch (error) {
    const summary = sanitizeCapabilityError(error instanceof Error ? error.message : String(error))
    reportRuntimeCapabilityCheckError("perplexity-search", url, summary)
      return {
        ok: false,
        summary,
      }
  }
}

export async function verifyEmbeddingsCapability(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeCapabilityCheckResult> {
  const url = "https://api.openai.com/v1/embeddings"
  reportRuntimeCapabilityCheckStart("memory-embeddings", url)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: ["ping"],
      }),
    })
    if (!response.ok) {
      const summary = await readHttpFailureSummary(response)
      reportRuntimeCapabilityCheckError("memory-embeddings", url, summary)
      return {
        ok: false,
        summary,
      }
    }

    const payload = await response.json() as { data?: Array<{ embedding?: number[] }> }
    if (!Array.isArray(payload.data) || payload.data.length !== 1 || !Array.isArray(payload.data[0]?.embedding) || payload.data[0]!.embedding!.length === 0) {
      const summary = "embeddings response missing expected vectors"
      reportRuntimeCapabilityCheckError("memory-embeddings", url, summary)
      return {
        ok: false,
        summary,
      }
    }

    reportRuntimeCapabilityCheckEnd("memory-embeddings", url)
    return {
      ok: true,
      summary: "live check passed",
    }
  } catch (error) {
    const summary = sanitizeCapabilityError(error instanceof Error ? error.message : String(error))
    reportRuntimeCapabilityCheckError("memory-embeddings", url, summary)
      return {
        ok: false,
        summary,
      }
  }
}
