import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { CONVERSATION_QUIET_MS, ownerConversationHold, UNANSWERED_HOLD_MS } from "../../../senses/shepherd/conversation-hold"

/**
 * Replays the owner's Teams chat of 2026-11-16: a proactive morning note at 07:42:15 PT, the owner's question at
 * 07:49:16 (Teams handed it to the agent at 07:49:33), a "Still broken" push at 07:49:28 that landed before the answer,
 * and the answer at 07:50:02. Times are UTC here.
 */
const NOTE = Date.parse("2026-11-16T15:42:15Z")
const ASKED = Date.parse("2026-11-16T15:49:33Z")
const PUSHED = Date.parse("2026-11-16T15:49:28Z")
const ANSWERED = Date.parse("2026-11-16T15:50:02Z")
const KEY = "a_1owner"
let root: string

function event(sequence: number, role: "user" | "assistant", at: number, captureKind = "live") {
  const iso = new Date(at).toISOString()
  return {
    id: `evt-${String(sequence).padStart(6, "0")}`, sequence, role, content: `${role} ${sequence}`, name: null, toolCallId: null, toolCalls: [], attachments: [],
    time: { authoredAt: iso, authoredAtSource: "local", observedAt: iso, observedAtSource: "ingest", recordedAt: iso, recordedAtSource: "save" },
    relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
    provenance: { captureKind, legacyVersion: null, sourceMessageIndex: null },
  }
}

function chat(events: ReturnType<typeof event>[]): string {
  const dir = path.join(root, "state", "sessions", "ari", "teams")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${KEY}.json`)
  fs.writeFileSync(file, JSON.stringify({
    version: 2, events,
    projection: { eventIds: events.map(item => item.id), trimmed: false, maxTokens: 80000, contextMargin: 20, inputTokens: null, projectedAt: new Date(NOTE).toISOString() },
    lastUsage: null, state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
  }))
  return file
}

const earlier = (at: number) => [event(1, "user", at - 3_600_000), event(2, "assistant", at - 3_590_000)]

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-hold-"))
  fs.mkdirSync(path.join(root, "friends"), { recursive: true })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("ownerConversationHold, replaying the owner's chat", () => {
  it("holds the 07:49:28 push: the agent's own note seven minutes earlier means a reply may be on its way", () => {
    chat([...earlier(NOTE), event(3, "assistant", NOTE, "synthetic")])
    expect(ownerConversationHold(root, "ari", PUSHED, { inFlight: () => false })).toBe("recent-message")
  })

  it("holds while the answer is being written, and for ten quiet minutes after it", () => {
    const file = chat([...earlier(NOTE), event(3, "assistant", NOTE, "synthetic"), event(4, "user", ASKED)])
    expect(ownerConversationHold(root, "ari", ASKED + 5_000, { inFlight: sessionPath => sessionPath === file })).toBe("turn-running")
    chat([...earlier(NOTE), event(3, "assistant", NOTE, "synthetic"), event(4, "user", ASKED), event(5, "assistant", ANSWERED)])
    expect(ownerConversationHold(root, "ari", ANSWERED + CONVERSATION_QUIET_MS - 1, { inFlight: () => false })).toBe("recent-message")
    expect(ownerConversationHold(root, "ari", ANSWERED + CONVERSATION_QUIET_MS, { inFlight: () => false })).toBeNull()
  })

  it("holds for a question with no answer yet, until a turn that died stops holding after half an hour", () => {
    chat([...earlier(ASKED), event(3, "user", ASKED)])
    expect(ownerConversationHold(root, "ari", ASKED + CONVERSATION_QUIET_MS + 1, { inFlight: () => false })).toBe("unanswered")
    expect(ownerConversationHold(root, "ari", ASKED + UNANSWERED_HOLD_MS, { inFlight: () => false })).toBeNull()
  })

  it("lets a notice through when the owner has no conversation, using the live turn lock by default", () => {
    expect(ownerConversationHold(root, "ari", PUSHED)).toBeNull()
    chat(earlier(NOTE))
    expect(ownerConversationHold(root, "ari", NOTE)).toBeNull()
    chat([event(1, "assistant", NOTE - 3_600_000, "synthetic")])
    expect(ownerConversationHold(root, "ari", NOTE)).toBeNull()
    chat([event(1, "user", NOTE - 3_600_000)])
    expect(ownerConversationHold(root, "ari", NOTE)).toBeNull()
  })
})
