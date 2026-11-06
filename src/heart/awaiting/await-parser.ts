import * as path from "path"
import { parseFrontmatter } from "../../repertoire/tasks/parser"
import { emitNervesEvent } from "../../nerves/runtime"

export type AwaitStatus = "pending" | "resolved" | "expired" | "canceled"
export type AwaitMode = "full" | "quick"

export interface AwaitFile {
  name: string
  condition: string | null
  cadence: string | null
  alert: string | null
  mode: AwaitMode
  max_age: string | null
  status: AwaitStatus
  created_at: string | null
  filed_from: string | null
  filed_for_friend_id: string | null
  body: string

  // resolved-only
  resolved_at: string | null
  resolution_observation: string | null

  // expired-only
  expired_at: string | null
  last_observation_at_expiry: string | null

  // canceled-only
  canceled_at: string | null
  cancel_reason: string | null
}

function isAwaitStatus(value: string): value is AwaitStatus {
  return value === "pending" || value === "resolved" || value === "expired" || value === "canceled"
}

function isAwaitMode(value: string): value is AwaitMode {
  return value === "full" || value === "quick"
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function extractFrontmatterAndBody(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return null
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) return null

  const rawFrontmatter = lines.slice(1, closing).join("\n")
  const body = lines.slice(closing + 1).join("\n").trim()
  return { frontmatter: parseFrontmatter(rawFrontmatter), body }
}

function emptyAwait(stem: string, body: string): AwaitFile {
  return {
    name: stem,
    condition: null,
    cadence: null,
    alert: null,
    mode: "full",
    max_age: null,
    status: "pending",
    created_at: null,
    filed_from: null,
    filed_for_friend_id: null,
    body,
    resolved_at: null,
    resolution_observation: null,
    expired_at: null,
    last_observation_at_expiry: null,
    canceled_at: null,
    cancel_reason: null,
  }
}

export function parseAwaitFile(content: string, filePath: string): AwaitFile {
  emitNervesEvent({
    event: "daemon.await_parse",
    component: "daemon",
    message: "parsing await file",
    meta: { filePath },
  })

  const stem = path.basename(filePath, ".md")
  const parsed = extractFrontmatterAndBody(content)
  if (!parsed) return { ...emptyAwait(stem, content.trim()) }

  const { frontmatter, body } = parsed

  const rawStatus = frontmatter.status
  const status: AwaitStatus = typeof rawStatus === "string" && isAwaitStatus(rawStatus) ? rawStatus : "pending"

  const rawMode = frontmatter.mode
  const mode: AwaitMode = typeof rawMode === "string" && isAwaitMode(rawMode) ? rawMode : "full"

  return {
    name: stem,
    condition: nonEmptyString(frontmatter.condition),
    cadence: nonEmptyString(frontmatter.cadence),
    alert: nonEmptyString(frontmatter.alert),
    mode,
    max_age: nonEmptyString(frontmatter.max_age),
    status,
    created_at: nonEmptyString(frontmatter.created_at),
    filed_from: nonEmptyString(frontmatter.filed_from),
    filed_for_friend_id: nonEmptyString(frontmatter.filed_for_friend_id),
    body,
    resolved_at: nonEmptyString(frontmatter.resolved_at),
    resolution_observation: nonEmptyString(frontmatter.resolution_observation),
    expired_at: nonEmptyString(frontmatter.expired_at),
    last_observation_at_expiry: nonEmptyString(frontmatter.last_observation_at_expiry),
    canceled_at: nonEmptyString(frontmatter.canceled_at),
    cancel_reason: nonEmptyString(frontmatter.cancel_reason),
  }
}

function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.join(", ")}]`
  return String(value)
}

export function renderAwaitFile(frontmatter: Record<string, unknown>, body: string): string {
  emitNervesEvent({
    event: "daemon.await_render",
    component: "daemon",
    message: "rendering await file",
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
