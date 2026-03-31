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

describe("task module", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-module-"))
  })

  afterEach(async () => {
    const tasks = await import("../../../repertoire/tasks")
    tasks.resetTaskModule()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("creates canonical tasks under bundle root and scans them", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const module = tasks.getTaskModule()

    const created = module.createTask({
      title: "Task System Bootstrap",
      type: "one-shot",
      category: "infrastructure",
      body: "## scope\nship task module",
    })

    expect(created).toContain(path.join("tasks", "one-shots"))
    expect(path.basename(created)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9][a-z0-9-]*\.md$/)

    const index = module.scan()
    expect(index.tasks).toHaveLength(1)
    expect(index.tasks[0].status).toBe("drafting")
    expect(index.tasks[0].type).toBe("one-shot")
  })

  it("applies create-task defaults and rejects invalid type/status values", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const parser = await import("../../../repertoire/tasks/parser")
    const module = tasks.getTaskModule()

    expect(() =>
      module.createTask({
        title: "Invalid Type",
        type: "not-a-type",
        category: "ops",
        body: "body",
      }),
    ).toThrow("invalid task type")

    expect(() =>
      module.createTask({
        title: "Invalid Status",
        type: "one-shot",
        category: "ops",
        body: "body",
        status: "not-a-status",
      }),
    ).toThrow("invalid task status")

    const ongoingPath = module.createTask({
      title: "!!!",
      type: "ongoing",
      category: "",
      body: "body",
    })
    expect(path.basename(ongoingPath)).toContain("-task.md")

    const parsed = parser.parseTaskFile(fs.readFileSync(ongoingPath, "utf-8"), ongoingPath)
    expect(parsed.collection).toBe("ongoing")
    expect(parsed.category).toBe("infrastructure")
    expect(parsed.frontmatter.cadence).toBeNull()
    expect(parsed.frontmatter.lastRun).toBeNull()
  })

  it("persists scheduledAt and cadence metadata for scheduler reconciliation", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const parser = await import("../../../repertoire/tasks/parser")
    const module = tasks.getTaskModule()

    const oneShotPath = module.createTask({
      title: "Remind Ari",
      type: "one-shot",
      category: "reminder",
      body: "Ping Ari about BB",
      scheduledAt: "2026-03-10T17:00:00.000Z",
    })

    const ongoingPath = module.createTask({
      title: "Heartbeat",
      type: "ongoing",
      category: "operations",
      body: "Run heartbeat",
      cadence: "30m",
    })

    const oneShot = parser.parseTaskFile(fs.readFileSync(oneShotPath, "utf-8"), oneShotPath)
    const ongoing = parser.parseTaskFile(fs.readFileSync(ongoingPath, "utf-8"), ongoingPath)

    expect(oneShot.frontmatter.scheduledAt).toBe("2026-03-10T17:00:00.000Z")
    expect(oneShot.frontmatter.cadence).toBeNull()
    expect(ongoing.frontmatter.cadence).toBe("30m")
    expect(ongoing.frontmatter.scheduledAt).toBeNull()
  })

  it("links reminder task metadata to daemon scheduler jobs", async () => {
    const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-module-scheduler-"))
    removeDirSafe(agentRoot)
    agentRoot = path.join(parentRoot, "slugger.ouro")
    fs.mkdirSync(agentRoot, { recursive: true })

    const tasks = await import("../../../repertoire/tasks")
    const { TaskDrivenScheduler } = await import("../../../heart/daemon/task-scheduler")
    const module = tasks.getTaskModule()

    const created = module.createTask({
      title: "Remind Ari",
      type: "one-shot",
      category: "reminder",
      body: "Ping Ari about BB",
      scheduledAt: "2026-03-10T17:00:00.000Z",
    })

    const stem = path.basename(created, ".md")
    const scheduler = new TaskDrivenScheduler({
      bundlesRoot: parentRoot,
      agents: ["slugger"],
    })

    await scheduler.reconcile()

    expect(scheduler.listJobs()).toEqual([
      expect.objectContaining({
        id: `slugger:${stem}:scheduledAt`,
        schedule: "0 17 10 3 *",
      }),
    ])
  })

  it("reuses singleton module instance and returns empty results for unknown board status", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const first = tasks.getTaskModule()
    const second = tasks.getTaskModule()
    expect(second).toBe(first)
    expect(first.boardStatus("not-a-status")).toEqual([])
  })

  it("ensureTaskLayout does not create tasks/habits/", async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.ensureTaskLayout()

    const habitsDir = path.join(agentRoot, "tasks", "habits")
    expect(fs.existsSync(habitsDir)).toBe(false)
  })

  it("reuses scanner cache when filesystem fingerprint is unchanged", async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.ensureTaskLayout()

    const first = scanner.scanTasks()
    const second = scanner.scanTasks()
    expect(second).toBe(first)
  })

  it("validates transitions and archives done tasks", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const module = tasks.getTaskModule()

    const created = module.createTask({
      title: "Transition Exercise",
      type: "ongoing",
      category: "ops",
      body: "## scope\nexercise transitions",
    })
    const stem = path.basename(created, ".md")

    const invalid = module.updateStatus(stem, "done")
    expect(invalid.ok).toBe(false)
    expect(invalid.reason).toContain("invalid transition")

    expect(module.updateStatus(stem, "processing").ok).toBe(true)
    expect(module.updateStatus(stem, "validating").ok).toBe(true)

    const done = module.updateStatus(stem, "done")
    expect(done.ok).toBe(true)
    expect(done.archived && done.archived.length).toBeGreaterThan(0)

    const archivedFile = done.archived?.[0] ?? ""
    expect(archivedFile).toContain(path.join("tasks", "archive", "ongoing"))
    expect(fs.existsSync(archivedFile)).toBe(true)
  })

  it("enforces write and spawn gates", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const parser = await import("../../../repertoire/tasks/parser")
    const module = tasks.getTaskModule()

    const badFilename = module.validateWrite(
      path.join(agentRoot, "tasks", "one-shots", "not-canonical.md"),
      "---\ntype: one-shot\nstatus: drafting\n---\nbody",
    )
    expect(badFilename.ok).toBe(false)
    expect(badFilename.reason).toContain("non-canonical")

    const missingFieldsContent = parser.renderTaskFile(
      {
        type: "one-shot",
        status: "drafting",
        title: "Missing category",
        created: "2026-03-01",
        updated: "2026-03-01",
      },
      "body",
    )
    const canonicalPath = path.join(agentRoot, "tasks", "one-shots", "2026-03-01-0900-missing-category.md")
    const missingFields = module.validateWrite(canonicalPath, missingFieldsContent)
    expect(missingFields.ok).toBe(false)
    expect(missingFields.reason).toContain("missing required")

    const created = module.createTask({
      title: "Spawn Gate Task",
      type: "one-shot",
      category: "infrastructure",
      body: "No explicit scope section",
    })
    const stem = path.basename(created, ".md")

    const draftingSpawn = module.validateSpawn(stem, "coding")
    expect(draftingSpawn.ok).toBe(false)
    expect(draftingSpawn.reason).toBe("spawn-coding-task-status")

    expect(module.updateStatus(stem, "processing").ok).toBe(true)

    const noScope = module.validateSpawn(stem, "coding")
    expect(noScope.ok).toBe(false)
    expect(noScope.reason).toBe("spawn-coding-scope-missing")

    const content = fs.readFileSync(created, "utf-8")
    const parsed = parser.parseTaskFile(content, created)
    const frontmatter = { ...parsed.frontmatter }
    delete frontmatter._isCanonicalFilename
    fs.writeFileSync(created, parser.renderTaskFile(frontmatter, "## scope\nimplemented"), "utf-8")
    const withScope = module.validateSpawn(stem, "coding")
    expect(withScope.ok).toBe(true)
  })

  it("builds board views with dependencies, action items, and sessions", async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    const parser = await import("../../../repertoire/tasks/parser")
    const tasks = await import("../../../repertoire/tasks")

    scanner.ensureTaskLayout()

    const processingPath = path.join(agentRoot, "tasks", "one-shots", "2026-03-01-0800-processing-task.md")
    const blockedPath = path.join(agentRoot, "tasks", "ongoing", "2026-03-01-0900-blocked-task.md")
    const badNamePath = path.join(agentRoot, "tasks", "one-shots", "bad-name.md")
    const missingCategoryPath = path.join(agentRoot, "tasks", "one-shots", "2026-03-01-0915-missing-category.md")
    const emptySuffixPath = path.join(agentRoot, "tasks", "one-shots", "2026-03-01-0916-.md")

    fs.writeFileSync(
      processingPath,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "infrastructure",
          title: "Processing",
          status: "processing",
          created: "2026-03-01",
          updated: "2026-03-01",
          parent_task: null,
          depends_on: ["2026-03-01-9999-missing-dep", "2026-03-01-0900-blocked-task", ""],
          child_tasks: [],
          artifacts: [],
        },
        "## scope\ndo work",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      blockedPath,
      parser.renderTaskFile(
        {
          type: "ongoing",
          category: "ops",
          title: "Blocked",
          status: "blocked",
          created: "2026-03-01",
          updated: "2026-03-01",
          child_tasks: [],
          artifacts: [],
          active_session: "session-123",
        },
        "body",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      badNamePath,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "research",
          title: "Bad Name",
          status: "drafting",
          created: "2026-03-01",
          updated: "2026-03-01",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      missingCategoryPath,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "",
          title: "Needs Category",
          status: "drafting",
          created: "2026-03-01",
          updated: "2026-03-01",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      emptySuffixPath,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Empty Suffix",
          status: "drafting",
          created: "2026-03-01",
          updated: "2026-03-01",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    const module = tasks.getTaskModule()
    const board = module.getBoard()

    expect(board.compact).toContain("processing:1")
    expect(board.compact).toContain("blocked:1")
    expect(module.boardStatus("processing")).toHaveLength(1)
    expect(module.boardDeps()[0]).toContain("missing")
    expect(module.boardSessions()).toEqual(["2026-03-01-0900-blocked-task"])
    expect(module.boardAction().some((line) => line.includes("filename-not-canonical"))).toBe(true)
    expect(module.boardAction().some((line) => line.includes("missing category"))).toBe(true)
    expect(board.full).toContain("2026-03-01-0916-")
  })

  it("binds bridge metadata to task files and surfaces active bridges on the board", async () => {
    const parser = await import("../../../repertoire/tasks/parser")
    const tasks = await import("../../../repertoire/tasks")
    const module = tasks.getTaskModule() as unknown as {
      createTask: (input: {
        title: string
        type: string
        category: string
        body: string
        status?: string
      }) => string
      bindBridge: (name: string, input: { bridgeId: string; sessionRefs: string[] }) => { ok: boolean; path?: string }
      getBoard: () => { full: string; activeBridges: string[] }
    }

    const created = module.createTask({
      title: "Shared Relay",
      type: "ongoing",
      category: "coordination",
      status: "processing",
      body: "## scope\ncoordinate two live surfaces",
    })
    const stem = path.basename(created, ".md")

    expect(
      module.bindBridge(stem, {
        bridgeId: "bridge-1",
        sessionRefs: ["friend-1/cli/session", "friend-1/teams/conv-1"],
      }),
    ).toEqual({
      ok: true,
      path: created,
    })

    const parsed = parser.parseTaskFile(fs.readFileSync(created, "utf-8"), created)
    expect(parsed.frontmatter.active_bridge).toBe("bridge-1")
    expect(parsed.frontmatter.bridge_sessions).toEqual(["friend-1/cli/session", "friend-1/teams/conv-1"])

    const board = module.getBoard()
    expect(board.activeBridges).toEqual([`${stem} -> bridge-1`])
    expect(board.full).toContain("## active bridges")
    expect(board.full).toContain("bridge-1")
  })

  it("persists bridge metadata during task creation and returns bindBridge miss errors", async () => {
    const parser = await import("../../../repertoire/tasks/parser")
    const tasks = await import("../../../repertoire/tasks")
    const module = tasks.getTaskModule() as unknown as {
      createTask: (input: {
        title: string
        type: string
        category: string
        body: string
        status?: string
        activeBridge?: string
        bridgeSessions?: string[]
      }) => string
      bindBridge: (name: string, input: { bridgeId: string; sessionRefs: string[] }) => { ok: boolean; reason?: string }
    }

    const created = module.createTask({
      title: "Bridge Metadata",
      type: "ongoing",
      category: "coordination",
      status: "processing",
      body: "## scope\ncarry the bridge metadata",
      activeBridge: "bridge-2",
      bridgeSessions: ["friend-1/cli/session", "  ", "friend-1/teams/conv-1"],
    })
    const parsed = parser.parseTaskFile(fs.readFileSync(created, "utf-8"), created)
    expect(parsed.frontmatter.active_bridge).toBe("bridge-2")
    expect(parsed.frontmatter.bridge_sessions).toEqual(["friend-1/cli/session", "friend-1/teams/conv-1"])

    expect(module.bindBridge("missing-task", { bridgeId: "bridge-3", sessionRefs: [] })).toEqual({
      ok: false,
      reason: "task not found: missing-task",
    })
  })

  it("detects stale tasks while excluding done tasks", async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    const parser = await import("../../../repertoire/tasks/parser")
    const tasks = await import("../../../repertoire/tasks")

    scanner.ensureTaskLayout()

    const staleProcessing = path.join(agentRoot, "tasks", "one-shots", "2026-01-01-0800-stale-task.md")
    const doneTask = path.join(agentRoot, "tasks", "one-shots", "2026-01-02-0800-done-task.md")
    const invalidDateTask = path.join(agentRoot, "tasks", "one-shots", "2026-01-03-0800-invalid-date-task.md")

    fs.writeFileSync(
      staleProcessing,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Stale",
          status: "paused",
          created: "2026-01-01",
          updated: "2026-01-05",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      doneTask,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Done",
          status: "done",
          created: "2026-01-01",
          updated: "2026-01-03",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      invalidDateTask,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Invalid Date",
          status: "processing",
          created: "2026-01-01",
          updated: "not-a-date",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    const module = tasks.getTaskModule()
    const stale = module.detectStale(7)
    expect(stale.map((task) => task.stem)).toContain("2026-01-01-0800-stale-task")
    expect(stale.map((task) => task.stem)).not.toContain("2026-01-02-0800-done-task")
    expect(stale.map((task) => task.stem)).not.toContain("2026-01-03-0800-invalid-date-task")
  })

  it("returns explicit errors for invalid status target and missing task lookups", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const module = tasks.getTaskModule()

    const invalidStatus = module.updateStatus("missing", "not-a-status")
    expect(invalidStatus.ok).toBe(false)
    expect(invalidStatus.reason).toContain("invalid target status")

    const missingTask = module.updateStatus("missing", "processing")
    expect(missingTask.ok).toBe(false)
    expect(missingTask.reason).toContain("task not found")

    const missingSpawn = module.validateSpawn("missing", "coding")
    expect(missingSpawn.ok).toBe(false)
    expect(missingSpawn.reason).toContain("task not found")

    expect(module.validateTransition("processing", "processing").ok).toBe(true)
  })

  it("validates parser edge paths and scanner parse errors", async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    const parser = await import("../../../repertoire/tasks/parser")
    scanner.ensureTaskLayout()

    const nestedDir = path.join(agentRoot, "tasks", "one-shots", "nested")
    const reservedDir = path.join(agentRoot, "tasks", "one-shots", "archive")
    fs.mkdirSync(nestedDir, { recursive: true })
    fs.mkdirSync(reservedDir, { recursive: true })

    const nestedFile = path.join(nestedDir, "2026-03-02-1000-nested-task.md")
    const reservedFile = path.join(reservedDir, "2026-03-02-1001-reserved-task.md")
    const badFrontmatterFile = path.join(agentRoot, "tasks", "one-shots", "2026-03-02-1002-bad-frontmatter.md")

    fs.writeFileSync(
      nestedFile,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Nested Task",
          status: "drafting",
          created: "2026-03-02",
          updated: "2026-03-02",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      reservedFile,
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Reserved Task",
          status: "drafting",
          created: "2026-03-02",
          updated: "2026-03-02",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      "utf-8",
    )

    fs.writeFileSync(
      badFrontmatterFile,
      "---\ntype: one-shot\ncategory: infra\n",
      "utf-8",
    )

    const root = path.join(agentRoot, "tasks")
    const index = scanner.scanTasks(root)
    // Flat scanner does not recurse into subdirectories
    expect(index.tasks.some((task) => task.path === nestedFile)).toBe(false)
    expect(index.tasks.some((task) => task.path === reservedFile)).toBe(false)
    // Unterminated frontmatter means tryExtractFrontmatter returns null — silently skipped
    expect(index.issues.some((issue) => issue.code === "schema-invalid")).toBe(false)

    const fallbackPath = path.join(agentRoot, "tasks", "custom", "2026-03-02-1100-custom-ongoing.md")
    const parsedFallback = parser.parseTaskFile(
      parser.renderTaskFile(
        {
          type: "ongoing",
          category: "ops",
          title: "Custom Ongoing",
          status: "drafting",
          created: "2026-03-02",
          updated: "2026-03-02",
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      fallbackPath,
    )
    expect(parsedFallback.collection).toBe("ongoing")

    expect(() => parser.parseTaskFile("---\ntype: one-shot", fallbackPath)).toThrow("unterminated frontmatter")
    expect(() =>
      parser.parseTaskFile(
        parser.renderTaskFile(
          {
            type: "invalid-type",
            category: "ops",
            title: "Bad Type",
            status: "drafting",
            created: "2026-03-02",
            updated: "2026-03-02",
          },
          "body",
        ),
        fallbackPath,
      ),
    ).toThrow("invalid type")
    expect(() =>
      parser.parseTaskFile(
        parser.renderTaskFile(
          {
            type: "one-shot",
            category: "ops",
            title: "Bad Status",
            status: "invalid-status",
            created: "2026-03-02",
            updated: "2026-03-02",
          },
          "body",
        ),
        fallbackPath,
      ),
    ).toThrow("invalid status")

    const ongoingPath2 = path.join(agentRoot, "tasks", "ongoing", "2026-03-02-1105-ongoing-task.md")
    const ongoingFromCollection = parser.parseTaskFile(
      parser.renderTaskFile(
        {
          type: "ongoing",
          status: "drafting",
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      ongoingPath2,
    )
    expect(ongoingFromCollection.collection).toBe("ongoing")
    expect(ongoingFromCollection.title).toBe("2026-03-02-1105-ongoing-task")
    expect(ongoingFromCollection.category).toBe("infrastructure")
    expect(ongoingFromCollection.created).toBe("")
    expect(ongoingFromCollection.updated).toBe("")
  })

  it("parser collection inference does not return habits for paths containing habits", async () => {
    const parser = await import("../../../repertoire/tasks/parser")
    // A task file in a path containing "habits" should NOT get collection "habits"
    // since "habits" is no longer a canonical collection.
    // With "habit" removed as a type, the parser should reject this entirely.
    expect(() =>
      parser.parseTaskFile(
        parser.renderTaskFile(
          {
            type: "ongoing",
            category: "ops",
            title: "Not a habit",
            status: "drafting",
            created: "2026-03-02",
            updated: "2026-03-02",
          },
          "body",
        ),
        path.join(agentRoot, "tasks", "habits", "2026-03-02-1105-not-a-habit.md"),
      ),
    ).not.toThrow()

    const parsed = parser.parseTaskFile(
      parser.renderTaskFile(
        {
          type: "ongoing",
          category: "ops",
          title: "Not a habit",
          status: "drafting",
          created: "2026-03-02",
          updated: "2026-03-02",
        },
        "body",
      ),
      path.join(agentRoot, "tasks", "habits", "2026-03-02-1105-not-a-habit.md"),
    )
    expect(parsed.collection).not.toBe("habits")
  })

  it("parses frontmatter with quotes, blank lines, and non-key lines", async () => {
    const parser = await import("../../../repertoire/tasks/parser")
    const frontmatter = parser.parseFrontmatter(
      [
        "title: \"Double\"",
        "owner: 'Single'",
        "",
        "this line is ignored",
        "depends_on:",
        "- item-a",
        "empty_list: []",
        "nullable: null",
      ].join("\n"),
    )
    expect(frontmatter.title).toBe("Double")
    expect(frontmatter.owner).toBe("Single")
    expect(frontmatter.depends_on).toEqual(["item-a"])
    expect(frontmatter.empty_list).toEqual([])
    expect(frontmatter.nullable).toBeNull()
  })

  it("covers write/spawn middleware edge branches", async () => {
    const middleware = await import("../../../repertoire/tasks/middleware")
    const parser = await import("../../../repertoire/tasks/parser")

    const canonicalPath = path.join(agentRoot, "tasks", "one-shots", "2026-03-02-1200-middleware-task.md")
    const badWrite = middleware.validateWrite(canonicalPath, "not frontmatter")
    expect(badWrite.ok).toBe(false)
    expect(String(badWrite.reason)).toContain("missing frontmatter")

    const weirdPath = { split: () => [] } as unknown as string
    const weirdWrite = middleware.validateWrite(weirdPath, "body")
    expect(weirdWrite).toEqual({ ok: false, reason: "non-canonical filename" })

    const doneTask = parser.parseTaskFile(
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Done Task",
          status: "done",
          created: "2026-03-02",
          updated: "2026-03-02",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      canonicalPath,
    )
    expect(middleware.validateSpawn(doneTask, "coding")).toEqual({ ok: false, reason: "spawn-completed-path" })

    const draftingTask = parser.parseTaskFile(
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Drafting Task",
          status: "drafting",
          created: "2026-03-02",
          updated: "2026-03-02",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
          pipeline_stage: "implementation",
        },
        "body",
      ),
      canonicalPath,
    )
    expect(middleware.validateSpawn(draftingTask, "coding")).toEqual({ ok: false, reason: "spawn-coding-pipeline-stage" })

    const plainDraftingTask = parser.parseTaskFile(
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Plain Drafting Task",
          status: "drafting",
          created: "2026-03-02",
          updated: "2026-03-02",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      canonicalPath,
    )
    expect(middleware.validateSpawn(plainDraftingTask, "review")).toEqual({ ok: true })
  })

  it("stringifies non-Error parser failures from middleware and scanner", async () => {
    vi.resetModules()
    const realParser = await import("../../../repertoire/tasks/parser")
    vi.doMock("../../../repertoire/tasks/parser", () => ({
      parseFrontmatter: realParser.parseFrontmatter,
      parseTaskFile: () => {
        throw "parser-exploded"
      },
    }))

    try {
      const middleware = await import("../../../repertoire/tasks/middleware")
      const scanner = await import("../../../repertoire/tasks/scanner")

      const canonicalPath = path.join(agentRoot, "tasks", "one-shots", "2026-03-02-1250-parser-explode.md")
      const middlewareResult = middleware.validateWrite(canonicalPath, "---\ntype: one-shot\nstatus: drafting\n---\nbody")
      expect(middlewareResult.ok).toBe(false)
      expect(middlewareResult.reason).toContain("parser-exploded")

      const root = path.join(agentRoot, "tasks")
      scanner.ensureTaskLayout(root)
      fs.writeFileSync(canonicalPath, "---\ntype: one-shot\nstatus: drafting\n---\nbody", "utf-8")
      const index = scanner.scanTasks(root)
      expect(index.issues.some((issue) => issue.description.includes("parser-exploded"))).toBe(true)
    } finally {
      vi.doUnmock("../../../repertoire/tasks/parser")
      vi.resetModules()
    }
  })

  it("archives sibling artifact directories when tasks complete", async () => {
    const tasks = await import("../../../repertoire/tasks")
    const module = tasks.getTaskModule()

    const created = module.createTask({
      title: "Archive Artifact Task",
      type: "ongoing",
      category: "ops",
      body: "## scope\narchive artifacts",
    })
    const stem = path.basename(created, ".md")

    const artifactDir = created.replace(/\.md$/i, "")
    fs.mkdirSync(artifactDir, { recursive: true })
    fs.writeFileSync(path.join(artifactDir, "result.txt"), "artifact", "utf-8")

    expect(module.updateStatus(stem, "processing").ok).toBe(true)
    expect(module.updateStatus(stem, "validating").ok).toBe(true)
    const done = module.updateStatus(stem, "done")
    expect(done.ok).toBe(true)
    expect(done.archived && done.archived.length).toBeGreaterThan(0)

    const archivedTask = done.archived?.[0] ?? ""
    const archivedArtifactDir = path.join(path.dirname(archivedTask), path.basename(artifactDir))
    expect(fs.existsSync(path.join(archivedArtifactDir, "result.txt"))).toBe(true)
  })

  it("captures archive failures without throwing", async () => {
    const lifecycle = await import("../../../repertoire/tasks/lifecycle")
    const parser = await import("../../../repertoire/tasks/parser")
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.ensureTaskLayout()

    const taskPath = path.join(agentRoot, "tasks", "one-shots", "2026-03-02-1300-failing-archive.md")
    const task = parser.parseTaskFile(
      parser.renderTaskFile(
        {
          type: "one-shot",
          category: "ops",
          title: "Failing Archive",
          status: "done",
          created: "2026-03-02",
          updated: "2026-03-02",
          parent_task: null,
          depends_on: [],
          child_tasks: [],
          artifacts: [],
        },
        "body",
      ),
      taskPath,
    )

    const result = lifecycle.archiveCompletedTasks({
      root: path.join(agentRoot, "tasks"),
      tasks: [task],
      issues: [],
      fingerprint: "manual",
    })
    expect(result.archived).toHaveLength(0)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain("ENOENT")
  })

  it("stringifies non-Error archive failures", async () => {
    vi.resetModules()
    vi.doMock("fs", () => ({
      mkdirSync: vi.fn(),
      renameSync: () => {
        throw "archive-exploded"
      },
      existsSync: vi.fn(() => false),
    }))
    try {
      const lifecycle = await import("../../../repertoire/tasks/lifecycle")
      const result = lifecycle.archiveCompletedTasks({
        root: path.join(agentRoot, "tasks"),
        tasks: [
          {
            path: path.join(agentRoot, "tasks", "one-shots", "2026-03-02-1400-archive-fail.md"),
            name: "2026-03-02-1400-archive-fail.md",
            stem: "2026-03-02-1400-archive-fail",
            type: "one-shot",
            collection: "one-shots",
            category: "ops",
            title: "Archive Fail",
            status: "done",
            created: "2026-03-02",
            updated: "2026-03-02",
            frontmatter: {},
            body: "body",
            hasWorkDir: false,
            workDirFiles: [],
            derivedChildren: [],
          },
        ],
        issues: [],
        fingerprint: "manual",
      })
      expect(result.archived).toHaveLength(0)
      expect(result.failures[0]).toContain("archive-exploded")
    } finally {
      vi.doUnmock("fs")
      vi.resetModules()
    }
  })

  it("surfaces middleware write validation failures from createTask", async () => {
    vi.resetModules()
    const validateWrite = vi
      .fn()
      .mockReturnValueOnce({ ok: false, reason: "forced-write-failure" })
      .mockReturnValueOnce({ ok: false })

    vi.doMock("../../../repertoire/tasks/middleware", async () => {
      const actual = await vi.importActual<typeof import("../../../repertoire/tasks/middleware")>("../../../repertoire/tasks/middleware")
      return {
        ...actual,
        validateWrite,
      }
    })

    try {
      const tasks = await import("../../../repertoire/tasks")
      const module = tasks.getTaskModule()

      expect(() =>
        module.createTask({
          title: "Write Fail 1",
          type: "one-shot",
          category: "ops",
          body: "body",
        }),
      ).toThrow("forced-write-failure")

      expect(() =>
        module.createTask({
          title: "Write Fail 2",
          type: "one-shot",
          category: "ops",
          body: "body",
        }),
      ).toThrow("task write validation failed")
    } finally {
      vi.doUnmock("../../../repertoire/tasks/middleware")
      vi.resetModules()
    }
  })
})

describe("task transition helpers", () => {
  it("normalizes task type and status helpers", async () => {
    const transitions = await import("../../../repertoire/tasks/transitions")
    expect(transitions.normalizeTaskType("ONGOING")).toBe("ongoing")
    expect(transitions.normalizeTaskType("unknown")).toBeNull()
    expect(transitions.normalizeTaskType(undefined)).toBeNull()
    expect(transitions.normalizeTaskStatus("PROCESSING")).toBe("processing")
    expect(transitions.normalizeTaskStatus("invalid")).toBeNull()
    expect(transitions.normalizeTaskStatus(null)).toBeNull()
    expect(transitions.isCanonicalTaskFilename("2026-03-01-1015-good-name.md")).toBe(true)
    expect(transitions.isCanonicalTaskFilename("bad.md")).toBe(false)
    expect(transitions.renderTaskTransitionLines().length).toBeGreaterThan(0)
  })

  it("does not include habit or habits in canonical task types and collections", async () => {
    const transitions = await import("../../../repertoire/tasks/transitions")
    expect(transitions.TASK_CANONICAL_COLLECTIONS).not.toContain("habits")
    expect(transitions.TASK_CANONICAL_TYPES).not.toContain("habit")
    expect(transitions.normalizeTaskType("habit")).toBeNull()
    expect(transitions.TASK_TYPE_TO_COLLECTION).not.toHaveProperty("habit")
    expect(transitions.TASK_REQUIRED_TEMPLATE_FIELDS).not.toHaveProperty("habit")
  })

  it("falls back to an empty board status list for missing status keys", async () => {
    const board = await import("../../../repertoire/tasks/board")
    const result = board.boardStatus(
      {
        compact: "",
        full: "",
        byStatus: {} as any,
        actionRequired: [],
        unresolvedDependencies: [],
        activeSessions: [],
      },
      "drafting",
    )
    expect(result).toEqual([])
  })
})
