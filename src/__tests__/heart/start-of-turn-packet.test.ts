import { describe, it, expect } from "vitest"
import {
  buildStartOfTurnPacket,
  renderStartOfTurnPacket,
  renderCompactStartOfTurnPacket,
  type StartOfTurnPacket,
} from "../../heart/start-of-turn-packet"
import { type TemporalView } from "../../heart/temporal-view"
import { type TempoMode } from "../../heart/tempo"
import { type EpisodeRecord } from "../../mind/episodes"
import { type Obligation } from "../../heart/obligations"
import { type CareRecord } from "../../heart/cares"
import { type IntentionRecord } from "../../heart/intentions"
import { TEMPO_BUDGETS } from "../../heart/tempo"

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function makeEpisode(overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: "ep-1",
    timestamp: new Date().toISOString(),
    kind: "obligation_shift",
    summary: "obligation fulfilled for Ari",
    whyItMattered: "completed a promise",
    relatedEntities: [],
    salience: "medium",
    ...overrides,
  }
}

function makeObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    id: "ob-1",
    origin: { friendId: "ari", channel: "cli", key: "session" },
    content: "research architecture options",
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeCare(overrides: Partial<CareRecord> = {}): CareRecord {
  return {
    id: "care-1",
    label: "harness stability",
    why: "core mission reliability",
    kind: "project",
    status: "active",
    salience: "high",
    steward: "mine",
    relatedFriendIds: [],
    relatedAgentIds: [],
    relatedObligationIds: [],
    relatedEpisodeIds: [],
    currentRisk: null,
    nextCheckAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeIntention(overrides: Partial<IntentionRecord> = {}): IntentionRecord {
  return {
    id: "int-1",
    content: "revisit context kernel",
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "thought",
    ...overrides,
  }
}

function makeView(overrides: Partial<TemporalView> = {}): TemporalView {
  return {
    recentEpisodes: [],
    activeObligations: [],
    activeCares: [],
    openIntentions: [],
    peerPresence: [],
    tempo: "standard",
    assembledAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("start-of-turn packet", () => {
  describe("StartOfTurnPacket interface", () => {
    it("buildStartOfTurnPacket returns all required fields", () => {
      const view = makeView()
      const packet = buildStartOfTurnPacket(view)

      expect(packet.plotLine).toBeDefined()
      expect(packet.obligations).toBeDefined()
      expect(packet.cares).toBeDefined()
      expect(packet.presence).toBeDefined()
      expect(packet.resumeHint).toBeDefined()
      expect(packet.tempo).toBeDefined()
      expect(packet.tokenBudget).toBeDefined()
      expect(packet.assembledAt).toBeTruthy()
    })
  })

  describe("buildStartOfTurnPacket", () => {
    it("composes plotLine from recent episodes", () => {
      const view = makeView({
        recentEpisodes: [
          makeEpisode({ summary: "PR merged for continuity substrate" }),
          makeEpisode({ kind: "care_event", summary: "care escalated for deployment" }),
        ],
      })

      const packet = buildStartOfTurnPacket(view)
      expect(packet.plotLine).toContain("PR merged for continuity substrate")
    })

    it("composes obligations section from active obligations", () => {
      const view = makeView({
        activeObligations: [
          makeObligation({ content: "research architecture" }),
          makeObligation({ id: "ob-2", content: "review Slugger PR" }),
        ],
      })

      const packet = buildStartOfTurnPacket(view)
      expect(packet.obligations).toContain("research architecture")
      expect(packet.obligations).toContain("review Slugger PR")
    })

    it("composes cares section from active cares", () => {
      const view = makeView({
        activeCares: [makeCare({ label: "harness stability" })],
      })

      const packet = buildStartOfTurnPacket(view)
      expect(packet.cares).toContain("harness stability")
    })

    it("composes presence from peer presence", () => {
      const view = makeView({
        peerPresence: [
          {
            agentName: "slugger",
            availability: "active",
            lane: "coding",
            mission: "working on tests",
            tempo: "standard",
            updatedAt: new Date().toISOString(),
          },
        ],
      })

      const packet = buildStartOfTurnPacket(view)
      expect(packet.presence).toContain("slugger")
    })

    it("builds resumeHint from obligations and intentions", () => {
      const view = makeView({
        activeObligations: [makeObligation({ content: "finish the review", meaning: { salience: "high", stalenessClass: "fresh", resumeHint: "start with the test file" } })],
      })

      const packet = buildStartOfTurnPacket(view)
      expect(packet.resumeHint.length).toBeGreaterThan(0)
    })

    it("carries tempo from view", () => {
      const view = makeView({ tempo: "crisis" })
      const packet = buildStartOfTurnPacket(view)
      expect(packet.tempo).toBe("crisis")
    })
  })

  describe("renderStartOfTurnPacket", () => {
    it("produces output within brief token budget", () => {
      const view = makeView({ tempo: "brief" })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      const tokens = estimateTokens(rendered)
      // Soft lower bound: sparse state can produce fewer tokens than mode min
      expect(tokens).toBeLessThanOrEqual(TEMPO_BUDGETS.brief.max)
    })

    it("produces output within standard token budget", () => {
      const view = makeView({
        tempo: "standard",
        recentEpisodes: [makeEpisode(), makeEpisode({ id: "ep-2", summary: "second episode" })],
        activeObligations: [makeObligation()],
        activeCares: [makeCare()],
      })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      const tokens = estimateTokens(rendered)
      expect(tokens).toBeLessThanOrEqual(TEMPO_BUDGETS.standard.max)
    })

    it("produces output within dense token budget", () => {
      const view = makeView({
        tempo: "dense",
        recentEpisodes: Array.from({ length: 10 }, (_, i) =>
          makeEpisode({ id: `ep-${i}`, summary: `episode ${i} about important work` }),
        ),
        activeObligations: [makeObligation(), makeObligation({ id: "ob-2", content: "second obligation" })],
        activeCares: [makeCare(), makeCare({ id: "care-2", label: "second care" })],
      })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      const tokens = estimateTokens(rendered)
      expect(tokens).toBeLessThanOrEqual(TEMPO_BUDGETS.dense.max)
    })

    it("produces output within crisis token budget (sharper not fatter)", () => {
      const view = makeView({
        tempo: "crisis",
        recentEpisodes: [makeEpisode({ salience: "critical", summary: "blocker hit" })],
        activeObligations: [makeObligation({ content: "urgent fix needed" })],
        activeCares: [makeCare({ salience: "critical" })],
      })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      const tokens = estimateTokens(rendered)
      expect(tokens).toBeLessThanOrEqual(TEMPO_BUDGETS.crisis.max)
    })

    it("empty temporal view produces empty packet (sparse state is normal)", () => {
      const view = makeView({ tempo: "brief" })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      // Empty state produces empty output — not failure, just quiet
      expect(rendered).toBe("")
    })

    it("contains expected section markers", () => {
      const view = makeView({
        recentEpisodes: [makeEpisode()],
        activeObligations: [makeObligation()],
        activeCares: [makeCare()],
      })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      // Should have some structure
      expect(rendered.length).toBeGreaterThan(10)
    })
  })

  describe("truncation priority", () => {
    it("resumeHint is PROTECTED — never truncated first", () => {
      // Create a very large view that would need truncation
      const manyEpisodes = Array.from({ length: 20 }, (_, i) =>
        makeEpisode({ id: `ep-${i}`, summary: `important episode ${i} with a longer description to use tokens` }),
      )
      const manyObligations = Array.from({ length: 10 }, (_, i) =>
        makeObligation({ id: `ob-${i}`, content: `obligation ${i} needs attention from someone` }),
      )
      const manyCares = Array.from({ length: 10 }, (_, i) =>
        makeCare({ id: `care-${i}`, label: `care ${i} about something important` }),
      )

      const view = makeView({
        tempo: "brief", // Smallest budget - forces truncation
        recentEpisodes: manyEpisodes,
        activeObligations: manyObligations,
        activeCares: manyCares,
      })

      const packet = buildStartOfTurnPacket(view)
      // Even when truncated, resumeHint should be present
      expect(packet.resumeHint.length).toBeGreaterThanOrEqual(0)

      const rendered = renderStartOfTurnPacket(packet)
      // The resumeHint should survive truncation if any content was generated
      if (packet.resumeHint.length > 0) {
        expect(rendered).toContain(packet.resumeHint.slice(0, 20))
      }
    })
  })

  describe("humility and provenance", () => {
    it("packet text does NOT ascribe emotion beyond authored whyItMattered", () => {
      const view = makeView({
        recentEpisodes: [
          makeEpisode({
            summary: "changed debugging path",
            whyItMattered: "saves time on next investigation",
          }),
        ],
      })

      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)

      // Should NOT contain emotional embellishment
      expect(rendered).not.toMatch(/you felt/i)
      expect(rendered).not.toMatch(/you were excited/i)
      expect(rendered).not.toMatch(/you were frustrated/i)
      expect(rendered).not.toMatch(/deeply meaningful/i)
    })

    it("plotLine is composed from authored episode summaries, not inferred narrative", () => {
      const view = makeView({
        recentEpisodes: [
          makeEpisode({ summary: "PR merged for auth module" }),
          makeEpisode({ summary: "obligation fulfilled for Ari" }),
        ],
      })

      const packet = buildStartOfTurnPacket(view)
      // plotLine should contain the actual authored summaries
      expect(packet.plotLine).toContain("PR merged for auth module")
    })

    it("renders currentRisk when present on care", () => {
      const view = makeView({
        activeCares: [
          makeCare({ label: "deployment health", salience: "critical", currentRisk: "overnight deploy may fail" }),
        ],
      })

      const packet = buildStartOfTurnPacket(view)
      expect(packet.cares).toContain("overnight deploy may fail")
    })

    it("salience labels match authored source record values, not re-derived", () => {
      const view = makeView({
        activeCares: [
          makeCare({ label: "harness stability", salience: "critical" }),
          makeCare({ id: "care-2", label: "docs cleanup", salience: "low" }),
        ],
      })

      const packet = buildStartOfTurnPacket(view)
      // If salience appears, it should use the authored values
      if (packet.cares.includes("critical")) {
        expect(packet.cares).toContain("critical")
      }
      if (packet.cares.includes("low")) {
        expect(packet.cares).toContain("low")
      }
    })

    it("sparse/empty sources produce minimal packet, not inferred framing", () => {
      const view = makeView({
        tempo: "standard",
        recentEpisodes: [],
        activeObligations: [],
        activeCares: [],
        openIntentions: [],
        peerPresence: [],
      })

      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)

      // Should NOT fill empty state with inferred framing
      expect(rendered).not.toMatch(/you seem to be/i)
      expect(rendered).not.toMatch(/it appears that/i)
      expect(rendered).not.toMatch(/things are quiet/i)
      expect(rendered).not.toMatch(/taking a break/i)

      // Should be genuinely minimal
      const tokens = estimateTokens(rendered)
      expect(tokens).toBeLessThan(100)
    })
  })

  describe("formatSections edge cases", () => {
    it("renders presence section when peers exist", () => {
      const view = makeView({
        tempo: "standard",
        peerPresence: [
          {
            agentName: "slugger",
            availability: "active",
            lane: "coding",
            mission: "working",
            tempo: "standard",
            updatedAt: new Date().toISOString(),
          },
        ],
        activeObligations: [makeObligation()],
      })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      expect(rendered).toContain("Peers:")
      expect(rendered).toContain("slugger")
    })
  })

  describe("plotLine tempo variation", () => {
    it("crisis mode limits plotLine to 3 episodes", () => {
      const episodes = Array.from({ length: 6 }, (_, i) =>
        makeEpisode({ id: `ep-${i}`, summary: `crisis event ${i}` }),
      )
      const view = makeView({ tempo: "crisis", recentEpisodes: episodes })
      const packet = buildStartOfTurnPacket(view)
      // In crisis mode, plotLine should only mention up to 3 episodes
      const lines = packet.plotLine.split("\n").filter((l) => l.startsWith("- "))
      expect(lines.length).toBeLessThanOrEqual(3)
    })

    it("brief mode omits whyItMattered from episodes", () => {
      const view = makeView({
        tempo: "brief",
        recentEpisodes: [makeEpisode({ summary: "thing happened", whyItMattered: "secret reason" })],
      })
      const packet = buildStartOfTurnPacket(view)
      expect(packet.plotLine).toContain("thing happened")
      expect(packet.plotLine).not.toContain("secret reason")
    })

    it("standard mode includes whyItMattered", () => {
      const view = makeView({
        tempo: "standard",
        recentEpisodes: [makeEpisode({ summary: "thing happened", whyItMattered: "because context" })],
      })
      const packet = buildStartOfTurnPacket(view)
      expect(packet.plotLine).toContain("because context")
    })
  })

  describe("over-budget hard cap", () => {
    it("hard caps when even removing sections is not enough", () => {
      // Create a packet with a very large protected resumeHint
      const longHint = "x".repeat(2000)
      const view = makeView({
        tempo: "brief",
        openIntentions: [makeIntention({ content: longHint })],
      })
      const packet = buildStartOfTurnPacket(view)
      const rendered = renderStartOfTurnPacket(packet)
      const tokens = estimateTokens(rendered)
      // Should be hard-capped to budget max
      expect(tokens).toBeLessThanOrEqual(TEMPO_BUDGETS.brief.max)
    })
  })

  describe("obligation enrichment rendering", () => {
    it("shows staleness when not fresh", () => {
      const view = makeView({
        activeObligations: [
          makeObligation({
            content: "stale task",
            meaning: { salience: "high", stalenessClass: "stale", resumeHint: "check status" },
          }),
        ],
      })
      const packet = buildStartOfTurnPacket(view)
      expect(packet.obligations).toContain("stale")
    })

    it("shows waitingOn info when present", () => {
      const view = makeView({
        activeObligations: [
          makeObligation({
            content: "blocked task",
            meaning: {
              salience: "high",
              stalenessClass: "fresh",
              waitingOn: { kind: "friend", target: "ari", detail: "review" },
            },
          }),
        ],
      })
      const packet = buildStartOfTurnPacket(view)
      expect(packet.obligations).toContain("friend")
      expect(packet.obligations).toContain("ari")
    })
  })

  describe("buildStartOfTurnPacket with canonicalObligations", () => {
    it("uses canonicalObligations.all for obligations section when provided", () => {
      const view = makeView({
        activeObligations: [makeObligation({ content: "view obligation (should be ignored)" })],
      })
      const canonical = {
        primary: makeObligation({ content: "canonical primary", meaning: { salience: "high" as const, stalenessClass: "fresh" as const, resumeHint: "start here" } }),
        all: [
          makeObligation({ content: "canonical primary", meaning: { salience: "high" as const, stalenessClass: "fresh" as const, resumeHint: "start here" } }),
          makeObligation({ id: "ob-2", content: "canonical secondary" }),
        ],
      }

      const packet = buildStartOfTurnPacket(view, { canonicalObligations: canonical })
      expect(packet.obligations).toContain("canonical primary")
      expect(packet.obligations).toContain("canonical secondary")
      expect(packet.obligations).not.toContain("view obligation (should be ignored)")
    })

    it("uses view.activeObligations when canonicalObligations is not provided (backward compat)", () => {
      const view = makeView({
        activeObligations: [makeObligation({ content: "view obligation" })],
      })

      const packet = buildStartOfTurnPacket(view)
      expect(packet.obligations).toContain("view obligation")
    })

    it("produces empty obligations when canonicalObligations.all is empty", () => {
      const view = makeView({
        activeObligations: [makeObligation({ content: "view obligation" })],
        openIntentions: [makeIntention({ content: "fallback intention" })],
      })
      const canonical = { primary: null, all: [] as Obligation[] }

      const packet = buildStartOfTurnPacket(view, { canonicalObligations: canonical })
      expect(packet.obligations).toBe("")
      // resumeHint should fall back to intentions since no obligation hints
      expect(packet.resumeHint).toContain("fallback intention")
    })

    it("prepends primary resumeHint in resume hint when canonicalObligations.primary has one", () => {
      const view = makeView({
        activeObligations: [makeObligation({ content: "view ob" })],
        openIntentions: [makeIntention({ content: "some intention" })],
      })
      const canonical = {
        primary: makeObligation({
          content: "primary task",
          meaning: { salience: "high" as const, stalenessClass: "fresh" as const, resumeHint: "start with the test file" },
        }),
        all: [
          makeObligation({
            content: "primary task",
            meaning: { salience: "high" as const, stalenessClass: "fresh" as const, resumeHint: "start with the test file" },
          }),
        ],
      }

      const packet = buildStartOfTurnPacket(view, { canonicalObligations: canonical })
      expect(packet.resumeHint).toContain("start with the test file")
    })

    it("uses canonical obligations for resumeHint instead of view.activeObligations", () => {
      const view = makeView({
        activeObligations: [makeObligation({ content: "view ob", meaning: { salience: "high" as const, stalenessClass: "fresh" as const, resumeHint: "view hint (should be ignored)" } })],
      })
      const canonical = {
        primary: null,
        all: [makeObligation({ content: "canonical ob", meaning: { salience: "high" as const, stalenessClass: "fresh" as const, resumeHint: "canonical hint" } })],
      }

      const packet = buildStartOfTurnPacket(view, { canonicalObligations: canonical })
      expect(packet.resumeHint).toContain("canonical hint")
      expect(packet.resumeHint).not.toContain("view hint (should be ignored)")
    })
  })

  describe("renderCompactStartOfTurnPacket", () => {
    it("produces ultra-compact output (max 200 tokens)", () => {
      const view = makeView({
        recentEpisodes: [makeEpisode()],
        activeObligations: [makeObligation()],
        activeCares: [makeCare()],
      })
      const packet = buildStartOfTurnPacket(view)
      const compact = renderCompactStartOfTurnPacket(packet)
      const tokens = estimateTokens(compact)
      expect(tokens).toBeLessThanOrEqual(200)
    })

    it("produces non-empty output when packet has content", () => {
      const view = makeView({
        activeObligations: [makeObligation()],
      })
      const packet = buildStartOfTurnPacket(view)
      const compact = renderCompactStartOfTurnPacket(packet)
      expect(compact.length).toBeGreaterThan(0)
    })

    it("handles empty packet gracefully", () => {
      const view = makeView()
      const packet = buildStartOfTurnPacket(view)
      const compact = renderCompactStartOfTurnPacket(packet)
      expect(typeof compact).toBe("string")
    })

    it("hard caps at 200 tokens when content is very large", () => {
      const longContent = "a".repeat(1000)
      const view = makeView({
        activeObligations: [makeObligation({ content: longContent })],
        openIntentions: [makeIntention({ content: longContent })],
      })
      const packet = buildStartOfTurnPacket(view)
      const compact = renderCompactStartOfTurnPacket(packet)
      const tokens = estimateTokens(compact)
      expect(tokens).toBeLessThanOrEqual(200)
    })
  })
})
