import * as fs from "fs"
import * as path from "path"
import { readJsonFile, writeJsonFile } from "../../arc/json-store"
import { emitNervesEvent } from "../../nerves/runtime"
import type { HabitFile } from "./habit-parser"

interface HabitRuntimeStateRecord {
  schemaVersion: 1
  name: string
  lastRun: string
  updatedAt: string
}

function habitRuntimeStateDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "habits")
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function stripLegacyLastRunFromDefinition(definitionPath: string): void {
  const content = fs.readFileSync(definitionPath, "utf-8")
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) return

  const frontmatterLines = lines.slice(1, closing)
  const filtered = frontmatterLines.filter((line) => !/^\s*lastRun\s*:/.test(line) && !/^\s*last_run\s*:/.test(line))
  if (filtered.length === frontmatterLines.length) return

  const nextContent = ["---", ...filtered, "---", ...lines.slice(closing + 1)].join("\n")
  fs.writeFileSync(definitionPath, nextContent, "utf-8")
}

export function readHabitLastRun(agentRoot: string, habitName: string): string | null {
  const record = readJsonFile<Partial<HabitRuntimeStateRecord>>(habitRuntimeStateDir(agentRoot), habitName)
  return isNonEmptyString(record?.lastRun) ? record.lastRun : null
}

export function applyHabitRuntimeState(agentRoot: string, habit: HabitFile): HabitFile {
  const runtimeLastRun = readHabitLastRun(agentRoot, habit.name)
  if (runtimeLastRun === null) return habit
  return { ...habit, lastRun: runtimeLastRun }
}

export function writeHabitLastRun(agentRoot: string, habitName: string, lastRun: string, updatedAt = lastRun): void {
  const record: HabitRuntimeStateRecord = {
    schemaVersion: 1,
    name: habitName,
    lastRun,
    updatedAt,
  }
  writeJsonFile(habitRuntimeStateDir(agentRoot), habitName, record)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.habit_runtime_state_write",
    message: "wrote habit runtime state",
    meta: { agentRoot, habitName, lastRun, updatedAt },
  })
}

export function recordHabitRun(
  agentRoot: string,
  habitName: string,
  lastRun: string,
  options: { definitionPath?: string } = {},
): void {
  writeHabitLastRun(agentRoot, habitName, lastRun)
  if (!options.definitionPath) return
  try {
    stripLegacyLastRunFromDefinition(options.definitionPath)
  } catch {
    // Missing/deleted habit files should never block runtime-state recording.
  }
}
