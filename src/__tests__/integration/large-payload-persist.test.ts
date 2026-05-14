import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { performance } from "perf_hooks"
import { describe, expect, it } from "vitest"
import type OpenAI from "openai"
import { EVENT_CONTENT_MAX_CHARS } from "../../heart/session-events"
import { postTurnPersist, type PostTurnPrepared } from "../../mind/context"

const ARTIFACT_PATH = "/Users/arimendelow/AgentBundles/slugger.ouro/tasks/2026-05-12-1042-doing-drop-the-archive/large-payload-rss.txt"
const LARGE_PAYLOAD_CHARS = 300 * 1024 * 1024
const PERSIST_RSS_BUDGET_BYTES = 200 * 1024 * 1024
const MARKER_PREFIX = `[truncated — event content exceeded ${EVENT_CONTENT_MAX_CHARS} chars; original length ${LARGE_PAYLOAD_CHARS} chars]`
const HEAD_MARKER = "unit-1d-large-payload-head"
const TAIL_MARKER = "unit-1d-large-payload-tail"

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

describe("large payload postTurnPersist integration", () => {
  it("postTurnPersist caps a 300 MB tool result", { timeout: 30_000 }, () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "ouro-large-payload-"))
    const sessPath = join(tmpRoot, "session.json")
    const start = performance.now()
    const rssBeforeBuild = process.memoryUsage().rss

    try {
      const fillerLength = LARGE_PAYLOAD_CHARS - HEAD_MARKER.length - TAIL_MARKER.length
      const largePayload = `${HEAD_MARKER}${"x".repeat(fillerLength)}${TAIL_MARKER}`
      expect(largePayload).toHaveLength(LARGE_PAYLOAD_CHARS)
      const materializationChecksum = largePayload.charCodeAt(0) + largePayload.charCodeAt(largePayload.length - 1)
      expect(materializationChecksum).toBe(HEAD_MARKER.charCodeAt(0) + TAIL_MARKER.charCodeAt(TAIL_MARKER.length - 1))

      const rssAfterBuild = process.memoryUsage().rss
      const toolMessage = {
        role: "tool",
        tool_call_id: "call_large_payload",
        content: largePayload,
      } satisfies OpenAI.ChatCompletionToolMessageParam
      const prepared = {
        currentMessages: [toolMessage],
        trimmedMessages: [toolMessage],
        currentIngressTimes: [null],
        maxTokens: 80_000,
        contextMargin: 20,
      } satisfies PostTurnPrepared

      const events = postTurnPersist(sessPath, prepared)
      const elapsedMs = performance.now() - start
      const rssAfterPersist = process.memoryUsage().rss
      const persistRssDelta = rssAfterPersist - rssAfterBuild
      const totalRssDelta = rssAfterPersist - rssBeforeBuild
      const persisted = JSON.parse(readFileSync(sessPath, "utf8")) as {
        events: Array<{ role: string; content: unknown }>
      }
      const persistedContent = persisted.events.find((event) => event.role === "tool")?.content

      writeFileSync(
        ARTIFACT_PATH,
        [
          "Unit 1d large-payload RSS smoke",
          `payloadChars=${LARGE_PAYLOAD_CHARS}`,
          `eventContentMaxChars=${EVENT_CONTENT_MAX_CHARS}`,
          `elapsedMs=${elapsedMs.toFixed(1)}`,
          `rssBeforeBuildBytes=${rssBeforeBuild} (${mb(rssBeforeBuild)} MB)`,
          `rssAfterBuildBytes=${rssAfterBuild} (${mb(rssAfterBuild)} MB)`,
          `rssAfterPersistBytes=${rssAfterPersist} (${mb(rssAfterPersist)} MB)`,
          `persistRssDeltaBytes=${persistRssDelta} (${mb(persistRssDelta)} MB)`,
          `totalRssDeltaBytes=${totalRssDelta} (${mb(totalRssDelta)} MB)`,
          `absoluteRssOver200MB=${rssAfterPersist > PERSIST_RSS_BUDGET_BYTES}`,
          "assertion=persist RSS delta <= 200 MB; absolute RSS may include Vitest/Node baseline plus the required synthetic payload",
          "",
        ].join("\n"),
        "utf8",
      )

      expect(events).toHaveLength(1)
      expect(typeof persistedContent).toBe("string")
      expect(persistedContent).toContain(HEAD_MARKER)
      expect(persistedContent).toContain(TAIL_MARKER)
      expect(persistedContent).toContain(MARKER_PREFIX)
      expect((persistedContent as string).length).toBeLessThanOrEqual(EVENT_CONTENT_MAX_CHARS)
      expect(elapsedMs).toBeLessThan(10_000)
      expect(persistRssDelta).toBeLessThanOrEqual(PERSIST_RSS_BUDGET_BYTES)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
