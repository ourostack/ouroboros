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

function removeDirSafe(dir: string): void {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function makeTaskRoot(): string {
  return path.join(agentRoot, "tasks")
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf-8")
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

describe("fix — applyFixes", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-test-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("dry-run mode reports issues without modifying files", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const fix = await import("../../../repertoire/tasks/fix")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      legacyTaskCard(),
    )

    const result = fix.applyFixes({ mode: "dry-run" }, root)

    // Should report the issue but not apply it
    expect(result.remaining.length).toBeGreaterThan(0)
    expect(result.applied).toHaveLength(0)

    // File should be unchanged
    const content = fs.readFileSync(path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"), "utf-8")
    expect(content).not.toContain("kind: task")
  })

  it("safe mode adds kind: task to legacy cards", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const fix = await import("../../../repertoire/tasks/fix")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      legacyTaskCard(),
    )

    const result = fix.applyFixes({ mode: "safe" }, root)

    expect(result.applied.length).toBeGreaterThan(0)
    const kindFix = result.applied.find((i) => i.code === "schema-missing-kind")
    expect(kindFix).toBeDefined()

    // File should now contain kind: task
    const content = fs.readFileSync(path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"), "utf-8")
    expect(content).toContain("kind: task")
  })

  it("safe mode skips needs_review issues", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const fix = await import("../../../repertoire/tasks/fix")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Root-level orphan creates a needs_review issue
    writeFile(
      path.join(root, "orphan-task.md"),
      "---\nkind: task\ntype: one-shot\ntitle: Orphan\nstatus: drafting\ncategory: ops\ncreated: 2026-03-30\nupdated: 2026-03-30\nparent_task: null\ndepends_on: []\nartifacts: []\n---\n\nbody\n",
    )

    const result = fix.applyFixes({ mode: "safe" }, root)

    // Should skip the orphan issue (needs_review)
    expect(result.skipped.length).toBeGreaterThan(0)
    const orphanSkip = result.skipped.find((i) => i.code === "org-root-level-doc")
    expect(orphanSkip).toBeDefined()
  })

  it("re-scans after applying fixes and reports final health", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const fix = await import("../../../repertoire/tasks/fix")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      legacyTaskCard(),
    )

    const result = fix.applyFixes({ mode: "safe" }, root)

    // After fixing, should show clean health (no more migration issues from this file)
    expect(result.health).toBeDefined()
    expect(typeof result.health).toBe("string")
  })

  it("single mode applies fix for specific issue by ID", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const fix = await import("../../../repertoire/tasks/fix")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      legacyTaskCard(),
    )

    const result = fix.applyFixes(
      { mode: "single", issueId: "schema-missing-kind:one-shots/2026-03-30-0800-legacy-task.md" },
      root,
    )

    expect(result.applied.length).toBe(1)
    expect(result.applied[0].code).toBe("schema-missing-kind")
  })

  it("single mode returns empty applied for non-existent issue ID", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const fix = await import("../../../repertoire/tasks/fix")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-clean-task.md"),
      validTaskCard(),
    )

    const result = fix.applyFixes(
      { mode: "single", issueId: "schema-missing-kind:one-shots/nonexistent.md" },
      root,
    )

    expect(result.applied).toHaveLength(0)
  })

  it("returns health: clean when all issues are fixed", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const fix = await import("../../../repertoire/tasks/fix")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Only a safe-fixable issue
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      legacyTaskCard(),
    )

    const result = fix.applyFixes({ mode: "safe" }, root)
    expect(result.health).toContain("clean")
  })
})

describe("lifecycle — archiveCompletedTasks handles cancelled", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("archives cancelled tasks same as done tasks", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const lifecycle = await import("../../../repertoire/tasks/lifecycle")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-cancelled-task.md"),
      validTaskCard({ status: "cancelled", title: "Cancelled Task" }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)
    expect(index.tasks[0].status).toBe("cancelled")

    const result = lifecycle.archiveCompletedTasks(index)

    expect(result.archived).toHaveLength(1)
    expect(result.archived[0]).toContain("archive")
    expect(result.archived[0]).toContain("cancelled-task")
  })

  it("archives cancelled tasks with work directories", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const lifecycle = await import("../../../repertoire/tasks/lifecycle")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    const stem = "2026-03-30-0800-cancelled-with-work"
    writeFile(
      path.join(root, "one-shots", `${stem}.md`),
      validTaskCard({ status: "cancelled", title: "Cancelled With Work" }),
    )
    // Work directory
    const workDir = path.join(root, "one-shots", stem)
    fs.mkdirSync(workDir, { recursive: true })
    writeFile(path.join(workDir, "notes.md"), "artifact")

    const index = scanner.scanTasks(root)
    const result = lifecycle.archiveCompletedTasks(index)

    expect(result.archived).toHaveLength(1)
    // Work dir should have been moved too
    const archiveWorkDir = path.join(root, "archive", "one-shots", stem)
    expect(fs.existsSync(archiveWorkDir)).toBe(true)
  })

  it("does not archive active tasks when cancelled tasks exist", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const lifecycle = await import("../../../repertoire/tasks/lifecycle")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-active-task.md"),
      validTaskCard({ status: "processing", title: "Active" }),
    )
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0801-cancelled-task.md"),
      validTaskCard({ status: "cancelled", title: "Cancelled" }),
    )

    const index = scanner.scanTasks(root)
    const result = lifecycle.archiveCompletedTasks(index)

    // Only cancelled is archived, not the active one
    expect(result.archived).toHaveLength(1)
    expect(result.archived[0]).toContain("cancelled-task")
    // Active task should still exist
    expect(fs.existsSync(path.join(root, "one-shots", "2026-03-30-0800-active-task.md"))).toBe(true)
  })

  it("detectStaleTasks excludes cancelled tasks", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const lifecycle = await import("../../../repertoire/tasks/lifecycle")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Old cancelled task
    writeFile(
      path.join(root, "one-shots", "2026-01-01-0800-old-cancelled.md"),
      validTaskCard({ status: "cancelled", title: "Old Cancelled", updated: "2026-01-01" }),
    )

    const index = scanner.scanTasks(root)
    const stale = lifecycle.detectStaleTasks(index, 7)

    // Cancelled tasks should NOT appear as stale
    expect(stale).toHaveLength(0)
  })
})

describe("createTask — kind: task frontmatter", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-task-test-"))
  })

  afterEach(async () => {
    const tasks = await import("../../../repertoire/tasks")
    tasks.resetTaskModule()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("creates task files with kind: task in frontmatter", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const parser = await import("../../../repertoire/tasks/parser")
    const module = tasks.getTaskModule()

    const created = module.createTask({
      title: "New Task",
      type: "one-shot",
      category: "infrastructure",
      body: "## scope\ntask body",
    })

    const content = fs.readFileSync(created, "utf-8")
    const parsed = parser.parseTaskFile(content, created)

    expect(parsed.frontmatter.kind).toBe("task")
  })

  it("does NOT write child_tasks in frontmatter", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const module = tasks.getTaskModule()

    const created = module.createTask({
      title: "No Children",
      type: "one-shot",
      category: "infrastructure",
      body: "## scope\ntask body",
    })

    const content = fs.readFileSync(created, "utf-8")

    // child_tasks should not appear in the file at all
    expect(content).not.toContain("child_tasks")
  })
})

describe("index — fix() method on TaskModule", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "module-fix-test-"))
  })

  afterEach(async () => {
    const tasks = await import("../../../repertoire/tasks")
    tasks.resetTaskModule()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("fix() delegates to applyFixes and returns FixResult", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const tasks = await import("../../../repertoire/tasks")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      legacyTaskCard(),
    )

    const module = tasks.getTaskModule()
    const result = module.fix({ mode: "dry-run" })

    expect(result).toBeDefined()
    expect(result.remaining.length).toBeGreaterThan(0)
    expect(result.applied).toHaveLength(0)
    expect(typeof result.health).toBe("string")
  })
})
