import { emitNervesEvent } from "../nerves/runtime"

export type TempoMode = "brief" | "standard" | "dense" | "crisis"
export type TempoSignificance = "low" | "medium" | "high"
export type TempoReentryDepth = "warm" | "cooled" | "cold"

export interface TempoTokenBudget {
  min: number
  max: number
}

export interface TempoState {
  mode: TempoMode
  significance: TempoSignificance
  reentryDepth: TempoReentryDepth
  effectiveBudget: TempoTokenBudget
}

export const TEMPO_BUDGETS: Record<TempoMode, TempoTokenBudget> = {
  brief: { min: 150, max: 250 },
  standard: { min: 450, max: 700 },
  dense: { min: 900, max: 1100 },
  crisis: { min: 700, max: 1000 },
}

export interface TempoInputs {
  activeSessions: number
  openObligations: number
  recentEpisodeCount: number
  lastActivityAgeMs: number
  hasBlockers: boolean
  highSalienceEpisodes: number
  activeCareCount: number
  atRiskCareCount: number
}

const FIVE_MINUTES_MS = 5 * 60 * 1000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

function deriveMode(inputs: TempoInputs): TempoMode {
  if (inputs.hasBlockers) return "crisis"
  if (inputs.openObligations > 3 || inputs.recentEpisodeCount > 10) return "dense"
  if (inputs.activeSessions > 0) return "standard"
  return "brief"
}

function deriveSignificance(inputs: TempoInputs): TempoSignificance {
  if (inputs.highSalienceEpisodes > 0 || inputs.atRiskCareCount > 0) return "high"
  if (inputs.activeCareCount > 0) return "medium"
  return "low"
}

function deriveReentryDepth(inputs: TempoInputs): TempoReentryDepth {
  if (inputs.lastActivityAgeMs < FIVE_MINUTES_MS) return "warm"
  if (inputs.lastActivityAgeMs < TWO_HOURS_MS) return "cooled"
  return "cold"
}

function computeEffectiveBudget(
  mode: TempoMode,
  significance: TempoSignificance,
  reentryDepth: TempoReentryDepth,
): TempoTokenBudget {
  const base = TEMPO_BUDGETS[mode]

  // Crisis always uses crisis budget regardless
  if (mode === "crisis") return { ...base }

  const range = base.max - base.min

  // Start at the mode minimum
  let effectiveMin = base.min

  // Significance pushes up within range
  if (significance === "high") {
    effectiveMin += Math.round(range * 0.5)
  } else if (significance === "medium") {
    effectiveMin += Math.round(range * 0.25)
  }

  // Cold re-entry pushes up (need more context to re-orient)
  if (reentryDepth === "cold") {
    effectiveMin += Math.round(range * 0.3)
  } else if (reentryDepth === "cooled") {
    effectiveMin += Math.round(range * 0.1)
  }

  // Clamp within mode range
  effectiveMin = Math.min(effectiveMin, base.max)

  return { min: effectiveMin, max: base.max }
}

export function deriveTempo(inputs: TempoInputs): TempoState {
  const mode = deriveMode(inputs)
  const significance = deriveSignificance(inputs)
  const reentryDepth = deriveReentryDepth(inputs)
  const effectiveBudget = computeEffectiveBudget(mode, significance, reentryDepth)

  emitNervesEvent({
    component: "heart",
    event: "heart.tempo_derived",
    message: `tempo derived: ${mode}/${significance}/${reentryDepth}`,
    meta: {
      mode,
      significance,
      reentryDepth,
      effectiveMin: effectiveBudget.min,
      effectiveMax: effectiveBudget.max,
    },
  })

  return { mode, significance, reentryDepth, effectiveBudget }
}

export function getTokenBudget(state: TempoState): TempoTokenBudget {
  return state.effectiveBudget
}

export function detectTempoShift(
  previous: TempoState | null,
  current: TempoState,
): boolean {
  if (!previous) return true
  return (
    previous.mode !== current.mode
    || previous.significance !== current.significance
    || previous.reentryDepth !== current.reentryDepth
  )
}
