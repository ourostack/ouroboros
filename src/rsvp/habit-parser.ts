import { emitNervesEvent } from "../nerves/runtime"
import {
  parseHabitFile,
  type HabitFile,
} from "../heart/habits/habit-parser"
import { parseHabitFrontmatterYaml } from "../heart/habits/habit-execution"
import {
  RSVP_HABIT_ALLOWED_TOOLS,
  parseRsvpHabitMetadata,
  type RsvpHabitMetadata,
} from "./habit-policy"

export type RsvpAwareHabitFile = HabitFile & { rsvp?: RsvpHabitMetadata }

function readRsvpMetadata(content: string): unknown {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) return undefined
  return parseHabitFrontmatterYaml(lines.slice(1, closing).join("\n")).rsvp
}

export function parseRsvpAwareHabitFile(content: string, filePath: string): RsvpAwareHabitFile {
  const habit = parseHabitFile(content, filePath)
  const rsvp = parseRsvpHabitMetadata(readRsvpMetadata(content))
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.habit_definition_parsed",
    message: "parsed legacy RSVP habit extension outside the generic habit parser",
    meta: { configured: rsvp !== null },
  })
  return rsvp === null ? habit : { ...habit, tools: [...RSVP_HABIT_ALLOWED_TOOLS], rsvp }
}
