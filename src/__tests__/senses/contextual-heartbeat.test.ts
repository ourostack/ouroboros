import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import {
  buildContextualHeartbeat,
  type ContextualHeartbeatOptions,
} from "../../senses/contextual-heartbeat"

function makeOptions(overrides: Partial<ContextualHeartbeatOptions> = {}): ContextualHeartbeatOptions {
  return {
    journalDir: overrides.journalDir ?? "/bundles/slugger.ouro/journal",
    lastCompletedAt: overrides.lastCompletedAt ?? undefined,
    pendingObligations: overrides.pendingObligations ?? [],
    lastSurfaceAt: overrides.lastSurfaceAt ?? undefined,
    checkpoint: overrides.checkpoint ?? undefined,
    now: overrides.now ?? (() => new Date("2026-03-26T12:00:00Z")),
    readJournalDir: overrides.readJournalDir ?? (() => []),
  }
}

describe("buildContextualHeartbeat", () => {
  it("exports buildContextualHeartbeat function", () => {
    expect(typeof buildContextualHeartbeat).toBe("function")
  })

  it("returns bare cold-start fallback when no journal and no runtime state", () => {
    const result = buildContextualHeartbeat(makeOptions({
      journalDir: "/bundles/slugger.ouro/journal",
      lastCompletedAt: undefined,
      readJournalDir: () => [],
    }))

    expect(result).toContain("anything stirring?")
    // Cold start should include checkpoint if provided
  })

  it("includes checkpoint in cold-start fallback when available", () => {
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: undefined,
      checkpoint: "was thinking about morning routines",
      readJournalDir: () => [],
    }))

    expect(result).toContain("anything stirring?")
    expect(result).toContain("was thinking about morning routines")
  })

  it("includes elapsed time since last turn", () => {
    const nowDate = new Date("2026-03-26T12:28:00Z")
    const lastCompleted = new Date("2026-03-26T12:00:00Z").toISOString()

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: lastCompleted,
      now: () => nowDate,
      readJournalDir: () => [],
    }))

    expect(result).toContain("28 minutes")
    expect(result).toContain("since your last turn")
  })

  it("includes pending attention count", () => {
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      pendingObligations: [
        { id: "obl-1", content: "help with task", friendName: "Ari", timestamp: Date.now(), staleness: 0 },
        { id: "obl-2", content: "review code", friendName: "Ari", timestamp: Date.now(), staleness: 0 },
      ],
      readJournalDir: () => [],
    }))

    expect(result).toContain("2 thoughts")
  })

  it("includes journal index with up to 10 most recently modified files", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `entry-${String(i + 1).padStart(2, "0")}.md`,
      mtime: nowDate.getTime() - i * 3600000, // each 1h older
      preview: `Topic ${i + 1}`,
    }))

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    // Should include first 10 entries
    expect(result).toContain("entry-01.md")
    expect(result).toContain("entry-10.md")
    // Should NOT include 11th and 12th
    expect(result).not.toContain("entry-11.md")
    expect(result).not.toContain("entry-12.md")
    // Should include preview text
    expect(result).toContain("Topic 1")
  })

  it("includes journal file recency in human-readable form", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const files = [
      { name: "morning.md", mtime: nowDate.getTime() - 2 * 3600000, preview: "Morning thoughts" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("2 hours ago")
  })

  it("counts journal entries since last surface", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const lastSurface = new Date("2026-03-26T06:00:00Z") // 6 hours ago
    const files = [
      { name: "entry-1.md", mtime: nowDate.getTime() - 1 * 3600000, preview: "Recent" },
      { name: "entry-2.md", mtime: nowDate.getTime() - 3 * 3600000, preview: "Middle" },
      { name: "entry-3.md", mtime: nowDate.getTime() - 5 * 3600000, preview: "Older but after surface" },
      { name: "entry-4.md", mtime: nowDate.getTime() - 8 * 3600000, preview: "Before surface" },
      { name: "entry-5.md", mtime: nowDate.getTime() - 10 * 3600000, preview: "Way before" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      lastSurfaceAt: lastSurface.toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    // 3 entries since surface (entry-1, 2, 3 have mtime after lastSurface)
    expect(result).toContain("3 journal entries since you last surfaced")
    expect(result).toContain("6 hours ago")
  })

  it("includes stale obligation alerts for obligations pending > 30 min", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => [],
      pendingObligations: [
        {
          id: "obl-1",
          content: "review the architecture doc",
          friendName: "Ari",
          timestamp: nowDate.getTime() - 45 * 60 * 1000, // 45 min ago
          staleness: 45 * 60 * 1000,
        },
        {
          id: "obl-2",
          content: "quick question about types",
          friendName: "Ari",
          timestamp: nowDate.getTime() - 10 * 60 * 1000, // 10 min ago (not stale)
          staleness: 10 * 60 * 1000,
        },
      ],
    }))

    expect(result).toContain("45 minutes")
    expect(result).toContain("review the architecture doc")
    // 10 min old should NOT trigger stale alert
    expect(result).not.toContain("quick question about types")
  })

  it("does not mention journal when journal dir is empty", () => {
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      readJournalDir: () => [],
    }))

    // Should not have journal section header when no files
    expect(result).not.toContain("## journal")
  })

  it("does not mention surface gap when lastSurfaceAt is not provided", () => {
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      readJournalDir: () => [
        { name: "entry.md", mtime: Date.now(), preview: "test" },
      ],
    }))

    expect(result).not.toContain("since you last surfaced")
  })

  it("does not mention attention count when no pending obligations", () => {
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      pendingObligations: [],
      readJournalDir: () => [],
    }))

    expect(result).not.toContain("thoughts")
  })

  it("emits nerves event", () => {
    buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      readJournalDir: () => [],
    }))

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "senses",
        event: "senses.contextual_heartbeat_built",
      }),
    )
  })

  it("shows singular forms for 1 minute, 1 hour, 1 thought", () => {
    const nowDate = new Date("2026-03-26T12:01:00Z")
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T12:00:00Z").toISOString(),
      now: () => nowDate,
      pendingObligations: [
        { id: "obl-1", content: "something", friendName: "Ari", timestamp: Date.now(), staleness: 0 },
      ],
      readJournalDir: () => [],
    }))

    expect(result).toContain("1 minute")
    expect(result).not.toContain("1 minutes")
    expect(result).toContain("1 thought")
    expect(result).not.toContain("1 thoughts")
  })

  it("shows hours elapsed when > 60 minutes", () => {
    const nowDate = new Date("2026-03-26T14:00:00Z")
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T12:00:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => [],
    }))

    expect(result).toContain("2 hours")
  })

  it("includes full message with all sections when everything is present", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const lastSurface = new Date("2026-03-26T06:00:00Z")
    const files = [
      { name: "morning.md", mtime: nowDate.getTime() - 1 * 3600000, preview: "Morning thoughts" },
      { name: "plans.md", mtime: nowDate.getTime() - 2 * 3600000, preview: "Planning session" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      lastSurfaceAt: lastSurface.toISOString(),
      now: () => nowDate,
      checkpoint: "was reviewing task priorities",
      readJournalDir: () => files,
      pendingObligations: [
        {
          id: "obl-1",
          content: "check on deployment status",
          friendName: "Ari",
          timestamp: nowDate.getTime() - 40 * 60 * 1000,
          staleness: 40 * 60 * 1000,
        },
      ],
    }))

    // Journal section
    expect(result).toContain("morning.md")
    expect(result).toContain("Morning thoughts")
    // Elapsed time
    expect(result).toContain("30 minutes")
    // Attention count
    expect(result).toContain("1 thought")
    // Surface gap
    expect(result).toContain("2 journal entries since you last surfaced")
    expect(result).toContain("6 hours ago")
    // Stale obligation
    expect(result).toContain("40 minutes")
    expect(result).toContain("check on deployment status")
    // Checkpoint
    expect(result).toContain("was reviewing task priorities")
  })

  it("shows days in journal file recency", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const files = [
      { name: "old-entry.md", mtime: nowDate.getTime() - 3 * 24 * 3600000, preview: "Old thoughts" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("3 days ago")
  })

  it("shows singular day in journal file recency", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const files = [
      { name: "yesterday.md", mtime: nowDate.getTime() - 25 * 3600000, preview: "Yesterday" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("1 day ago")
    expect(result).not.toContain("1 days ago")
  })

  it("shows just now for very recent journal files", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const files = [
      { name: "just-now.md", mtime: nowDate.getTime() - 30000, preview: "Just wrote this" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("just now")
  })

  it("shows singular hour elapsed", () => {
    const nowDate = new Date("2026-03-26T13:00:00Z")
    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T12:00:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => [],
    }))

    expect(result).toContain("1 hour")
    expect(result).not.toContain("1 hours")
  })

  it("shows singular journal entry since surface", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const lastSurface = new Date("2026-03-26T10:00:00Z")
    const files = [
      { name: "entry.md", mtime: nowDate.getTime() - 1 * 3600000, preview: "Single entry" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      lastSurfaceAt: lastSurface.toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("1 journal entry since you last surfaced")
    expect(result).not.toContain("1 journal entries")
  })

  it("does not show surface gap when no entries since surface", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const lastSurface = new Date("2026-03-26T11:00:00Z")
    const files = [
      // This file is from before the surface
      { name: "old.md", mtime: nowDate.getTime() - 3 * 3600000, preview: "Old entry" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      lastSurfaceAt: lastSurface.toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).not.toContain("since you last surfaced")
  })

  it("handles journal files without preview", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const files = [
      { name: "empty.md", mtime: nowDate.getTime() - 1 * 3600000, preview: "" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T11:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("empty.md")
    // Should not have " — " since no preview
    expect(result).not.toContain("empty.md (1 hour ago) —")
  })

  it("shows singular hour in journal recency", () => {
    const nowDate = new Date("2026-03-26T13:00:00Z")
    const files = [
      { name: "entry.md", mtime: nowDate.getTime() - 1 * 3600000, preview: "One hour old" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T12:30:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("1 hour ago")
    expect(result).not.toContain("1 hours ago")
  })

  it("shows singular minute in journal recency", () => {
    const nowDate = new Date("2026-03-26T12:01:00Z")
    const files = [
      { name: "entry.md", mtime: nowDate.getTime() - 60000, preview: "One minute old" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T12:00:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("1 minute ago")
    expect(result).not.toContain("1 minutes ago")
  })

  it("skips elapsed time when journal exists but no lastCompletedAt", () => {
    const nowDate = new Date("2026-03-26T12:00:00Z")
    const files = [
      { name: "entry.md", mtime: nowDate.getTime() - 2 * 3600000, preview: "Something" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: undefined,
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    // Should NOT contain "since your last turn" because no lastCompletedAt
    expect(result).not.toContain("since your last turn")
    // But should contain journal index
    expect(result).toContain("entry.md")
    // Should not be cold-start (we have journal)
    expect(result).not.toContain("anything stirring?")
  })

  it("shows multiple minutes in journal recency for 5 minutes ago", () => {
    const nowDate = new Date("2026-03-26T12:05:00Z")
    const files = [
      { name: "entry.md", mtime: nowDate.getTime() - 5 * 60000, preview: "Five minutes" },
    ]

    const result = buildContextualHeartbeat(makeOptions({
      lastCompletedAt: new Date("2026-03-26T12:00:00Z").toISOString(),
      now: () => nowDate,
      readJournalDir: () => files,
    }))

    expect(result).toContain("5 minutes ago")
  })
})
