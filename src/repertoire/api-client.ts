/**
 * Shared HTTP API client for Graph, ADO, and GitHub clients.
 *
 * All three API clients follow the same pattern: emit request_start event,
 * build request with auth header, fetch, handle errors, emit request_end,
 * and return pretty-printed JSON. This module extracts that shared logic.
 */

import { handleApiError } from "../heart/api-error"
import { emitNervesEvent } from "../nerves/runtime"

export interface ApiRequestOptions {
  /** Base URL (e.g. "https://graph.microsoft.com/v1.0") */
  baseUrl: string
  /** HTTP method */
  method: string
  /** URL path appended to baseUrl */
  path: string
  /** Bearer token for Authorization header */
  token: string
  /** Client name for logging (e.g. "graph", "ado", "github") */
  clientName: string
  /** Service label for error messages (e.g. "Graph", "ADO", "GitHub") */
  serviceLabel: string
  /** Connection name for auth error responses */
  connectionName: string
  /** Optional request body */
  body?: string
  /** Additional headers beyond Authorization and Content-Type */
  extraHeaders?: Record<string, string>
  /** Override Content-Type (defaults to "application/json") */
  contentType?: string
  /** Extra metadata for nerves events */
  eventMeta?: Record<string, unknown>
}

/**
 * Execute an authenticated API request with standard logging and error handling.
 * Returns the response body as a pretty-printed JSON string.
 */
export async function apiRequest(options: ApiRequestOptions): Promise<string> {
  const {
    baseUrl, method, path, token, clientName, serviceLabel, connectionName,
    body, extraHeaders, contentType, eventMeta,
  } = options

  try {
    emitNervesEvent({
      event: "client.request_start",
      component: "clients",
      message: `starting ${serviceLabel} request`,
      meta: { client: clientName, method, path, ...eventMeta },
    })

    const url = `${baseUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType ?? "application/json",
      ...extraHeaders,
    }

    const opts: RequestInit = { method, headers }
    if (body) opts.body = body

    const res = await fetch(url, opts)

    if (!res.ok) {
      emitNervesEvent({
        level: "error",
        event: "client.error",
        component: "clients",
        message: `${serviceLabel} request failed`,
        meta: { client: clientName, method, path, status: res.status, ...eventMeta },
      })
      return handleApiError(res, serviceLabel, connectionName)
    }

    const data = await res.json()
    emitNervesEvent({
      event: "client.request_end",
      component: "clients",
      message: `${serviceLabel} request completed`,
      meta: { client: clientName, method, path, success: true, ...eventMeta },
    })
    return JSON.stringify(data, null, 2)
  } catch (err) {
    emitNervesEvent({
      level: "error",
      event: "client.error",
      component: "clients",
      message: `${serviceLabel} request threw exception`,
      meta: {
        client: clientName,
        method,
        path,
        reason: err instanceof Error ? err.message : String(err),
        ...eventMeta,
      },
    })
    return handleApiError(err, serviceLabel, connectionName)
  }
}
