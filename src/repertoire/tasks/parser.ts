import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type {
  CanonicalTaskCollection,
  CanonicalTaskType,
  TaskFile,
} from "./types"
import {
  canonicalCollectionForTaskType,
  isCanonicalTaskFilename,
  normalizeTaskStatus,
  normalizeTaskType,
} from "./transitions"

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === "null") return null
  if (value === "[]") return []
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function parseFrontmatter(raw: string): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {}
  const lines = raw.split(/\r?\n/)

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]
    if (!line.trim()) continue

    const match = /^([A-Za-z0-9_:-]+):\s*(.*)$/.exec(line)
    if (!match) continue

    const key = match[1]
    const inline = match[2]
    if (inline.length > 0) {
      frontmatter[key] = parseScalar(inline)
      continue
    }

    const items: unknown[] = []
    let cursor = idx + 1
    while (cursor < lines.length && /^\s*-\s+/.test(lines[cursor])) {
      items.push(parseScalar(lines[cursor].replace(/^\s*-\s+/, "")))
      cursor += 1
    }

    frontmatter[key] = items
    idx = cursor - 1
  }

  return frontmatter
}

function parseTaskBody(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") {
    throw new Error("task file missing frontmatter")
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (closing === -1) {
    throw new Error("task file has unterminated frontmatter")
  }

  const rawFrontmatter = lines.slice(1, closing).join("\n")
  const body = lines.slice(closing + 1).join("\n").trim()
  return { frontmatter: parseFrontmatter(rawFrontmatter), body }
}

function collectionFromPath(taskPath: string, type: CanonicalTaskType): CanonicalTaskCollection {
  const parts = taskPath.split(path.sep)
  if (parts.includes("one-shots")) return "one-shots"
  if (parts.includes("ongoing")) return "ongoing"
  return canonicalCollectionForTaskType(type)
}

export function parseTaskFile(content: string, filePath: string): TaskFile {
  emitNervesEvent({
    event: "mind.step_start",
    component: "mind",
    message: "parsing task file",
    meta: { filePath },
  })

  const parsed = parseTaskBody(content)
  const name = path.basename(filePath)
  const stem = name.replace(/\.md$/i, "")
  const type = normalizeTaskType(parsed.frontmatter.type as string)
  const status = normalizeTaskStatus(parsed.frontmatter.status as string)

  if (!type) {
    throw new Error(`task file has invalid type: ${filePath}`)
  }
  if (!status) {
    throw new Error(`task file has invalid status: ${filePath}`)
  }

  const title = String(parsed.frontmatter.title ?? stem)
  const category = String(parsed.frontmatter.category ?? "infrastructure")
  const created = String(parsed.frontmatter.created ?? "")
  const updated = String(parsed.frontmatter.updated ?? created)

  return {
    path: filePath,
    name,
    stem,
    type,
    collection: collectionFromPath(filePath, type),
    category,
    title,
    status,
    created,
    updated,
    frontmatter: {
      ...parsed.frontmatter,
      _isCanonicalFilename: isCanonicalTaskFilename(name),
    },
    body: parsed.body,
  }
}

function formatFrontmatterValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"]
    return ["", ...value.map((entry) => `- ${String(entry)}`)]
  }
  if (value === null) return ["null"]
  return [String(value)]
}

export function renderTaskFile(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter)
  const lines: string[] = ["---"]

  for (const key of keys) {
    const rendered = formatFrontmatterValue(frontmatter[key])
    if (rendered.length === 1) {
      lines.push(`${key}: ${rendered[0]}`)
    } else {
      lines.push(`${key}:`)
      for (const entry of rendered.slice(1)) {
        lines.push(entry)
      }
    }
  }

  lines.push("---")
  lines.push("")
  lines.push(body.trim())
  lines.push("")
  return lines.join("\n")
}
