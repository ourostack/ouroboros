import * as path from "path"
import { parseFrontmatter } from "../../repertoire/tasks/parser"
import { emitNervesEvent } from "../../nerves/runtime"

export type HabitStatus = "active" | "paused"

export interface HabitFile {
  name: string
  title: string
  cadence: string | null
  status: HabitStatus
  lastRun: string | null
  created: string | null
  body: string
}

function isHabitStatus(value: string): value is HabitStatus {
  return value === "active" || value === "paused"
}

function extractFrontmatterAndBody(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") {
    return null
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) {
    return null
  }

  const rawFrontmatter = lines.slice(1, closing).join("\n")
  const body = lines.slice(closing + 1).join("\n").trim()
  return { frontmatter: parseFrontmatter(rawFrontmatter), body }
}

export function parseHabitFile(content: string, filePath: string): HabitFile {
  emitNervesEvent({
    event: "daemon.habit_parse",
    component: "daemon",
    message: "parsing habit file",
    meta: { filePath },
  })

  const stem = path.basename(filePath, ".md")
  const parsed = extractFrontmatterAndBody(content)

  if (!parsed) {
    return {
      name: stem,
      title: stem,
      cadence: null,
      status: "active",
      lastRun: null,
      created: null,
      body: content.trim(),
    }
  }

  const { frontmatter, body } = parsed

  const rawTitle = frontmatter.title
  const title = typeof rawTitle === "string" && rawTitle.length > 0 ? rawTitle : stem

  const rawCadence = frontmatter.cadence
  const cadence = typeof rawCadence === "string" && rawCadence.length > 0 ? rawCadence : null

  const rawStatus = frontmatter.status
  const status: HabitStatus =
    typeof rawStatus === "string" && isHabitStatus(rawStatus) ? rawStatus : "active"

  const rawLastRun = frontmatter.lastRun
  const lastRun = typeof rawLastRun === "string" && rawLastRun.length > 0 ? rawLastRun : null

  const rawCreated = frontmatter.created
  const created = typeof rawCreated === "string" && rawCreated.length > 0 ? rawCreated : null

  return {
    name: stem,
    title,
    cadence,
    status,
    lastRun,
    created,
    body,
  }
}

function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return "null"
  return String(value)
}

export function renderHabitFile(frontmatter: Record<string, unknown>, body: string): string {
  emitNervesEvent({
    event: "daemon.habit_render",
    component: "daemon",
    message: "rendering habit file",
    meta: {},
  })

  const lines: string[] = ["---"]

  for (const key of Object.keys(frontmatter)) {
    lines.push(`${key}: ${formatFrontmatterValue(frontmatter[key])}`)
  }

  lines.push("---")
  lines.push("")
  lines.push(body.trim())
  lines.push("")
  return lines.join("\n")
}
