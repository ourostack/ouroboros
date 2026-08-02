import * as path from "path"
import { parseFrontmatter } from "../../util/frontmatter"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  RSVP_HABIT_ALLOWED_TOOLS,
  parseRsvpHabitMetadata,
  rsvpHabitMetadataErrorDetail,
  type RsvpHabitMetadata,
} from "../../rsvp/habit-policy"

export type HabitStatus = "active" | "paused" | "cancelled"
export type HabitFileStatus = HabitStatus | "degraded"
export type HabitDegradedReason =
  | "unterminated_frontmatter"
  | "malformed_frontmatter"
  | "invalid_status"
  | "invalid_metadata"
  | "read_error"

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

interface HabitFileBase {
  name: string
  title: string
  cadence: string | null
  lastRun: string | null
  created: string | null
  tools: string[] | undefined
  rsvp?: RsvpHabitMetadata
  origin: HabitOrigin | null
  surface: HabitSurface
  continuity: HabitContinuity
  body: string
}

export type HabitFile =
  | (HabitFileBase & {
    status: HabitStatus
  })
  | (HabitFileBase & {
    status: "degraded"
    degradedReason: HabitDegradedReason
    degradedDetail: string | null
  })

function isHabitStatus(value: string): value is HabitStatus {
  return value === "active" || value === "paused" || value === "cancelled"
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

export function isHabitFrontmatterSyntaxValid(rawFrontmatter: string): boolean {
  const lines = rawFrontmatter.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    const match = /^([A-Za-z0-9_:-]+):\s*(.*)$/.exec(line)
    if (!match) return false
    if (match[2].length > 0) continue

    let cursor = index + 1
    while (cursor < lines.length && /^\s*-\s+/.test(lines[cursor])) cursor += 1
    if (cursor > index + 1) {
      index = cursor - 1
      continue
    }
    while (cursor < lines.length && /^\s+[A-Za-z0-9_:-]+:\s*/.test(lines[cursor])) cursor += 1
    index = cursor - 1
  }
  return true
}

type ExtractedHabitDocument =
  | { kind: "legacy_body"; body: string }
  | { kind: "frontmatter"; frontmatter: Record<string, unknown>; body: string }
  | { kind: "degraded"; reason: "unterminated_frontmatter" | "malformed_frontmatter"; body: string }

function extractFrontmatterAndBody(content: string): ExtractedHabitDocument {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") {
    return { kind: "legacy_body", body: content.trim() }
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) {
    return { kind: "degraded", reason: "unterminated_frontmatter", body: content.trim() }
  }

  const rawFrontmatter = lines.slice(1, closing).join("\n")
  const body = lines.slice(closing + 1).join("\n").trim()
  if (!isHabitFrontmatterSyntaxValid(rawFrontmatter)) {
    return { kind: "degraded", reason: "malformed_frontmatter", body }
  }
  return { kind: "frontmatter", frontmatter: parseFrontmatter(rawFrontmatter), body }
}

export function createDegradedHabitFile(
  filePath: string,
  degradedReason: HabitDegradedReason,
  body = "",
  degradedDetail: string | null = null,
): Extract<HabitFile, { status: "degraded" }> {
  const stem = path.basename(filePath, ".md")
  return {
    name: stem,
    title: stem,
    cadence: null,
    status: "degraded",
    degradedReason,
    degradedDetail,
    lastRun: null,
    created: null,
    tools: undefined,
    origin: null,
    surface: { family: false, originator: false, extra: [] },
    continuity: { mode: "fresh" },
    body: body.trim(),
  }
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

  if (parsed.kind === "legacy_body") {
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
      body: parsed.body,
    }
  }

  if (parsed.kind === "degraded") {
    return createDegradedHabitFile(filePath, parsed.reason, parsed.body)
  }

  const { frontmatter, body } = parsed

  const rawTitle = frontmatter.title
  const title = typeof rawTitle === "string" && rawTitle.length > 0 ? rawTitle : stem

  const rawCadence = frontmatter.cadence
  const cadence = typeof rawCadence === "string" && rawCadence.length > 0 ? rawCadence : null

  const rawStatus = frontmatter.status
  const status: HabitStatus | null = rawStatus === undefined
    ? "active"
    : typeof rawStatus === "string" && isHabitStatus(rawStatus)
      ? rawStatus
      : null
  if (status === null) {
    return createDegradedHabitFile(filePath, "invalid_status", body)
  }

  const rawLastRun = frontmatter.lastRun ?? frontmatter.last_run
  const lastRun = typeof rawLastRun === "string" && rawLastRun.length > 0 ? rawLastRun : null

  const rawCreated = frontmatter.created
  const created = typeof rawCreated === "string" && rawCreated.length > 0 ? rawCreated : null

  let rsvp: RsvpHabitMetadata | null
  try {
    rsvp = parseRsvpHabitMetadata(frontmatter.rsvp)
  } catch (error) {
    const degradedDetail = rsvpHabitMetadataErrorDetail(error)
    return createDegradedHabitFile(filePath, "invalid_metadata", body, degradedDetail)
  }
  const tools = rsvp ? [...RSVP_HABIT_ALLOWED_TOOLS] : parseToolsField(frontmatter.tools)
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
    ...(rsvp ? { rsvp } : {}),
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
