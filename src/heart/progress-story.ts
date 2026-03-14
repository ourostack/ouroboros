import { emitNervesEvent } from "../nerves/runtime"

export type ProgressScope = "inner-delegation" | "shared-work"
export type ProgressPhase = "queued" | "processing" | "completed" | "blocked" | "errored"

export interface ProgressStoryInput {
  scope: ProgressScope
  phase: ProgressPhase
  objective?: string | null
  outcomeText?: string | null
  bridgeId?: string | null
  taskName?: string | null
}

export interface ProgressStory {
  statusLine: string
  detailLines: string[]
}

function labelForScope(scope: ProgressScope): string {
  return scope === "inner-delegation" ? "inner work" : "shared work"
}

function compactDetail(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function buildProgressStory(input: ProgressStoryInput): ProgressStory {
  const detailLines = [
    compactDetail(input.objective),
    compactDetail(input.outcomeText),
    compactDetail(input.bridgeId ? `bridge: ${input.bridgeId}` : null),
    compactDetail(input.taskName ? `task: ${input.taskName}` : null),
  ].filter((line): line is string => Boolean(line))

  const story = {
    statusLine: `${labelForScope(input.scope)}: ${input.phase}`,
    detailLines,
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.progress_story_build",
    message: "built shared progress story",
    meta: {
      scope: input.scope,
      phase: input.phase,
      detailLines: detailLines.length,
      hasBridge: Boolean(input.bridgeId),
      hasTask: Boolean(input.taskName),
    },
  })

  return story
}

export function renderProgressStory(story: ProgressStory): string {
  return [story.statusLine, ...story.detailLines].join("\n")
}
