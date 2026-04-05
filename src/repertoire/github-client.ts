// GitHub API client.
// Provides a generic githubRequest() for arbitrary GitHub REST API endpoints.

import { apiRequest } from "./api-client"

const GITHUB_BASE = "https://api.github.com"

// Generic GitHub API request. Returns response body as pretty-printed JSON string.
export async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: string,
): Promise<string> {
  return apiRequest({
    baseUrl: GITHUB_BASE,
    method,
    path,
    token,
    clientName: "github",
    serviceLabel: "GitHub",
    connectionName: "github",
    body,
    extraHeaders: {
      Accept: "application/vnd.github+json",
    },
  })
}
