import { describe, expect, it } from "vitest"

import { redactLogEntry } from "../../nerves/redact"
import type { LogEvent } from "../../nerves"

/**
 * Golden test corpus for log redaction.
 * Each entry pairs an input LogEvent containing realistic secret shapes
 * with the expected redacted output. This corpus is a regression safety net.
 */

function makeEntry(overrides: Partial<LogEvent>): LogEvent {
  return {
    ts: "2026-04-08T00:00:00.000Z",
    level: "info",
    event: "test.golden",
    trace_id: "trace-golden",
    component: "test",
    message: "",
    meta: {},
    ...overrides,
  }
}

describe("nerves/redact golden corpus", () => {
  const corpus: Array<{ name: string; input: LogEvent; expected: LogEvent }> = [
    {
      name: "1. Provider init with Anthropic API key in meta",
      input: makeEntry({
        event: "provider.init",
        message: "initializing anthropic provider",
        meta: { apiKey: "sk-ant-api03-abc123DEF456_ghi", model: "claude-sonnet-4-20250514" },
      }),
      expected: makeEntry({
        event: "provider.init",
        message: "initializing anthropic provider",
        meta: { apiKey: "[REDACTED:apiKey]", model: "claude-sonnet-4-20250514" },
      }),
    },
    {
      name: "2. HTTP request with Authorization header in meta",
      input: makeEntry({
        event: "http.request",
        message: "sending request",
        meta: { headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature", Accept: "application/json" } },
      }),
      expected: makeEntry({
        event: "http.request",
        message: "sending request",
        meta: { headers: { Authorization: "[REDACTED:Authorization]", Accept: "application/json" } },
      }),
    },
    {
      name: "3. OAuth token refresh with multiple sensitive fields",
      input: makeEntry({
        event: "oauth.refresh",
        message: "refreshing tokens",
        meta: { accessToken: "gho_xxxxxxxxxxxx", refreshToken: "ghr_yyyyyyyyyyyy", clientSecret: "cs_zzzzzzzzzzzz", scope: "read:user" },
      }),
      expected: makeEntry({
        event: "oauth.refresh",
        message: "refreshing tokens",
        meta: { accessToken: "[REDACTED:accessToken]", refreshToken: "[REDACTED:refreshToken]", clientSecret: "[REDACTED:clientSecret]", scope: "read:user" },
      }),
    },
    {
      name: "4. URL with token query param in message",
      input: makeEntry({
        event: "http.fetch",
        message: "fetching https://api.example.com?token=secret123&format=json",
        meta: { method: "GET" },
      }),
      expected: makeEntry({
        event: "http.fetch",
        message: "fetching https://api.example.com[REDACTED:url_token]&format=json",
        meta: { method: "GET" },
      }),
    },
    {
      name: "5. Nested config object with API key",
      input: makeEntry({
        event: "config.load",
        message: "loading provider config",
        meta: { config: { provider: { apiKey: "sk-proj-abc123DEF" }, model: "gpt-4" } },
      }),
      expected: makeEntry({
        event: "config.load",
        message: "loading provider config",
        meta: { config: { provider: { apiKey: "[REDACTED:apiKey]" }, model: "gpt-4" } },
      }),
    },
    {
      name: "6. Cookie header in meta",
      input: makeEntry({
        event: "http.request",
        message: "sending request with cookies",
        meta: { cookie: "session=abc123; auth=xyz789" },
      }),
      expected: makeEntry({
        event: "http.request",
        message: "sending request with cookies",
        meta: { cookie: "[REDACTED:cookie]" },
      }),
    },
    {
      name: "7. Password in meta",
      input: makeEntry({
        event: "auth.login",
        message: "authenticating user",
        meta: { password: "hunter2", username: "admin" },
      }),
      expected: makeEntry({
        event: "auth.login",
        message: "authenticating user",
        meta: { password: "[REDACTED:password]", username: "admin" },
      }),
    },
    {
      name: "8. Mixed: sensitive keys + sensitive patterns in same entry",
      input: makeEntry({
        event: "provider.call",
        message: "calling with Bearer eyJtoken.payload.sig and sk-ant-api03-key123",
        meta: { authorization: "Bearer real-token", model: "gpt-4" },
      }),
      expected: makeEntry({
        event: "provider.call",
        message: "calling with [REDACTED:bearer_token] and [REDACTED:anthropic_key]",
        meta: { authorization: "[REDACTED:authorization]", model: "gpt-4" },
      }),
    },
    {
      name: "9. Clean entry (no secrets) passes through unmodified",
      input: makeEntry({
        event: "turn.start",
        message: "starting turn 42",
        meta: { turn: 42, model: "claude-sonnet-4-20250514", duration: 1234 },
      }),
      expected: makeEntry({
        event: "turn.start",
        message: "starting turn 42",
        meta: { turn: 42, model: "claude-sonnet-4-20250514", duration: 1234 },
      }),
    },
    {
      name: "10. Already-redacted entry has no double-redaction artifacts",
      input: makeEntry({
        event: "replay.entry",
        message: "replaying entry with [REDACTED:apiKey] marker",
        meta: { previousKey: "[REDACTED:previousKey]", status: "replayed" },
      }),
      expected: makeEntry({
        event: "replay.entry",
        message: "replaying entry with [REDACTED:apiKey] marker",
        meta: { previousKey: "[REDACTED:previousKey]", status: "replayed" },
      }),
    },
  ]

  for (const { name, input, expected } of corpus) {
    it(name, () => {
      const result = redactLogEntry(input)
      expect(result).toEqual(expected)
    })
  }
})
