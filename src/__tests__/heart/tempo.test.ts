import { describe, it, expect } from "vitest"
import {
  deriveTempo,
  getTokenBudget,
  detectTempoShift,
  TEMPO_BUDGETS,
  type TempoMode,
  type TempoState,
  type TempoSignificance,
  type TempoReentryDepth,
} from "../../heart/tempo"

describe("tempo", () => {
  describe("TempoMode type", () => {
    it("supports all four modes", () => {
      const modes: TempoMode[] = ["brief", "standard", "dense", "crisis"]
      expect(modes).toHaveLength(4)
    })
  })

  describe("TEMPO_BUDGETS", () => {
    it("has correct budget ranges per mode", () => {
      expect(TEMPO_BUDGETS.brief).toEqual({ min: 150, max: 250 })
      expect(TEMPO_BUDGETS.standard).toEqual({ min: 450, max: 700 })
      expect(TEMPO_BUDGETS.dense).toEqual({ min: 900, max: 1100 })
      expect(TEMPO_BUDGETS.crisis).toEqual({ min: 700, max: 1000 })
    })
  })

  describe("deriveTempo", () => {
    it("returns crisis mode when hasBlockers is true", () => {
      const result = deriveTempo({
        activeSessions: 1,
        openObligations: 1,
        recentEpisodeCount: 0,
        lastActivityAgeMs: 1000,
        hasBlockers: true,
        highSalienceEpisodes: 0,
        activeCareCount: 0,
        atRiskCareCount: 0,
      })
      expect(result.mode).toBe("crisis")
    })

    it("returns dense mode when openObligations > 3", () => {
      const result = deriveTempo({
        activeSessions: 1,
        openObligations: 5,
        recentEpisodeCount: 0,
        lastActivityAgeMs: 1000,
        hasBlockers: false,
        highSalienceEpisodes: 0,
        activeCareCount: 0,
        atRiskCareCount: 0,
      })
      expect(result.mode).toBe("dense")
    })

    it("returns dense mode when recentEpisodeCount > 10", () => {
      const result = deriveTempo({
        activeSessions: 1,
        openObligations: 0,
        recentEpisodeCount: 15,
        lastActivityAgeMs: 1000,
        hasBlockers: false,
        highSalienceEpisodes: 0,
        activeCareCount: 0,
        atRiskCareCount: 0,
      })
      expect(result.mode).toBe("dense")
    })

    it("returns standard mode when activeSessions > 0 and no escalators", () => {
      const result = deriveTempo({
        activeSessions: 2,
        openObligations: 1,
        recentEpisodeCount: 3,
        lastActivityAgeMs: 1000,
        hasBlockers: false,
        highSalienceEpisodes: 0,
        activeCareCount: 0,
        atRiskCareCount: 0,
      })
      expect(result.mode).toBe("standard")
    })

    it("returns brief mode when nothing is happening", () => {
      const result = deriveTempo({
        activeSessions: 0,
        openObligations: 0,
        recentEpisodeCount: 0,
        lastActivityAgeMs: 600000,
        hasBlockers: false,
        highSalienceEpisodes: 0,
        activeCareCount: 0,
        atRiskCareCount: 0,
      })
      expect(result.mode).toBe("brief")
    })

    describe("significance", () => {
      it("returns high when highSalienceEpisodes > 0", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 2,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })
        expect(result.significance).toBe("high")
      })

      it("returns high when atRiskCareCount > 0", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 1,
        })
        expect(result.significance).toBe("high")
      })

      it("returns medium when activeCareCount > 0", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 3,
          atRiskCareCount: 0,
        })
        expect(result.significance).toBe("medium")
      })

      it("returns low when no significance escalators", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })
        expect(result.significance).toBe("low")
      })
    })

    describe("reentryDepth", () => {
      it("returns warm when lastActivityAgeMs < 5 minutes", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 60_000, // 1 minute
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })
        expect(result.reentryDepth).toBe("warm")
      })

      it("returns cooled when lastActivityAgeMs < 2 hours", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 3_600_000, // 1 hour
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })
        expect(result.reentryDepth).toBe("cooled")
      })

      it("returns cold when lastActivityAgeMs >= 2 hours", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 8_000_000, // >2 hours
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })
        expect(result.reentryDepth).toBe("cold")
      })
    })

    describe("effectiveBudget", () => {
      it("uses mode base budget as default", () => {
        const result = deriveTempo({
          activeSessions: 1,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })
        expect(result.effectiveBudget.min).toBeGreaterThanOrEqual(TEMPO_BUDGETS.standard.min)
        expect(result.effectiveBudget.max).toBeLessThanOrEqual(TEMPO_BUDGETS.standard.max)
      })

      it("high significance can push budget up within mode range", () => {
        const low = deriveTempo({
          activeSessions: 1,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })

        const high = deriveTempo({
          activeSessions: 1,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 5,
          activeCareCount: 3,
          atRiskCareCount: 1,
        })

        // High significance should have effective min >= low significance min
        expect(high.effectiveBudget.min).toBeGreaterThanOrEqual(low.effectiveBudget.min)
      })

      it("cold re-entry can push up even brief mode", () => {
        const warm = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })

        const cold = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 10_000_000, // very cold
          hasBlockers: false,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })

        // Cold re-entry should push up the effective budget
        expect(cold.effectiveBudget.min).toBeGreaterThanOrEqual(warm.effectiveBudget.min)
      })

      it("crisis mode always uses crisis budget regardless of other factors", () => {
        const result = deriveTempo({
          activeSessions: 0,
          openObligations: 0,
          recentEpisodeCount: 0,
          lastActivityAgeMs: 1000,
          hasBlockers: true,
          highSalienceEpisodes: 0,
          activeCareCount: 0,
          atRiskCareCount: 0,
        })
        expect(result.mode).toBe("crisis")
        expect(result.effectiveBudget.min).toBeGreaterThanOrEqual(TEMPO_BUDGETS.crisis.min)
        expect(result.effectiveBudget.max).toBeLessThanOrEqual(TEMPO_BUDGETS.crisis.max)
      })
    })

    it("returns a complete TempoState with all fields", () => {
      const result = deriveTempo({
        activeSessions: 1,
        openObligations: 2,
        recentEpisodeCount: 5,
        lastActivityAgeMs: 30_000,
        hasBlockers: false,
        highSalienceEpisodes: 1,
        activeCareCount: 1,
        atRiskCareCount: 0,
      })

      expect(result.mode).toBeDefined()
      expect(result.significance).toBeDefined()
      expect(result.reentryDepth).toBeDefined()
      expect(result.effectiveBudget).toBeDefined()
      expect(typeof result.effectiveBudget.min).toBe("number")
      expect(typeof result.effectiveBudget.max).toBe("number")
    })
  })

  describe("getTokenBudget", () => {
    it("returns correct budget for each mode", () => {
      const modes: TempoMode[] = ["brief", "standard", "dense", "crisis"]
      for (const mode of modes) {
        const state: TempoState = {
          mode,
          significance: "low" as TempoSignificance,
          reentryDepth: "warm" as TempoReentryDepth,
          effectiveBudget: TEMPO_BUDGETS[mode],
        }
        const budget = getTokenBudget(state)
        expect(budget.min).toBe(TEMPO_BUDGETS[mode].min)
        expect(budget.max).toBe(TEMPO_BUDGETS[mode].max)
      }
    })
  })

  describe("detectTempoShift", () => {
    it("returns true when previous is null", () => {
      const current: TempoState = {
        mode: "standard",
        significance: "low",
        reentryDepth: "warm",
        effectiveBudget: TEMPO_BUDGETS.standard,
      }
      expect(detectTempoShift(null, current)).toBe(true)
    })

    it("returns true when mode changes", () => {
      const prev: TempoState = {
        mode: "brief",
        significance: "low",
        reentryDepth: "warm",
        effectiveBudget: TEMPO_BUDGETS.brief,
      }
      const curr: TempoState = {
        mode: "standard",
        significance: "low",
        reentryDepth: "warm",
        effectiveBudget: TEMPO_BUDGETS.standard,
      }
      expect(detectTempoShift(prev, curr)).toBe(true)
    })

    it("returns true when significance changes", () => {
      const prev: TempoState = {
        mode: "standard",
        significance: "low",
        reentryDepth: "warm",
        effectiveBudget: TEMPO_BUDGETS.standard,
      }
      const curr: TempoState = {
        mode: "standard",
        significance: "high",
        reentryDepth: "warm",
        effectiveBudget: TEMPO_BUDGETS.standard,
      }
      expect(detectTempoShift(prev, curr)).toBe(true)
    })

    it("returns true when reentryDepth changes", () => {
      const prev: TempoState = {
        mode: "standard",
        significance: "low",
        reentryDepth: "warm",
        effectiveBudget: TEMPO_BUDGETS.standard,
      }
      const curr: TempoState = {
        mode: "standard",
        significance: "low",
        reentryDepth: "cold",
        effectiveBudget: TEMPO_BUDGETS.standard,
      }
      expect(detectTempoShift(prev, curr)).toBe(true)
    })

    it("returns false when nothing changes", () => {
      const state: TempoState = {
        mode: "standard",
        significance: "low",
        reentryDepth: "warm",
        effectiveBudget: TEMPO_BUDGETS.standard,
      }
      expect(detectTempoShift(state, state)).toBe(false)
    })
  })
})
