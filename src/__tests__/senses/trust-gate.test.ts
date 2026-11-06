import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { enforceTrustGate, STRANGER_AUTO_REPLY } from "../../senses/trust-gate"
import type { FriendRecord, SenseType } from "../../mind/friends/types"
import type { TrustGateInput, TrustGateResult } from "../../senses/trust-gate"

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-03-07T00:00:00.000Z",
    updatedAt: "2026-03-07T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

function makeInput(overrides: Partial<TrustGateInput> = {}): TrustGateInput {
  return {
    friend: makeFriend(),
    provider: "aad",
    externalId: "aad-123",
    channel: "teams",
    senseType: "closed",
    isGroupChat: false,
    groupHasFamilyMember: false,
    hasExistingGroupWithFamily: false,
    bundleRoot: "",
    now: () => new Date("2026-03-07T01:00:00.000Z"),
    ...overrides,
  }
}

describe("trust gate", () => {
  let bundleRoot: string

  beforeEach(() => {
    bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trust-gate-test-"))
  })

  // ── CLI (local sense) ─────────────────────────────────────────────

  describe("CLI (local sense type)", () => {
    it("allows stranger on CLI", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "local",
        channel: "cli",
        provider: "local",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("allows acquaintance on CLI", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "local",
        channel: "cli",
        provider: "local",
        friend: makeFriend({ trustLevel: "acquaintance" }),
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("allows family on CLI", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "local",
        channel: "cli",
        provider: "local",
        friend: makeFriend({ trustLevel: "family" }),
      }))
      expect(result).toEqual({ allowed: true })
    })
  })

  // ── Internal (inner dialog) ───────────────────────────────────────

  describe("internal sense type", () => {
    it("allows any trust level on internal channel", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "internal",
        channel: "inner",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))
      expect(result).toEqual({ allowed: true })
    })
  })

  // ── Closed sense (Teams) ──────────────────────────────────────────

  describe("closed sense (Teams)", () => {
    it("allows stranger on Teams", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "closed",
        channel: "teams",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("allows acquaintance on Teams", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "closed",
        channel: "teams",
        friend: makeFriend({ trustLevel: "acquaintance" }),
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("allows family on Teams", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "closed",
        channel: "teams",
        friend: makeFriend({ trustLevel: "family" }),
      }))
      expect(result).toEqual({ allowed: true })
    })
  })

  // ── Open sense (BB) — friend/family ───────────────────────────────

  describe("open sense — friend/family", () => {
    it("allows friend on BB", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "friend" }),
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("allows family on BB", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "family" }),
      }))
      expect(result).toEqual({ allowed: true })
    })
  })

  // ── Open sense (BB) — stranger ────────────────────────────────────

  describe("open sense — stranger", () => {
    it("rejects stranger first contact with auto-reply", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-first-1",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("stranger_first_reply")
        expect(result.autoReply).toBe(STRANGER_AUTO_REPLY)
      }
    })

    it("rejects stranger subsequent contact silently", () => {
      // First contact
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-subsequent-1",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      // Second contact — should be silent
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-subsequent-1",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      expect(result).toEqual({
        allowed: false,
        reason: "stranger_silent_drop",
      })
    })

    it("writes pending notice to inner channel on stranger rejection", () => {
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-notice-1",
        friend: makeFriend({ trustLevel: "stranger", name: "Unknown Person" }),
      }))

      // Check that a pending notice was written to the inner channel dir
      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.existsSync(innerPendingDir)).toBe(true)
      const files = fs.readdirSync(innerPendingDir)
      expect(files.length).toBeGreaterThanOrEqual(1)

      const content = JSON.parse(fs.readFileSync(path.join(innerPendingDir, files[0]), "utf-8"))
      expect(content.from).toBe("instinct")
      expect(content.content).toContain("stranger")
    })

    it("persists stranger reply state to file", () => {
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-persist-1",
        tenantId: "t1",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      const repliesPath = path.join(bundleRoot, "stranger-replies.json")
      const state = JSON.parse(fs.readFileSync(repliesPath, "utf8"))
      expect(Object.keys(state)).toHaveLength(1)
    })

    it("appends primary notification on first stranger contact", () => {
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-notif-1",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      const notificationsPath = path.join(bundleRoot, "inbox", "primary-notifications.jsonl")
      const lines = fs.readFileSync(notificationsPath, "utf8").trim().split("\n")
      expect(lines.length).toBe(1)
      expect(lines[0]).toContain("Unknown contact")
    })

    it("does not append primary notification on subsequent stranger contact", () => {
      // First contact
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-no-second-notif",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      // Second contact
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-no-second-notif",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      const notificationsPath = path.join(bundleRoot, "inbox", "primary-notifications.jsonl")
      const lines = fs.readFileSync(notificationsPath, "utf8").trim().split("\n")
      expect(lines.length).toBe(1)
    })
  })

  // ── Open sense (BB) — acquaintance ────────────────────────────────

  describe("open sense — acquaintance", () => {
    it("allows acquaintance in group chat WITH family member present", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "acquaintance" }),
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("rejects acquaintance in group chat WITHOUT family member", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "acquaintance" }),
        isGroupChat: true,
        groupHasFamilyMember: false,
      }))

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("acquaintance_group_no_family")
      }
    })

    it("rejects acquaintance in 1:1 with existing group that has family — reach me in our group chat", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "acquaintance" }),
        isGroupChat: false,
        hasExistingGroupWithFamily: true,
      }))

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("acquaintance_1on1_has_group")
        expect(result.autoReply).toContain("our group chat")
      }
    })

    it("rejects acquaintance in 1:1 without existing group — reach me in a group chat", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "acquaintance" }),
        isGroupChat: false,
        hasExistingGroupWithFamily: false,
      }))

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("acquaintance_1on1_no_group")
        expect(result.autoReply).toContain("a group chat")
      }
    })

    it("writes pending notice to inner channel on acquaintance rejection", () => {
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "acquaintance", name: "SomeAcquaintance" }),
        isGroupChat: false,
        hasExistingGroupWithFamily: false,
      }))

      // Check that a pending notice was written to the inner channel dir
      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.existsSync(innerPendingDir)).toBe(true)
      const files = fs.readdirSync(innerPendingDir)
      expect(files.length).toBeGreaterThanOrEqual(1)

      const content = JSON.parse(fs.readFileSync(path.join(innerPendingDir, files[0]), "utf-8"))
      expect(content.from).toBe("instinct")
      expect(content.content).toContain("acquaintance")
    })
  })

  // ── Open sense (BB) — group family override (any trust level) ─────

  describe("open sense — group family override", () => {
    it("allows stranger in group chat WITH family member present", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "stranger" }),
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("rejects stranger in group chat WITHOUT family member (first contact auto-reply)", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-group-no-family-1",
        friend: makeFriend({ trustLevel: "stranger" }),
        isGroupChat: true,
        groupHasFamilyMember: false,
      }))

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("stranger_first_reply")
        expect(result.autoReply).toBe(STRANGER_AUTO_REPLY)
      }
    })

    it("silently drops stranger in group chat WITHOUT family member on subsequent contact", () => {
      // First contact
      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-group-no-family-subsequent",
        friend: makeFriend({ trustLevel: "stranger" }),
        isGroupChat: true,
        groupHasFamilyMember: false,
      }))

      // Second contact — silent drop
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-group-no-family-subsequent",
        friend: makeFriend({ trustLevel: "stranger" }),
        isGroupChat: true,
        groupHasFamilyMember: false,
      }))

      expect(result).toEqual({
        allowed: false,
        reason: "stranger_silent_drop",
      })
    })

    it("allows acquaintance in group chat WITH family member (regression)", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: "acquaintance" }),
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("surfaces an inner-pending notice the FIRST time an auto-created stranger group is allowed via the family-member shortcut", () => {
      const friendId = "friend-auto-group-1"
      const friend = makeFriend({
        id: friendId,
        name: "Consciousness TBD",
        trustLevel: "stranger",
        notes: {
          name: { value: "Consciousness TBD", savedAt: "2026-03-14T23:12:21.302Z" },
          autoCreatedGroup: { value: "true", savedAt: "2026-03-14T23:12:21.302Z" },
        },
      })

      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "group:any;+;abc123",
        friend,
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))

      expect(result).toEqual({ allowed: true })
      // Notice was written to inner-pending dir
      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      const noticeFiles = fs.readdirSync(innerPendingDir)
      expect(noticeFiles).toHaveLength(1)
      const notice = JSON.parse(fs.readFileSync(path.join(innerPendingDir, noticeFiles[0]!), "utf-8"))
      expect(notice.from).toBe("instinct")
      expect(notice.content).toContain("Consciousness TBD")
      expect(notice.content).toContain("group:any;+;abc123")
      expect(notice.content).toContain(friendId)
      // Acknowledgment state was persisted to prevent re-surfacing
      const stateFile = path.join(bundleRoot, "state", "acknowledged-auto-groups.json")
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
      expect(state[friendId]).toEqual(expect.objectContaining({ surfacedAt: expect.any(String) }))
    })

    it("does NOT re-surface an auto-created stranger group on subsequent allowed messages", () => {
      const friendId = "friend-auto-group-2"
      const friend = makeFriend({
        id: friendId,
        name: "Consciousness TBD",
        trustLevel: "stranger",
        notes: { autoCreatedGroup: { value: "true", savedAt: "2026-03-14T23:12:21.302Z" } },
      })
      const inputs = {
        bundleRoot,
        senseType: "open" as const,
        channel: "bluebubbles" as const,
        provider: "imessage-handle" as const,
        externalId: "group:any;+;abc456",
        friend,
        isGroupChat: true,
        groupHasFamilyMember: true,
      }

      enforceTrustGate(makeInput(inputs))
      enforceTrustGate(makeInput(inputs))
      enforceTrustGate(makeInput(inputs))

      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      const noticeFiles = fs.readdirSync(innerPendingDir)
      expect(noticeFiles).toHaveLength(1)
    })

    it("does NOT surface a stranger group that lacks the autoCreatedGroup marker (operator-promoted)", () => {
      const friend = makeFriend({
        id: "friend-manual-1",
        name: "Manually Added Group",
        trustLevel: "stranger",
        notes: { name: { value: "Manually Added Group", savedAt: "2026-03-14T23:12:21.302Z" } },
      })

      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "group:any;+;manual-1",
        friend,
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))

      expect(result).toEqual({ allowed: true })
      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.existsSync(innerPendingDir)).toBe(false)
    })

    it("treats an empty acknowledged-auto-groups.json file as no prior surfaces (still surfaces once)", () => {
      const friend = makeFriend({
        id: "friend-empty-state-1",
        name: "Empty State Group",
        trustLevel: "stranger",
        notes: { autoCreatedGroup: { value: "true", savedAt: "2026-03-14T23:12:21.302Z" } },
      })
      // Pre-create an empty state file
      const stateDir = path.join(bundleRoot, "state")
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, "acknowledged-auto-groups.json"), "", "utf-8")

      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "group:any;+;empty-1",
        friend,
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))
      expect(result).toEqual({ allowed: true })

      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.readdirSync(innerPendingDir)).toHaveLength(1)
    })

    it("treats malformed acknowledged-auto-groups.json content as no prior surfaces", () => {
      const friend = makeFriend({
        id: "friend-malformed-state-1",
        name: "Malformed State Group",
        trustLevel: "stranger",
        notes: { autoCreatedGroup: { value: "true", savedAt: "2026-03-14T23:12:21.302Z" } },
      })
      const stateDir = path.join(bundleRoot, "state")
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, "acknowledged-auto-groups.json"), "{ not valid json", "utf-8")

      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "group:any;+;malformed-1",
        friend,
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))

      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.readdirSync(innerPendingDir)).toHaveLength(1)
    })

    it("treats acknowledged-auto-groups.json containing an array as no prior surfaces", () => {
      const friend = makeFriend({
        id: "friend-array-state-1",
        name: "Array State Group",
        trustLevel: "stranger",
        notes: { autoCreatedGroup: { value: "true", savedAt: "2026-03-14T23:12:21.302Z" } },
      })
      const stateDir = path.join(bundleRoot, "state")
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, "acknowledged-auto-groups.json"), "[]", "utf-8")

      enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "group:any;+;array-1",
        friend,
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))

      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.readdirSync(innerPendingDir)).toHaveLength(1)
    })

    it("does NOT surface an auto-created group whose trustLevel has been promoted (acknowledged via promotion)", () => {
      const friend = makeFriend({
        id: "friend-promoted-1",
        name: "Promoted Group",
        trustLevel: "friend",
        notes: { autoCreatedGroup: { value: "true", savedAt: "2026-03-14T23:12:21.302Z" } },
      })

      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "group:any;+;promoted-1",
        friend,
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))

      expect(result).toEqual({ allowed: true })
      const innerPendingDir = path.join(bundleRoot, "state", "pending", "self", "inner", "dialog")
      expect(fs.existsSync(innerPendingDir)).toBe(false)
    })

    it("allows stranger with existing stranger-replies entry when group has family member", () => {
      // Pre-seed stranger-replies.json with an existing entry for this external key
      const repliesPath = path.join(bundleRoot, "stranger-replies.json")
      const externalKey = "imessage-handle::stranger-with-replies-and-family"
      fs.writeFileSync(repliesPath, JSON.stringify({ [externalKey]: "2026-03-07T00:00:00.000Z" }), "utf8")

      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-with-replies-and-family",
        friend: makeFriend({ trustLevel: "stranger" }),
        isGroupChat: true,
        groupHasFamilyMember: true,
      }))

      // Family check should run BEFORE stranger-replies lookup, so this should be allowed
      expect(result).toEqual({ allowed: true })
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("recovers from malformed stranger-replies.json", () => {
      fs.writeFileSync(path.join(bundleRoot, "stranger-replies.json"), "{bad-json", "utf8")

      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-malformed",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("stranger_first_reply")
      }
    })

    it("treats empty stranger-replies.json as empty state", () => {
      fs.writeFileSync(path.join(bundleRoot, "stranger-replies.json"), "", "utf8")

      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-empty-state",
        friend: makeFriend({ trustLevel: "stranger" }),
      }))

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("stranger_first_reply")
      }
    })

    it("treats array stranger-replies payload as empty and uses default now timestamp", () => {
      fs.writeFileSync(path.join(bundleRoot, "stranger-replies.json"), "[]", "utf8")

      // Explicitly omit `now` to exercise the default Date fallback
      const input = makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        externalId: "stranger-array-state",
        friend: makeFriend({ trustLevel: "stranger" }),
      })
      delete (input as any).now

      const result = enforceTrustGate(input)

      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(result.reason).toBe("stranger_first_reply")
      }

      // Verify the timestamp was generated (not from our fixture)
      const repliesPath = path.join(bundleRoot, "stranger-replies.json")
      const state = JSON.parse(fs.readFileSync(repliesPath, "utf8"))
      const timestamps = Object.values(state) as string[]
      expect(timestamps).toHaveLength(1)
      expect(timestamps[0]).toMatch(/^20\d\d-/)
    })

    it("defaults trustLevel to friend when not set", () => {
      const result = enforceTrustGate(makeInput({
        bundleRoot,
        senseType: "open",
        channel: "bluebubbles",
        provider: "imessage-handle",
        friend: makeFriend({ trustLevel: undefined }),
      }))
      expect(result).toEqual({ allowed: true })
    })

    it("still blocks acquaintance when bundleRoot points to an existing file (pending notice fails)", () => {
      const invalidBundleRoot = path.join(os.tmpdir(), `trust-gate-acq-invalid-${Date.now()}.txt`)
      fs.writeFileSync(invalidBundleRoot, "occupied", "utf8")

      try {
        const result = enforceTrustGate(makeInput({
          bundleRoot: invalidBundleRoot,
          senseType: "open",
          channel: "bluebubbles",
          provider: "imessage-handle",
          friend: makeFriend({ trustLevel: "acquaintance" }),
          isGroupChat: false,
          hasExistingGroupWithFamily: false,
        }))

        expect(result.allowed).toBe(false)
        if (!result.allowed) {
          expect(result.reason).toBe("acquaintance_1on1_no_group")
        }
      } finally {
        fs.unlinkSync(invalidBundleRoot)
      }
    })

    it("still blocks stranger when bundleRoot points to an existing file", () => {
      const invalidBundleRoot = path.join(os.tmpdir(), `trust-gate-invalid-${Date.now()}.txt`)
      fs.writeFileSync(invalidBundleRoot, "occupied", "utf8")

      try {
        const result = enforceTrustGate(makeInput({
          bundleRoot: invalidBundleRoot,
          senseType: "open",
          channel: "bluebubbles",
          provider: "imessage-handle",
          externalId: "stranger-invalid-root",
          friend: makeFriend({ trustLevel: "stranger" }),
        }))

        expect(result.allowed).toBe(false)
        if (!result.allowed) {
          expect(result.reason).toBe("stranger_first_reply")
          expect(result.autoReply).toBe(STRANGER_AUTO_REPLY)
        }
      } finally {
        fs.unlinkSync(invalidBundleRoot)
      }
    })
  })
})

describe("trust gate error branches (module mocks)", () => {
  it("still blocks stranger when reply-state persistence fails", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(() => {
        throw "disk full"
      }),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }))
    vi.doMock("../../heart/identity", () => ({ getAgentRoot: () => "/mock/bundle" }))
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))

    const { enforceTrustGate: dynamicGate, STRANGER_AUTO_REPLY: dynamicReply } = await import("../../senses/trust-gate")
    const result = dynamicGate({
      provider: "aad",
      externalId: "aad-stranger-write-fail",
      channel: "teams",
      senseType: "open",
      isGroupChat: false,
      groupHasFamilyMember: false,
      hasExistingGroupWithFamily: false,
      friend: makeFriend({ trustLevel: "stranger" }),
      now: () => new Date("2026-03-07T01:05:00.000Z"),
    })

    expect(result).toEqual({
      allowed: false,
      reason: "stranger_first_reply",
      autoReply: dynamicReply,
    })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.trust_gate_error",
      message: "failed to persist stranger reply state",
      component: "senses",
    }))
  })

  it("still blocks stranger when primary notification append fails", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(() => {
        throw "append failed"
      }),
    }))
    vi.doMock("../../heart/identity", () => ({ getAgentRoot: () => "/mock/bundle" }))
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))

    const { enforceTrustGate: dynamicGate, STRANGER_AUTO_REPLY: dynamicReply } = await import("../../senses/trust-gate")
    const result = dynamicGate({
      provider: "aad",
      externalId: "aad-stranger-append-fail",
      channel: "teams",
      senseType: "open",
      isGroupChat: false,
      groupHasFamilyMember: false,
      hasExistingGroupWithFamily: false,
      friend: makeFriend({ trustLevel: "stranger" }),
      now: () => new Date("2026-03-07T01:06:00.000Z"),
    })

    expect(result).toEqual({
      allowed: false,
      reason: "stranger_first_reply",
      autoReply: dynamicReply,
    })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.trust_gate_error",
      message: "failed to persist primary stranger notification",
      component: "senses",
    }))
  })

  it("still blocks stranger when inner pending notice write fails", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    let mkdirCallCount = 0

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn((p: string) => {
        // Let stranger-replies.json write succeed, but fail inner pending write
        if (typeof p === "string" && p.includes("pending")) {
          throw "pending write failed"
        }
      }),
      mkdirSync: vi.fn(() => { mkdirCallCount++ }),
      appendFileSync: vi.fn(),
    }))
    vi.doMock("../../heart/identity", () => ({ getAgentRoot: () => "/mock/bundle" }))
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))

    const { enforceTrustGate: dynamicGate, STRANGER_AUTO_REPLY: dynamicReply } = await import("../../senses/trust-gate")
    const result = dynamicGate({
      provider: "aad",
      externalId: "aad-stranger-pending-fail",
      channel: "teams",
      senseType: "open",
      isGroupChat: false,
      groupHasFamilyMember: false,
      hasExistingGroupWithFamily: false,
      friend: makeFriend({ trustLevel: "stranger" }),
      now: () => new Date("2026-03-07T01:07:00.000Z"),
    })

    // Gate should still block even if pending notice write fails
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe("stranger_first_reply")
      expect(result.autoReply).toBe(dynamicReply)
    }
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.trust_gate_error",
      message: "failed to write inner pending notice",
      component: "senses",
    }))
  })

  it("still blocks acquaintance when inner pending notice write fails with non-Error", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()

    vi.doMock("fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ""),
      writeFileSync: vi.fn((p: string) => {
        if (typeof p === "string" && p.includes("pending")) {
          throw "acquaintance pending write failed"
        }
      }),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }))
    vi.doMock("../../heart/identity", () => ({ getAgentRoot: () => "/mock/bundle" }))
    vi.doMock("../../nerves/runtime", () => ({ emitNervesEvent }))

    const { enforceTrustGate: dynamicGate } = await import("../../senses/trust-gate")
    const result = dynamicGate({
      provider: "imessage-handle",
      externalId: "acq-pending-fail",
      channel: "bluebubbles",
      senseType: "open",
      isGroupChat: false,
      groupHasFamilyMember: false,
      hasExistingGroupWithFamily: false,
      friend: makeFriend({ trustLevel: "acquaintance" }),
      now: () => new Date("2026-03-07T01:08:00.000Z"),
    })

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toBe("acquaintance_1on1_no_group")
    }
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.trust_gate_error",
      message: "failed to write inner pending notice",
      component: "senses",
      meta: expect.objectContaining({
        reason: "acquaintance pending write failed",
      }),
    }))
  })
})
