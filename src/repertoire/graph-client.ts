// Graph API client.
// Provides a generic graphRequest() for arbitrary endpoints
// and a thin getProfile() wrapper for backward compatibility.

import { handleApiError } from "../heart/api-error"
import { emitNervesEvent } from "../nerves/runtime"
import { apiRequest } from "./api-client"

const GRAPH_BASE = "https://graph.microsoft.com/v1.0"

interface GraphProfile {
  displayName: string
  mail: string | null
  jobTitle: string | null
  department: string | null
  officeLocation: string | null
}

// Generic Graph API request. Returns response body as pretty-printed JSON string.
export async function graphRequest(
  token: string,
  method: string,
  path: string,
  body?: string,
): Promise<string> {
  return apiRequest({
    baseUrl: GRAPH_BASE,
    method,
    path,
    token,
    clientName: "graph",
    serviceLabel: "Graph",
    connectionName: "graph",
    body,
  })
}

// Backward-compatible thin wrapper: fetches /me and formats as human-readable text.
export async function getProfile(token: string): Promise<string> {
  try {
    emitNervesEvent({
      event: "client.request_start",
      component: "clients",
      message: "starting Graph profile request",
      meta: { client: "graph", operation: "getProfile" },
    })

    const res = await fetch(`${GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      emitNervesEvent({
        level: "error",
        event: "client.error",
        component: "clients",
        message: "Graph profile request failed",
        meta: { client: "graph", operation: "getProfile", status: res.status },
      })
      return handleApiError(res, "Graph", "graph")
    }

    const profile = (await res.json()) as GraphProfile
    const lines = [
      `Name: ${profile.displayName}`,
      `Email: ${profile.mail || "N/A"}`,
      `Job Title: ${profile.jobTitle || "N/A"}`,
      `Department: ${profile.department || "N/A"}`,
      `Office: ${profile.officeLocation || "N/A"}`,
    ]
    emitNervesEvent({
      event: "client.request_end",
      component: "clients",
      message: "Graph profile request completed",
      meta: { client: "graph", operation: "getProfile", success: true },
    })
    return lines.join("\n")
  } catch (err) {
    emitNervesEvent({
      level: "error",
      event: "client.error",
      component: "clients",
      message: "Graph profile request threw exception",
      meta: {
        client: "graph",
        operation: "getProfile",
        reason: err instanceof Error ? err.message : String(err),
      },
    })
    return handleApiError(err, "Graph", "graph")
  }
}
