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

describe("board — terminal task hiding", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-terminal-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("excludes done and cancelled tasks from active counts in compact view", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Active task
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-active-task.md"),
      validTaskCard({ status: "processing", title: "Active" }),
    )
    // Done task
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0801-done-task.md"),
      validTaskCard({ status: "done", title: "Done Task" }),
    )
    // Cancelled task
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0802-cancelled-task.md"),
      validTaskCard({ status: "cancelled", title: "Cancelled Task" }),
    )

    const index = scanner.scanTasks(root)
    expect(index.tasks).toHaveLength(3)

    const result = board.buildTaskBoard(index)

    // Active counts line (first line) should NOT contain done or cancelled
    const firstLine = result.compact.split("\n")[0]
    expect(firstLine).toContain("[Tasks]")
    expect(firstLine).toContain("processing:1")
    expect(firstLine).not.toContain("done:")
    expect(firstLine).not.toContain("cancelled:")

    // Terminal counts should appear on a separate terminal line
    expect(result.compact).toContain("terminal:")
    expect(result.compact).toContain("done:1")
    expect(result.compact).toContain("cancelled:1")
  })

  it("hides done and cancelled from active status sections in full board view", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-active-task.md"),
      validTaskCard({ status: "processing", title: "Active" }),
    )
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0801-done-task.md"),
      validTaskCard({ status: "done", title: "Done Task" }),
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    // Full board should have done section
    expect(result.full).toContain("## done")
    // Processing should appear in active area
    expect(result.full).toContain("## processing")
  })

  it("omits empty terminal sections from full board view", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-active-task.md"),
      validTaskCard({ status: "processing", title: "Active" }),
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    // Empty done/cancelled should not appear
    expect(result.full).not.toContain("## done")
    expect(result.full).not.toContain("## cancelled")
  })
})

describe("board — health line", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-health-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("shows 'health: clean' when no issues exist", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-clean-task.md"),
      validTaskCard(),
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    expect(result.compact).toContain("health: clean")
  })

  it("shows live issue count when live issues exist", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // A task with invalid schema will produce a live issue
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-bad-task.md"),
      "---\nkind: task\ntype: one-shot\ntitle: Bad\n---\n\nbody\n",
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    expect(result.compact).toContain("1 live")
  })

  it("shows migration issue count when migration issues exist", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Legacy task without kind: task produces a migration issue
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      "---\ntype: one-shot\ncategory: infrastructure\ntitle: Legacy\nstatus: drafting\ncreated: 2026-03-30\nupdated: 2026-03-30\nparent_task: null\ndepends_on: []\nartifacts: []\n---\n\nbody\n",
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    expect(result.compact).toContain("1 migration")
  })

  it("shows both live and migration counts when mixed issues exist", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Legacy task (migration issue)
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      "---\ntype: one-shot\ncategory: infrastructure\ntitle: Legacy\nstatus: drafting\ncreated: 2026-03-30\nupdated: 2026-03-30\nparent_task: null\ndepends_on: []\nartifacts: []\n---\n\nbody\n",
    )
    // Invalid schema task (live issue)
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0801-bad-task.md"),
      "---\nkind: task\ntype: one-shot\ntitle: Bad\n---\n\nbody\n",
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    expect(result.compact).toContain("1 live")
    expect(result.compact).toContain("1 migration")
  })
})

describe("board — issues field on BoardResult", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-issues-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("populates BoardResult.issues from TaskIndex.issues", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Legacy task produces a migration issue
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      "---\ntype: one-shot\ncategory: infrastructure\ntitle: Legacy\nstatus: drafting\ncreated: 2026-03-30\nupdated: 2026-03-30\nparent_task: null\ndepends_on: []\nartifacts: []\n---\n\nbody\n",
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    expect(result.issues).toBeDefined()
    expect(result.issues).toHaveLength(index.issues.length)
    expect(result.issues[0].code).toBe("schema-missing-kind")
  })

  it("returns empty issues array when no issues exist", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-clean-task.md"),
      validTaskCard(),
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    expect(result.issues).toEqual([])
  })
})

describe("board — actionRequired from typed issues", () => {
  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-actions-"))
  })

  afterEach(async () => {
    const scanner = await import("../../../repertoire/tasks/scanner")
    scanner.clearTaskScanCache()
    removeDirSafe(agentRoot)
    agentRoot = ""
  })

  it("derives actionRequired from issues as formatted strings", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    // Legacy task produces schema-missing-kind issue
    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      "---\ntype: one-shot\ncategory: infrastructure\ntitle: Legacy\nstatus: drafting\ncreated: 2026-03-30\nupdated: 2026-03-30\nparent_task: null\ndepends_on: []\nartifacts: []\n---\n\nbody\n",
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    // actionRequired should contain formatted issue strings
    const kindAction = result.actionRequired.find((a) => a.includes("schema-missing-kind"))
    expect(kindAction).toBeDefined()
    expect(kindAction).toContain("schema-missing-kind")
    expect(kindAction).toContain("legacy-task")
  })

  it("includes blocked tasks in actionRequired alongside issues", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-blocked-task.md"),
      validTaskCard({ status: "blocked", title: "Blocked" }),
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)

    const blockedAction = result.actionRequired.find((a) => a.includes("blocked tasks"))
    expect(blockedAction).toBeDefined()
  })

  it("boardAction() returns the same formatted strings", async () => {
    const { emitNervesEvent } = await import("../../../nerves/runtime")
    ;(emitNervesEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {})
    const scanner = await import("../../../repertoire/tasks/scanner")
    const board = await import("../../../repertoire/tasks/board")
    const root = makeTaskRoot()
    scanner.ensureTaskLayout(root)

    writeFile(
      path.join(root, "one-shots", "2026-03-30-0800-legacy-task.md"),
      "---\ntype: one-shot\ncategory: infrastructure\ntitle: Legacy\nstatus: drafting\ncreated: 2026-03-30\nupdated: 2026-03-30\nparent_task: null\ndepends_on: []\nartifacts: []\n---\n\nbody\n",
    )

    const index = scanner.scanTasks(root)
    const result = board.buildTaskBoard(index)
    const actions = board.boardAction(result)

    expect(actions).toEqual(result.actionRequired)
  })
})
