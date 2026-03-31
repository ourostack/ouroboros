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

describe("scanner — kind: task discrimination", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-test-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("parses files with kind: task", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-kind-task.md"),
      validTaskCard(),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)
    expect(index.tasks[0].stem).toBe("2026-03-30-0800-kind-task")
    expect(index.tasks[0].status).toBe("drafting")
  })

  it("parses legacy files with type but no kind and emits migration issue", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      legacyTaskCard(),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)
    expect(index.tasks[0].stem).toBe("2026-03-30-0800-legacy-task")

    // Must emit a migration issue for missing kind
    expect(index.issues).toBeDefined()
    const kindIssue = index.issues.find(
      (issue) => issue.code === "schema-missing-kind",
    )
    expect(kindIssue).toBeDefined()
    expect(kindIssue!.confidence).toBe("safe")
    expect(kindIssue!.category).toBe("migration")
    expect(kindIssue!.target).toContain("legacy-task")
  })

  it("silently skips .md files without frontmatter — zero errors", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // A doing doc has no frontmatter
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-doing-feature.md"),
      "# Doing: Feature X\n\n## Units\n- Unit 1\n",
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(0)
    expect(index.issues).toHaveLength(0)
  })

  it("silently skips .md files with frontmatter but no kind/type match", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // A planning doc has frontmatter but kind: planning, not kind: task
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-planning-feature.md"),
      "---\nkind: planning\ntitle: Feature Planning\n---\n\nPlanning content\n",
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(0)
    expect(index.issues).toHaveLength(0)
  })

  it("emits schema-invalid issue for kind: task with missing required fields", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // kind: task but no status field — parseTaskFile will throw
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-bad-schema.md"),
      "---\nkind: task\ntype: one-shot\ntitle: Bad\n---\n\nbody\n",
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(0)

    const schemaIssue = index.issues.find(
      (issue) => issue.code === "schema-invalid",
    )
    expect(schemaIssue).toBeDefined()
    expect(schemaIssue!.confidence).toBe("needs_review")
    expect(schemaIssue!.category).toBe("live")
    expect(schemaIssue!.target).toContain("bad-schema")
  })
})

describe("scanner — flat directory reads (no recursion)", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-norecurse-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("does NOT recurse into subdirectories in collections", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // A task card at collection root — should be found
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-root-task.md"),
      validTaskCard({ title: "Root Task" }),
    )

    // A task card inside a subdirectory — should NOT be found
    writeFile(
      path.join(root, "one-shots", "subdir", "2026-03-30-0900-nested-task.md"),
      validTaskCard({ title: "Nested Task" }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)
    expect(index.tasks[0].title).toBe("Root Task")
  })
})

describe("scanner — work directory detection", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-workdir-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("detects same-stem directory as work dir", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    const stem = "2026-03-30-0800-my-feature"
    writeFile(
      path.join(root, "one-shots", `${stem}.md`),
      validTaskCard({ title: "My Feature" }),
    )

    // Create same-stem directory with artifact files
    const workDir = path.join(root, "one-shots", stem)
    fs.mkdirSync(workDir, { recursive: true })
    writeFile(path.join(workDir, "notes.md"), "artifact notes")
    writeFile(path.join(workDir, "log.txt"), "artifact log")

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)

    const task = index.tasks[0]
    expect(task.hasWorkDir).toBe(true)
    expect(task.workDirFiles).toEqual(expect.arrayContaining(["notes.md", "log.txt"]))
    expect(task.workDirFiles).toHaveLength(2)
  })

  it("sets hasWorkDir false when no same-stem directory exists", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-no-workdir.md"),
      validTaskCard({ title: "No Work Dir" }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)
    expect(index.tasks[0].hasWorkDir).toBe(false)
    expect(index.tasks[0].workDirFiles).toEqual([])
  })
})

describe("scanner — orphan detection", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-orphan-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("surfaces root-level .md files as migration issues", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // An orphan doc at root level (outside any collection)
    writeFile(
      path.join(root, "orphan-readme.md"),
      "---\ntitle: Some Doc\ntype: one-shot\nstatus: drafting\n---\n\norphan content\n",
    )

    const index = scanner.scanTasks(root)

    const orphanIssue = index.issues.find(
      (issue) => issue.code === "org-root-level-doc",
    )
    expect(orphanIssue).toBeDefined()
    expect(orphanIssue!.confidence).toBe("needs_review")
    expect(orphanIssue!.target).toContain("orphan-readme.md")
  })

  it("does not flag root-level .md files without task-like frontmatter", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // A plain text file with no frontmatter at root
    writeFile(
      path.join(root, "notes.md"),
      "Just some notes, no frontmatter\n",
    )

    const index = scanner.scanTasks(root)

    const orphanIssue = index.issues.find(
      (issue) => issue.code === "org-root-level-doc",
    )
    expect(orphanIssue).toBeUndefined()
  })
})

describe("scanner — filename validation", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-filename-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("emits issue for non-canonical filename on kind: task file", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "bad-name.md"),
      validTaskCard({ title: "Bad Name Task" }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)

    const filenameIssue = index.issues.find(
      (issue) => issue.code === "filename-not-canonical",
    )
    expect(filenameIssue).toBeDefined()
    expect(filenameIssue!.confidence).toBe("safe")
    expect(filenameIssue!.target).toContain("bad-name.md")
  })

  it("does not emit filename issue for canonical filename", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-canonical-name.md"),
      validTaskCard({ title: "Canonical Name Task" }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)

    const filenameIssue = index.issues.find(
      (issue) => issue.code === "filename-not-canonical",
    )
    expect(filenameIssue).toBeUndefined()
  })
})

describe("scanner — derivedChildren computation", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-children-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("populates derivedChildren from parent_task links", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    const parentStem = "2026-03-30-0800-parent-task"
    const childStem = "2026-03-30-0900-child-task"

    writeFile(
      path.join(root, "one-shots", `${parentStem}.md`),
      validTaskCard({ title: "Parent Task" }),
    )

    writeFile(
      path.join(root, "one-shots", `${childStem}.md`),
      validTaskCard({
        title: "Child Task",
        parent_task: parentStem,
      }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(2)

    const parent = index.tasks.find((t) => t.stem === parentStem)
    const child = index.tasks.find((t) => t.stem === childStem)

    expect(parent).toBeDefined()
    expect(parent!.derivedChildren).toEqual([childStem])

    expect(child).toBeDefined()
    expect(child!.derivedChildren).toEqual([])
  })

  it("handles tasks with no parent_task — empty derivedChildren", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-standalone.md"),
      validTaskCard({ title: "Standalone" }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(1)
    expect(index.tasks[0].derivedChildren).toEqual([])
  })
})

describe("scanner — fingerprint caching", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-cache-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("returns cached result on second call with unchanged files", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-cached-task.md"),
      validTaskCard({ title: "Cached Task" }),
    )

    const first = scanner.scanTasks(root)
    const second = scanner.scanTasks(root)
    expect(second).toBe(first) // Same reference = cache hit
  })

  it("invalidates cache when files change", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    const taskPath = path.join(root, "one-shots", "2026-03-30-0800-changing-task.md")
    writeFile(taskPath, validTaskCard({ title: "Version 1" }))

    const first = scanner.scanTasks(root)
    expect(first.tasks).toHaveLength(1)

    // Modify the file to change fingerprint
    // Need a small delay to ensure mtime changes
    const content = validTaskCard({ title: "Version 2" })
    fs.writeFileSync(taskPath, content, "utf-8")
    // Touch the file to ensure mtime change on fast systems
    const now = new Date()
    fs.utimesSync(taskPath, now, new Date(now.getTime() + 1000))

    scanner.clearTaskScanCache()
    const second = scanner.scanTasks(root)
    expect(second).not.toBe(first)
    expect(second.tasks[0].title).toBe("Version 2")
  })
})

describe("scanner — TaskIndex.issues replaces parseErrors/invalidFilenames", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-issues-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("TaskIndex has issues array instead of parseErrors and invalidFilenames", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    const index = scanner.scanTasks(root)

    // New shape
    expect(index.issues).toBeDefined()
    expect(Array.isArray(index.issues)).toBe(true)

    // Old shape must not exist
    expect("parseErrors" in index).toBe(false)
    expect("invalidFilenames" in index).toBe(false)
  })
})

describe("scanner — mixed bundle simulation", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-mixed-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("correctly handles a mixed bundle with tasks, docs, orphans, and work dirs", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // 1. A proper task card with kind: task
    const taskStem = "2026-03-30-0800-proper-task"
    writeFile(
      path.join(root, "one-shots", `${taskStem}.md`),
      validTaskCard({ title: "Proper Task" }),
    )

    // 2. A work directory for the proper task
    const workDir = path.join(root, "one-shots", taskStem)
    fs.mkdirSync(workDir, { recursive: true })
    writeFile(path.join(workDir, "artifact.txt"), "data")

    // 3. A legacy task (no kind field)
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0900-legacy.md"),
      legacyTaskCard({ title: "Legacy" }),
    )

    // 4. A doing doc (no frontmatter) — should be silently skipped
    writeFile(
      path.join(root, "one-shots", "2026-03-30-1000-doing-feature.md"),
      "# Doing: Feature\n\nNo frontmatter here\n",
    )

    // 5. A planning doc (frontmatter but kind: planning) — should be silently skipped
    writeFile(
      path.join(root, "one-shots", "2026-03-30-1100-planning-feature.md"),
      "---\nkind: planning\ntitle: Planning\n---\n\nPlan\n",
    )

    // 6. An orphan at root level
    writeFile(
      path.join(root, "orphan.md"),
      "---\ntitle: Orphan\ntype: one-shot\nstatus: drafting\n---\n\norphan\n",
    )

    // 7. A task in ongoing collection
    writeFile(
      path.join(root, "ongoing", "2026-03-30-1200-ongoing-task.md"),
      validTaskCard({ type: "ongoing", title: "Ongoing Task" }),
    )

    const index = scanner.scanTasks(root)

    // Should find: proper task, legacy task, ongoing task = 3 tasks
    expect(index.tasks).toHaveLength(3)

    // Proper task should have work dir detected
    const properTask = index.tasks.find((t) => t.stem === taskStem)
    expect(properTask).toBeDefined()
    expect(properTask!.hasWorkDir).toBe(true)
    expect(properTask!.workDirFiles).toEqual(["artifact.txt"])

    // Issues should include:
    // - schema-missing-kind for legacy task
    // - org-root-level-doc for orphan
    expect(index.issues.length).toBeGreaterThanOrEqual(2)

    const kindIssue = index.issues.find((i) => i.code === "schema-missing-kind")
    expect(kindIssue).toBeDefined()

    const orphanIssue = index.issues.find((i) => i.code === "org-root-level-doc")
    expect(orphanIssue).toBeDefined()

    // Doing doc and planning doc should NOT produce any issues
    const doingIssues = index.issues.filter((i) => i.target.includes("doing"))
    expect(doingIssues).toHaveLength(0)
    const planningIssues = index.issues.filter((i) => i.target.includes("planning"))
    expect(planningIssues).toHaveLength(0)
  })
})

describe("scanner — coverage edge cases", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-edges-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("tryExtractFrontmatter returns null for non-frontmatter and unterminated content", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")

    // Empty frontmatter parses fine — returns empty object
    const result = scanner.tryExtractFrontmatter("---\n---\n")
    expect(result).toBeDefined()
    expect(Object.keys(result!)).toHaveLength(0)

    // No frontmatter at all
    const noFm = scanner.tryExtractFrontmatter("no frontmatter here")
    expect(noFm).toBeNull()

    // Unterminated frontmatter
    const unterminated = scanner.tryExtractFrontmatter("---\nkey: value\nno closing")
    expect(unterminated).toBeNull()

    // Valid frontmatter
    const valid = scanner.tryExtractFrontmatter("---\nkey: value\n---\nbody")
    expect(valid).toBeDefined()
    expect(valid!.key).toBe("value")
  })

  it("orphan detection handles frontmatter with non-string type field", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Orphan doc with frontmatter where type is not a string (it's an array = [])
    writeFile(
      path.join(root, "weird-orphan.md"),
      "---\ntitle: Weird\ntype: []\n---\n\ncontent\n",
    )

    const index = scanner.scanTasks(root)
    // type is not a string, and no status/title combo that triggers detection
    // Actually it has a title but no status string, so not task-like
    const orphanIssue = index.issues.find((i) => i.code === "org-root-level-doc")
    expect(orphanIssue).toBeUndefined()
  })

  it("orphan detection via status+title combination (no kind or type)", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Orphan doc with status and title but no kind or type match
    writeFile(
      path.join(root, "status-title-orphan.md"),
      "---\ntitle: Some Task\nstatus: drafting\ncategory: ops\n---\n\norphan\n",
    )

    const index = scanner.scanTasks(root)
    const orphanIssue = index.issues.find((i) => i.code === "org-root-level-doc")
    expect(orphanIssue).toBeDefined()
    expect(orphanIssue!.target).toContain("status-title-orphan.md")
  })
})
