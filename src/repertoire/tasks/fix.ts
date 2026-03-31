import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { clearTaskScanCache, scanTasks, tryExtractFrontmatter } from "./scanner"
import { renderTaskFile } from "./parser"
import type { FixOptions, FixResult, TaskIssue } from "./types"

function issueId(issue: TaskIssue): string {
  return `${issue.code}:${issue.target}`
}

function addKindToLegacyCard(root: string, issue: TaskIssue): boolean {
  emitNervesEvent({
    event: "repertoire.fix_apply_start",
    component: "repertoire",
    message: "adding kind: task to legacy card",
    meta: { target: issue.target },
  })

  const filePath = path.join(root, issue.target)
  if (!fs.existsSync(filePath)) return false

  const content = fs.readFileSync(filePath, "utf-8")
  const frontmatter = tryExtractFrontmatter(content)
  if (!frontmatter) return false

  // Add kind: task to frontmatter
  frontmatter.kind = "task"

  // Extract body (everything after the second ---)
  const lines = content.split(/\r?\n/)
  const firstDelim = lines.findIndex((line) => line.trim() === "---")
  const secondDelim = lines.findIndex((line, idx) => idx > firstDelim && line.trim() === "---")
  const body = lines.slice(secondDelim + 1).join("\n").replace(/^\n/, "")

  const rendered = renderTaskFile(frontmatter, body)
  fs.writeFileSync(filePath, rendered, "utf-8")
  return true
}

function applySingleFix(root: string, issue: TaskIssue): boolean {
  switch (issue.code) {
    case "schema-missing-kind":
      return addKindToLegacyCard(root, issue)
    default:
      return false
  }
}

export function applyFixes(options: FixOptions, root: string): FixResult {
  emitNervesEvent({
    event: "repertoire.fix_start",
    component: "repertoire",
    message: `applying fixes in ${options.mode} mode`,
    meta: { mode: options.mode, root },
  })

  clearTaskScanCache()
  const index = scanTasks(root)
  const issues = index.issues

  if (options.mode === "dry-run") {
    emitNervesEvent({
      event: "repertoire.fix_complete",
      component: "repertoire",
      message: "dry-run complete, no changes made",
      meta: { issueCount: issues.length },
    })

    const health = issues.length === 0 ? "clean" : buildHealthSummary(issues)
    return {
      applied: [],
      remaining: issues,
      skipped: [],
      health,
    }
  }

  if (options.mode === "single") {
    const targetId = options.issueId ?? ""
    const match = issues.find((i) => issueId(i) === targetId)

    if (!match) {
      emitNervesEvent({
        event: "repertoire.fix_complete",
        component: "repertoire",
        message: "single fix: issue not found",
        meta: { issueId: targetId },
      })

      const health = issues.length === 0 ? "clean" : buildHealthSummary(issues)
      return {
        applied: [],
        remaining: issues,
        skipped: [],
        health,
      }
    }

    const success = applySingleFix(root, match)
    clearTaskScanCache()
    const afterIndex = scanTasks(root)
    const afterIssues = afterIndex.issues
    const health = afterIssues.length === 0 ? "clean" : buildHealthSummary(afterIssues)

    emitNervesEvent({
      event: "repertoire.fix_complete",
      component: "repertoire",
      message: `single fix ${success ? "applied" : "failed"}`,
      meta: { issueId: targetId, success },
    })

    return {
      applied: success ? [match] : [],
      remaining: afterIssues,
      skipped: success ? [] : [match],
      health,
    }
  }

  // safe mode: apply all safe-confidence fixes
  const applied: TaskIssue[] = []
  const skipped: TaskIssue[] = []

  for (const issue of issues) {
    if (issue.confidence !== "safe") {
      skipped.push(issue)
      continue
    }

    const success = applySingleFix(root, issue)
    if (success) {
      applied.push(issue)
    } else {
      skipped.push(issue)
    }
  }

  clearTaskScanCache()
  const afterIndex = scanTasks(root)
  const afterIssues = afterIndex.issues
  const health = afterIssues.length === 0 ? "clean" : buildHealthSummary(afterIssues)

  emitNervesEvent({
    event: "repertoire.fix_complete",
    component: "repertoire",
    message: `safe fixes complete: ${applied.length} applied, ${skipped.length} skipped`,
    meta: { applied: applied.length, skipped: skipped.length },
  })

  return {
    applied,
    remaining: afterIssues,
    skipped,
    health,
  }
}

function buildHealthSummary(issues: TaskIssue[]): string {
  const liveCount = issues.filter((i) => i.category === "live").length
  const migrationCount = issues.filter((i) => i.category === "migration").length

  const parts: string[] = []
  if (liveCount > 0) parts.push(`${liveCount} live`)
  if (migrationCount > 0) parts.push(`${migrationCount} migration`)

  return parts.join(", ")
}
