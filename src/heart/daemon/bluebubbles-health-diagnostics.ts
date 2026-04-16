import { emitNervesEvent } from "../../nerves/runtime"
import { classifyHttpError } from "../providers/error-classification"

interface BlueBubblesHttpError extends Error {
  status?: number
}

export type BlueBubblesHealthClassification =
  | "auth-failure"
  | "network-error"
  | "rate-limit"
  | "server-error"
  | "unknown"
  | "usage-limit"

export interface BlueBubblesHealthProbeInput {
  serverUrl: string
  password: string
  requestTimeoutMs: number
  fetchImpl: typeof fetch
}

export interface BlueBubblesHealthProbeResult {
  ok: boolean
  detail: string
  reason: string | null
  status: number | null
  classification: BlueBubblesHealthClassification | null
}

function buildBlueBubblesApiUrl(baseUrl: string, endpoint: string, password: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const url = new URL(endpoint.replace(/^\//, ""), root)
  url.searchParams.set("password", password)
  return url.toString()
}

export function stringifyBlueBubblesHealthError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    if (message) return message
    return error.name || "unknown"
  }
  const value = String(error).trim()
  return value || "unknown"
}

export function redactBlueBubblesHealthDetailForNerves(detail: string): string {
  return detail
    .replace(/\bbluebubbles\.password\b/gi, "bluebubbles credential")
    .replace(/\bpassword\b/gi, "credential")
}

function blueBubblesHealthStatus(error: unknown): number | null {
  return error instanceof Error && typeof (error as BlueBubblesHttpError).status === "number"
    ? (error as BlueBubblesHttpError).status!
    : null
}

function blueBubblesHealthClassification(error: unknown): BlueBubblesHealthClassification {
  return error instanceof Error ? classifyHttpError(error) : "unknown"
}

export function formatBlueBubblesHealthcheckFailure(
  serverUrlInput: string,
  error: unknown,
): string {
  const serverUrl = serverUrlInput.trim() || "configured BlueBubbles server"
  const rawReason = stringifyBlueBubblesHealthError(error)
  const status = blueBubblesHealthStatus(error)

  if (!(error instanceof Error)) {
    return `BlueBubbles health check failed at ${serverUrl}. Check \`bluebubbles.serverUrl\`, confirm the BlueBubbles app/API is running, and inspect daemon logs. Raw error: ${rawReason}`
  }

  switch (blueBubblesHealthClassification(error)) {
    case "network-error":
      return `Cannot reach BlueBubbles at ${serverUrl}. Check \`bluebubbles.serverUrl\`, confirm the BlueBubbles app/API is running, and verify this machine can reach it. Raw error: ${rawReason}`
    case "auth-failure":
      return `BlueBubbles auth failed at ${serverUrl} (HTTP ${status}). Check this machine's BlueBubbles attachment with \`ouro connect bluebubbles --agent <agent>\` and confirm the server accepts the password. Raw error: ${rawReason}`
    case "server-error":
      return `BlueBubbles upstream returned HTTP ${status} at ${serverUrl}. Check the BlueBubbles app/server logs and confirm the upstream API is healthy. Raw error: ${rawReason}`
    default:
      return `BlueBubbles health check failed at ${serverUrl}${status === null ? "" : ` (HTTP ${status})`}. Check \`bluebubbles.serverUrl\`, the BlueBubbles server configuration, and daemon logs. Raw error: ${rawReason}`
  }
}

export async function probeBlueBubblesHealth(input: BlueBubblesHealthProbeInput): Promise<BlueBubblesHealthProbeResult> {
  try {
    const url = buildBlueBubblesApiUrl(input.serverUrl, "/api/v1/message/count", input.password)
    const response = await input.fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(input.requestTimeoutMs),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      const error = new Error(errorText || "unknown") as BlueBubblesHttpError
      error.status = response.status
      throw error
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.bluebubbles_health_probe_checked",
      message: "checked bluebubbles upstream health",
      meta: {
        serverUrl: input.serverUrl,
        ok: true,
        status: response.status,
      },
    })

    return {
      ok: true,
      detail: "upstream reachable",
      reason: null,
      status: response.status,
      classification: null,
    }
  } catch (error) {
    const detail = formatBlueBubblesHealthcheckFailure(input.serverUrl, error)
    const reason = stringifyBlueBubblesHealthError(error)
    const status = blueBubblesHealthStatus(error)
    const classification = blueBubblesHealthClassification(error)

    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.bluebubbles_health_probe_checked",
      message: "checked bluebubbles upstream health",
      meta: {
        serverUrl: input.serverUrl,
        ok: false,
        status,
        reason,
        classification,
        detail: redactBlueBubblesHealthDetailForNerves(detail),
      },
    })

    return {
      ok: false,
      detail,
      reason,
      status,
      classification,
    }
  }
}

/* v8 ignore start -- module load observability event */
emitNervesEvent({
  component: "daemon",
  event: "daemon.bluebubbles_health_diagnostics_loaded",
  message: "bluebubbles health diagnostics loaded",
  meta: {},
})
/* v8 ignore stop */
