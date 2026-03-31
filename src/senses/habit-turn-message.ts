import { emitNervesEvent } from "../nerves/runtime"

export interface StaleObligationInfo {
  friendName: string
  content: string
  stalenessMs: number
}

export interface HabitParseErrorInfo {
  file: string
  error: string
}

export interface DegradedComponentInfo {
  component: string
  reason: string
}

export interface HabitTurnMessageOptions {
  habitName: string
  habitTitle: string
  habitBody: string | undefined
  lastRun: string | null
  checkpoint: string | undefined
  alsoDue: string | undefined
  staleObligations: StaleObligationInfo[]
  parseErrors: HabitParseErrorInfo[]
  degradedComponents: DegradedComponentInfo[]
  now: () => Date
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours} ${hours === 1 ? "hour" : "hours"}`
}

export function buildHabitTurnMessage(options: HabitTurnMessageOptions): string {
  const {
    habitName,
    habitTitle,
    habitBody,
    lastRun,
    checkpoint,
    alsoDue,
    staleObligations,
    parseErrors,
    degradedComponents,
    now,
  } = options

  const hasBody = habitBody !== undefined && habitBody !== ""

  // First beat: lastRun is null
  if (lastRun === null) {
    // Cold start: no checkpoint, no body — bare awareness
    if (!checkpoint && !hasBody) {
      emitNervesEvent({
        component: "senses",
        event: "senses.habit_turn_message_built",
        message: "habit turn message built (cold start)",
        meta: { habitName, coldStart: true },
      })
      return "...time passing. anything stirring?"
    }

    if (!hasBody) {
      // First beat with no body: nudge
      const sections: string[] = [
        `your ${habitTitle} fired but has no instructions \u2014 add a body to \`habits/${habitName}.md\``,
      ]
      appendTrailingExtras(sections, alsoDue, staleObligations, parseErrors, degradedComponents)

      emitNervesEvent({
        component: "senses",
        event: "senses.habit_turn_message_built",
        message: "habit turn message built (first beat, no body)",
        meta: { habitName, firstBeat: true, hasBody: false },
      })
      return sections.join("\n\n")
    }

    const sections: string[] = [
      `your ${habitTitle} is alive. this is its first breath.`,
      habitBody!,
    ]
    appendTrailingExtras(sections, alsoDue, staleObligations, parseErrors, degradedComponents)

    emitNervesEvent({
      component: "senses",
      event: "senses.habit_turn_message_built",
      message: "habit turn message built (first beat)",
      meta: { habitName, firstBeat: true },
    })
    return sections.join("\n\n")
  }

  // Normal turn
  const sections: string[] = []

  // 1. Checkpoint
  if (checkpoint) {
    sections.push(`you were thinking about ${checkpoint}.`)
  }

  // 2. Elapsed time
  const nowMs = now().getTime()
  const lastRunMs = new Date(lastRun).getTime()
  const elapsed = nowMs - lastRunMs
  sections.push(`${formatElapsed(elapsed)} have passed.`)

  // 3. Body or no-body nudge
  if (hasBody) {
    sections.push(habitBody!)
  } else {
    sections.push(`your ${habitTitle} fired but has no instructions \u2014 add a body to \`habits/${habitName}.md\``)
  }

  // 4-7. Trailing extras
  appendTrailingExtras(sections, alsoDue, staleObligations, parseErrors, degradedComponents)

  emitNervesEvent({
    component: "senses",
    event: "senses.habit_turn_message_built",
    message: "habit turn message built",
    meta: {
      habitName,
      hasCheckpoint: !!checkpoint,
      hasBody: hasBody,
      staleObligationCount: staleObligations.length,
    },
  })

  return sections.join("\n\n")
}

function appendTrailingExtras(
  sections: string[],
  alsoDue: string | undefined,
  staleObligations: StaleObligationInfo[],
  parseErrors: HabitParseErrorInfo[],
  degradedComponents: DegradedComponentInfo[],
): void {
  // 4. Also-due
  if (alsoDue) {
    sections.push(alsoDue)
  }

  // 5. Stale obligations
  if (staleObligations.length > 0) {
    const lines = staleObligations.map(
      (o) => `something for ${o.friendName} has been sitting for ${formatElapsed(o.stalenessMs)}`,
    )
    sections.push(lines.join("\n"))
  }

  // 6. Parse errors
  if (parseErrors.length > 0) {
    const lines = parseErrors.map(
      (e) => `I noticed my habit file \`${e.file}\` has invalid frontmatter \u2014 I should fix it. (${e.error})`,
    )
    sections.push(lines.join("\n"))
  }

  // 7. Degraded state
  if (degradedComponents.length > 0) {
    const reasons = degradedComponents.map((d) => `${d.component}: ${d.reason}`).join("; ")
    sections.push(`[note: my scheduling is degraded: ${reasons}]`)
  }
}
