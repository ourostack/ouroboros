import * as path from "path"
import { parseFrontmatter } from "../../util/frontmatter"
import { emitNervesEvent } from "../../nerves/runtime"

export type HabitStatus = "active" | "paused"

export interface HabitOrigin {
  friendId: string
  channel: string
  key: string
}

export interface HabitSurface {
  family: boolean
  originator: boolean
  extra: string[]
}

export type HabitContinuityMode = "fresh" | "stateful"

export interface HabitContinuity {
  mode: HabitContinuityMode
}

export interface HabitFile {
  name: string
  title: string
  cadence: string | null
  status: HabitStatus
  lastRun: string | null
  created: string | null
  tools: string[] | undefined
  origin: HabitOrigin | null
  surface: HabitSurface
  continuity: HabitContinuity
  body: string
}

function isHabitStatus(value: string): value is HabitStatus {
  return value === "active" || value === "paused"
}

function parseToolsField(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  // YAML dash-list: parseFrontmatter returns unknown[]
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string")
  }
  // Inline bracket format: parseFrontmatter returns string like "[a, b, c]"
  if (typeof raw === "string" && raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1)
    if (inner.trim().length === 0) return []
    return inner.split(",").map((s) => s.trim()).filter(Boolean)
  }
  return undefined
}

function objectRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key]
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value === "true") return true
    if (value === "false") return false
  }
  return fallback
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw === "string" && raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1)
    if (!inner.trim()) return []
    return inner.split(",").map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function parseOrigin(raw: unknown): HabitOrigin | null {
  const record = objectRecord(raw)
  if (!record) return null
  const friendId = stringField(record, "friendId")
  const channel = stringField(record, "channel")
  const key = stringField(record, "key")
  if (!friendId || !channel || !key) return null
  return { friendId, channel, key }
}

function parseSurface(raw: unknown): HabitSurface {
  const record = objectRecord(raw)
  return {
    family: record ? booleanField(record, "family", true) : true,
    originator: record ? booleanField(record, "originator", true) : true,
    extra: record ? parseStringArray(record.extra) : [],
  }
}

function parseContinuity(raw: unknown): HabitContinuity {
  const record = objectRecord(raw)
  const mode = record ? record.mode : null
  return { mode: mode === "stateful" ? "stateful" : "fresh" }
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
      tools: undefined,
      origin: null,
      surface: { family: true, originator: true, extra: [] },
      continuity: { mode: "fresh" },
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

  const rawLastRun = frontmatter.lastRun ?? frontmatter.last_run
  const lastRun = typeof rawLastRun === "string" && rawLastRun.length > 0 ? rawLastRun : null

  const rawCreated = frontmatter.created
  const created = typeof rawCreated === "string" && rawCreated.length > 0 ? rawCreated : null

  const tools = parseToolsField(frontmatter.tools)
  const origin = parseOrigin(frontmatter.origin)
  const surface = parseSurface(frontmatter.surface)
  const continuity = parseContinuity(frontmatter.continuity)

  return {
    name: stem,
    title,
    cadence,
    status,
    lastRun,
    created,
    tools,
    origin,
    surface,
    continuity,
    body,
  }
}

function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.join(", ")}]`
  return String(value)
}

function renderFrontmatterLine(lines: string[], key: string, value: unknown): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    lines.push(`${key}:`)
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      lines.push(`  ${childKey}: ${formatFrontmatterValue(childValue)}`)
    }
    return
  }
  lines.push(`${key}: ${formatFrontmatterValue(value)}`)
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
    renderFrontmatterLine(lines, key, frontmatter[key])
  }

  lines.push("---")
  lines.push("")
  lines.push(body.trim())
  lines.push("")
  return lines.join("\n")
}
