import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let agentRoot = ""

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: () => agentRoot,
}))

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { scanTasks, clearTaskScanCache } from "../../../repertoire/tasks/scanner"
import { buildTaskBoard } from "../../../repertoire/tasks/board"
import { applyFixes } from "../../../repertoire/tasks/fix"
import { archiveCompletedTasks } from "../../../repertoire/tasks/lifecycle"
import { getTaskModule, resetTaskModule } from "../../../repertoire/tasks/index"
import type { CreateTaskInput } from "../../../repertoire/tasks/types"

function removeDirSafe(dir: string): void {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf-8")
}

function validTaskCard(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    kind: "task",
    type: "one-shot",
    category: "infrastructure",
    title: "Test Task",
    status: "drafting",
    created: "2026-03-30",
    updated: "2026-03-30",
    parent_task: "null",
    depends_on: "[]",
    artifacts: "[]",
    ...overrides,
  }
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push("---")
  lines.push("")
  lines.push("## scope")
  lines.push("task body")
  lines.push("")
  return lines.join("\n")
}

function legacyTaskCard(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    type: "one-shot",
    category: "infrastructure",
    title: "Legacy Task",
    status: "drafting",
    created: "2026-03-30",
    updated: "2026-03-30",
    parent_task: "null",
    depends_on: "[]",
    artifacts: "[]",
    ...overrides,
  }
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`)
  }
  lines.push("---")
  lines.push("")
  lines.push("body")
  lines.push("")
  return lines.join("\n")
}

function doingDoc(): string {
  return [
    "# Doing: Some Task",
    "",
    "**Status**: READY_FOR_EXECUTION",
    "",
    "## Progress Log",
    "- 2026-03-30 Unit 0 complete",
    "",
  ].join("\n")
}

function planningDoc(): string {
  return [
    "# Planning: Some Task",
    "",
    "## Decisions",
    "- decided to use approach A",
    "",
  ].join("\n")
}

describe("integration: full task pipeline", () => {
  let taskRoot: string

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "integration-test-"))
    taskRoot = path.join(agentRoot, "tasks")
    clearTaskScanCache()
  })

  afterEach(() => {
    removeDirSafe(agentRoot)
    clearTaskScanCache()
    resetTaskModule()
  })

  it("scan -> board -> fix --safe -> fix <id> -- slugger-like bundle", () => {
    // --- Set up a slugger-like bundle ---

    // Task cards with kind: task (modern)
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-01-modern-task.md"),
      validTaskCard({ title: "Modern Task", status: "processing" }),
    )

    // Task cards WITHOUT kind (legacy) -- should trigger schema-missing-kind
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-02-legacy-task.md"),
      legacyTaskCard({ title: "Legacy Task", status: "drafting" }),
    )

    // Doing/planning docs WITHOUT frontmatter at collection root -- silently skipped
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-01-doing-some-work.md"),
      doingDoc(),
    )
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-01-planning-some-work.md"),
      planningDoc(),
    )

    // Artifact/work directories (same-stem as task card)
    fs.mkdirSync(path.join(taskRoot, "one-shots", "2026-03-01-modern-task"), { recursive: true })
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-01-modern-task", "notes.md"),
      "some notes",
    )

    // Done task -- terminal, should be hidden from active board
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-10-done-task.md"),
      validTaskCard({ title: "Done Task", status: "done" }),
    )

    // Cancelled task -- terminal, should be hidden from active board
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-11-cancelled-task.md"),
      validTaskCard({ title: "Cancelled Task", status: "cancelled" }),
    )

    // Root-level orphan doc with task-like frontmatter -- should surface as migration issue
    writeFile(
      path.join(taskRoot, "README.md"),
      "---\ntitle: Orphan Task\nstatus: drafting\n---\n\nShould be in a collection\n",
    )

    // --- Phase 1: Scan ---
    const index = scanTasks(taskRoot)

    // Zero false errors: doing/planning docs silently skipped
    expect(index.tasks.length).toBe(4) // modern + legacy + done + cancelled

    // Correct issues: legacy missing kind + root orphan
    const issueCodes = index.issues.map((i) => i.code)
    expect(issueCodes).toContain("schema-missing-kind")
    expect(issueCodes).toContain("org-root-level-doc")

    // No false parse errors for doing/planning docs
    const targets = index.issues.map((i) => i.target)
    expect(targets).not.toContain("one-shots/2026-03-01-doing-some-work.md")
    expect(targets).not.toContain("one-shots/2026-03-01-planning-some-work.md")

    // Work directory detected
    const modernTask = index.tasks.find((t) => t.stem === "2026-03-01-modern-task")
    expect(modernTask).toBeDefined()
    expect(modernTask!.hasWorkDir).toBe(true)
    expect(modernTask!.workDirFiles).toContain("notes.md")

    // --- Phase 2: Board ---
    const board = buildTaskBoard(index)

    // Health line present with live/migration split
    expect(board.compact).toContain("health:")

    // Terminal tasks hidden from active counts
    expect(board.full).not.toMatch(/## done[\s\S]*Done Task/)
    // Board does have the terminal section, but not in active statuses
    expect(board.byStatus.done).toEqual(["2026-03-10-done-task"])
    expect(board.byStatus.cancelled).toEqual(["2026-03-11-cancelled-task"])

    // Issues propagated to board
    expect(board.issues.length).toBeGreaterThan(0)

    // --- Phase 3: fix --safe ---
    clearTaskScanCache()
    const safeFix = applyFixes({ mode: "safe" }, taskRoot)

    // Legacy card should have been fixed (kind: task added)
    expect(safeFix.applied.length).toBeGreaterThanOrEqual(1)
    const kindFix = safeFix.applied.find((i) => i.code === "schema-missing-kind")
    expect(kindFix).toBeDefined()

    // Verify the file was actually modified
    const legacyContent = fs.readFileSync(
      path.join(taskRoot, "one-shots", "2026-03-02-legacy-task.md"),
      "utf-8",
    )
    expect(legacyContent).toContain("kind: task")

    // Orphan issue should remain (needs_review, not safe)
    const orphanRemaining = safeFix.remaining.find((i) => i.code === "org-root-level-doc")
    expect(orphanRemaining).toBeDefined()

    // Health should reflect remaining issues
    expect(safeFix.health).toBeTruthy()

    // --- Phase 4: fix <id> for orphan ---
    clearTaskScanCache()
    const orphanId = `org-root-level-doc:README.md`
    const singleFix = applyFixes({ mode: "single", issueId: orphanId }, taskRoot)

    // Orphan fix is needs_review -- applySingleFix returns false for unknown codes
    // so it should be in skipped, not applied
    expect(singleFix.skipped.length).toBeGreaterThanOrEqual(1)

    // --- Phase 5: Re-scan after fix ---
    clearTaskScanCache()
    const postFixIndex = scanTasks(taskRoot)

    // Legacy card is now parsed with kind: task -- no more schema-missing-kind
    const postFixCodes = postFixIndex.issues.map((i) => i.code)
    expect(postFixCodes).not.toContain("schema-missing-kind")
    // Orphan still present (was not fixed)
    expect(postFixCodes).toContain("org-root-level-doc")

    // Tasks count should now include the previously-legacy card as a modern card
    expect(postFixIndex.tasks.length).toBe(4)
  })

  it("createTask produces correct kind: task frontmatter", () => {
    // Use getTaskModule() which reads from getTaskRoot() -> getAgentRoot()
    resetTaskModule()
    const mod = getTaskModule()

    // Create a task
    const input: CreateTaskInput = {
      title: "New Integration Task",
      type: "one-shot",
      category: "testing",
      body: "integration test body",
    }
    const createdPath = mod.createTask(input)
    expect(createdPath).toBeTruthy()
    expect(fs.existsSync(createdPath)).toBe(true)

    // Verify the created file has kind: task
    const content = fs.readFileSync(createdPath, "utf-8")
    expect(content).toContain("kind: task")

    // Verify child_tasks is NOT written
    expect(content).not.toContain("child_tasks")

    // Verify it scans correctly
    clearTaskScanCache()
    const index = scanTasks(taskRoot)
    const createdTask = index.tasks.find((t) => t.title === "New Integration Task")
    expect(createdTask).toBeDefined()
    expect(createdTask!.status).toBe("drafting")

    // No issues for this newly created task
    const createdTaskIssues = index.issues.filter((i) =>
      i.target.includes(path.basename(createdPath)),
    )
    expect(createdTaskIssues.length).toBe(0)
  })

  it("archive moves task + work dir together for cancelled status", () => {
    // Write a cancelled task with a work directory
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-20-cancel-me.md"),
      validTaskCard({ title: "Cancel Me", status: "cancelled" }),
    )
    fs.mkdirSync(path.join(taskRoot, "one-shots", "2026-03-20-cancel-me"), { recursive: true })
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-20-cancel-me", "artifact.txt"),
      "some work product",
    )

    clearTaskScanCache()
    const index = scanTasks(taskRoot)

    // Verify the cancelled task is found
    const cancelledTask = index.tasks.find((t) => t.stem === "2026-03-20-cancel-me")
    expect(cancelledTask).toBeDefined()
    expect(cancelledTask!.status).toBe("cancelled")
    expect(cancelledTask!.hasWorkDir).toBe(true)

    // Archive
    const archiveResult = archiveCompletedTasks(index)
    expect(archiveResult.archived.length).toBeGreaterThanOrEqual(1)

    // Verify the task card was moved to archive/one-shots/
    expect(fs.existsSync(path.join(taskRoot, "one-shots", "2026-03-20-cancel-me.md"))).toBe(false)
    expect(fs.existsSync(path.join(taskRoot, "archive", "one-shots", "2026-03-20-cancel-me.md"))).toBe(true)

    // Verify the work directory was moved to archive/one-shots/
    expect(fs.existsSync(path.join(taskRoot, "one-shots", "2026-03-20-cancel-me"))).toBe(false)
    expect(fs.existsSync(path.join(taskRoot, "archive", "one-shots", "2026-03-20-cancel-me"))).toBe(true)
    expect(
      fs.existsSync(path.join(taskRoot, "archive", "one-shots", "2026-03-20-cancel-me", "artifact.txt")),
    ).toBe(true)
  })

  it("dry-run shows correct plan for mixed bundle", () => {
    // Modern task
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-01-clean-task.md"),
      validTaskCard({ title: "Clean Task" }),
    )

    // Legacy task
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-02-old-task.md"),
      legacyTaskCard({ title: "Old Task" }),
    )

    // Non-task markdown (no frontmatter)
    writeFile(
      path.join(taskRoot, "one-shots", "random-notes.md"),
      "# Just some notes\n\nNo frontmatter here\n",
    )

    clearTaskScanCache()
    const dryRun = applyFixes({ mode: "dry-run" }, taskRoot)

    // Nothing applied in dry-run
    expect(dryRun.applied.length).toBe(0)

    // Issues found
    expect(dryRun.remaining.length).toBeGreaterThan(0)

    // Legacy task should be in issues with safe confidence
    const legacyIssue = dryRun.remaining.find((i) => i.code === "schema-missing-kind")
    expect(legacyIssue).toBeDefined()
    expect(legacyIssue!.confidence).toBe("safe")

    // Health summary
    expect(dryRun.health).toBeTruthy()
    expect(dryRun.health).not.toBe("clean")

    // No false errors for random-notes.md (no frontmatter)
    const targets = dryRun.remaining.map((i) => i.target)
    expect(targets).not.toContain("one-shots/random-notes.md")
  })

  it("derivedChildren populated from parent_task links", () => {
    // Parent task
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-01-parent.md"),
      validTaskCard({ title: "Parent Task", status: "processing" }),
    )

    // Child task with parent_task link
    writeFile(
      path.join(taskRoot, "one-shots", "2026-03-02-child.md"),
      validTaskCard({ title: "Child Task", parent_task: "2026-03-01-parent" }),
    )

    clearTaskScanCache()
    const index = scanTasks(taskRoot)

    const parent = index.tasks.find((t) => t.stem === "2026-03-01-parent")
    expect(parent).toBeDefined()
    expect(parent!.derivedChildren).toContain("2026-03-02-child")

    const child = index.tasks.find((t) => t.stem === "2026-03-02-child")
    expect(child).toBeDefined()
    expect(child!.derivedChildren.length).toBe(0) // child has no children
  })
})
