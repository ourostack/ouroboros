import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe("migrateHabitsFromTaskSystem", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("migrates old timestamped habit file to habits/ with slug name", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing habit migration",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-bundle")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-heartbeat.md"), [
      "---",
      "type: habit",
      "category: runtime",
      "title: Heartbeat check-in",
      "status: processing",
      "created: 2026-03-08T12:00:00.000Z",
      "updated: 2026-03-08T12:00:00.000Z",
      "requester: system",
      "validator: null",
      "cadence: \"30m\"",
      "scheduledAt: null",
      "lastRun: null",
      "---",
      "",
      "Run a lightweight heartbeat cycle.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    const newPath = path.join(bundleRoot, "habits", "heartbeat.md")
    expect(fs.existsSync(newPath)).toBe(true)

    const content = fs.readFileSync(newPath, "utf-8")
    expect(content).toContain("title: Heartbeat check-in")
    expect(content).toContain("cadence: 30m")
    expect(content).toContain("status: active") // processing -> active
    expect(content).toContain("lastRun: null")
    expect(content).toContain("created: 2026-03-08T12:00:00.000Z")
    expect(content).toContain("Run a lightweight heartbeat cycle.")

    // Task-only fields should be stripped
    expect(content).not.toContain("type:")
    expect(content).not.toContain("category:")
    expect(content).not.toContain("requester:")
    expect(content).not.toContain("validator:")
    expect(content).not.toContain("scheduledAt:")
    expect(content).not.toContain("updated:")
  })

  it("strips timestamp prefix from filename", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing timestamp strip",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-timestamp")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-0930-daily-reflection.md"), [
      "---",
      "title: Daily Reflection",
      "cadence: \"24h\"",
      "status: processing",
      "lastRun: null",
      "created: 2026-03-08T09:30:00.000Z",
      "---",
      "",
      "Reflect on the day.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // Should be just daily-reflection.md, no timestamp
    expect(fs.existsSync(path.join(bundleRoot, "habits", "daily-reflection.md"))).toBe(true)
    expect(fs.existsSync(path.join(bundleRoot, "habits", "2026-03-08-0930-daily-reflection.md"))).toBe(false)
  })

  it("maps status: processing -> active, paused -> paused", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing status mapping",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-status")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-active-habit.md"), [
      "---",
      "title: Active Habit",
      "status: processing",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"), "utf-8")

    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-paused-habit.md"), [
      "---",
      "title: Paused Habit",
      "status: paused",
      "cadence: \"2h\"",
      "lastRun: null",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    const activeContent = fs.readFileSync(path.join(bundleRoot, "habits", "active-habit.md"), "utf-8")
    expect(activeContent).toContain("status: active")

    const pausedContent = fs.readFileSync(path.join(bundleRoot, "habits", "paused-habit.md"), "utf-8")
    expect(pausedContent).toContain("status: paused")
  })

  it("skips done habits during migration", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing skip done habits",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-skip-done")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-done-habit.md"), [
      "---",
      "title: Done Habit",
      "status: done",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // Done habit should NOT be migrated
    expect(fs.existsSync(path.join(bundleRoot, "habits", "done-habit.md"))).toBe(false)
  })

  it("strips task-only fields from migrated frontmatter", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing field stripping",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-strip")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-full-task.md"), [
      "---",
      "type: habit",
      "category: runtime",
      "title: Full Task Habit",
      "status: processing",
      "created: 2026-03-08T12:00:00.000Z",
      "updated: 2026-03-08T12:00:00.000Z",
      "requester: system",
      "validator: null",
      "cadence: \"30m\"",
      "scheduledAt: null",
      "lastRun: 2026-03-08T13:00:00.000Z",
      "depends_on: []",
      "parent_task: null",
      "artifacts: []",
      "---",
      "",
      "Full task body preserved.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    const content = fs.readFileSync(path.join(bundleRoot, "habits", "full-task.md"), "utf-8")
    // Preserved fields
    expect(content).toContain("title: Full Task Habit")
    expect(content).toContain("cadence: 30m")
    expect(content).toContain("status: active")
    expect(content).toContain("lastRun: 2026-03-08T13:00:00.000Z")
    expect(content).toContain("created: 2026-03-08T12:00:00.000Z")
    expect(content).toContain("Full task body preserved.")

    // Stripped task-only fields
    expect(content).not.toContain("type:")
    expect(content).not.toContain("category:")
    expect(content).not.toContain("requester:")
    expect(content).not.toContain("validator:")
    expect(content).not.toContain("scheduledAt:")
    expect(content).not.toContain("updated:")
    expect(content).not.toContain("depends_on:")
    expect(content).not.toContain("parent_task:")
    expect(content).not.toContain("artifacts:")
  })

  it("preserves body text during migration", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing body preservation",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-body")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    const body = "This is the habit body.\nIt has multiple lines.\n\nAnd paragraphs."
    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-multi-line.md"), [
      "---",
      "title: Multi Line Body",
      "status: processing",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      body,
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    const content = fs.readFileSync(path.join(bundleRoot, "habits", "multi-line.md"), "utf-8")
    expect(content).toContain("This is the habit body.")
    expect(content).toContain("It has multiple lines.")
    expect(content).toContain("And paragraphs.")
  })

  it("migrates multiple habit files", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing multiple file migration",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-multi")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    for (const name of ["heartbeat", "journal", "check-inbox"]) {
      fs.writeFileSync(path.join(oldHabitsDir, `2026-03-08-1200-${name}.md`), [
        "---",
        `title: ${name}`,
        "status: processing",
        "cadence: \"30m\"",
        "lastRun: null",
        "---",
        "",
        `Body for ${name}.`,
        "",
      ].join("\n"), "utf-8")
    }

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    for (const name of ["heartbeat", "journal", "check-inbox"]) {
      expect(fs.existsSync(path.join(bundleRoot, "habits", `${name}.md`))).toBe(true)
    }
  })

  it("creates habits/ dir if missing", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing dir creation",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-mkdir")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-heartbeat.md"), [
      "---",
      "title: Heartbeat",
      "status: processing",
      "cadence: \"30m\"",
      "lastRun: null",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"), "utf-8")

    // habits/ should not exist yet
    expect(fs.existsSync(path.join(bundleRoot, "habits"))).toBe(false)

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    expect(fs.existsSync(path.join(bundleRoot, "habits"))).toBe(true)
    expect(fs.existsSync(path.join(bundleRoot, "habits", "heartbeat.md"))).toBe(true)
  })

  it("skips already-migrated files (does not overwrite)", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing skip already migrated",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-skip-existing")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })
    const newHabitsDir = path.join(bundleRoot, "habits")
    fs.mkdirSync(newHabitsDir, { recursive: true })

    // Write old file
    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-heartbeat.md"), [
      "---",
      "title: Old Heartbeat",
      "status: processing",
      "cadence: \"30m\"",
      "lastRun: null",
      "---",
      "",
      "Old body.",
      "",
    ].join("\n"), "utf-8")

    // Write new file that already exists
    fs.writeFileSync(path.join(newHabitsDir, "heartbeat.md"), [
      "---",
      "title: Updated Heartbeat",
      "cadence: 15m",
      "status: active",
      "lastRun: 2026-03-08T14:00:00.000Z",
      "created: 2026-03-08T12:00:00.000Z",
      "---",
      "",
      "Updated body.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // Should keep the existing new file, not overwrite
    const content = fs.readFileSync(path.join(newHabitsDir, "heartbeat.md"), "utf-8")
    expect(content).toContain("title: Updated Heartbeat")
    expect(content).toContain("Updated body.")
  })

  it("is a no-op when tasks/habits/ does not exist", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing no-op on missing dir",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-no-dir")
    cleanup.push(bundleRoot)

    // No tasks/habits/ dir
    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // Should not create habits/ dir
    expect(fs.existsSync(path.join(bundleRoot, "habits"))).toBe(false)
  })

  it("skips README.md files during migration", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing README skip",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-readme")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "README.md"), "# Habits\n\nRecurring tasks.\n", "utf-8")
    fs.writeFileSync(path.join(oldHabitsDir, "2026-03-08-1200-heartbeat.md"), [
      "---",
      "title: Heartbeat",
      "status: processing",
      "cadence: \"30m\"",
      "lastRun: null",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // heartbeat should be migrated
    expect(fs.existsSync(path.join(bundleRoot, "habits", "heartbeat.md"))).toBe(true)
    // README should NOT be migrated to habits/
    const habitFiles = fs.readdirSync(path.join(bundleRoot, "habits"))
    expect(habitFiles).not.toContain("README.md")
  })

  it("maps unknown task status to active", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing unknown status mapping",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-unknown-status")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "weird-status.md"), [
      "---",
      "title: Weird Status",
      "status: in_review",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      "Unknown status body.",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    const content = fs.readFileSync(path.join(bundleRoot, "habits", "weird-status.md"), "utf-8")
    expect(content).toContain("status: active")
  })

  it("handles unreadable individual file gracefully", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing unreadable file",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-unreadable")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    // Create a file then make it unreadable (symlink to nowhere)
    const brokenLink = path.join(oldHabitsDir, "broken.md")
    fs.symlinkSync("/nonexistent/path/to/nowhere", brokenLink)

    // Also create a valid file to ensure migration continues
    fs.writeFileSync(path.join(oldHabitsDir, "valid.md"), [
      "---",
      "title: Valid Habit",
      "status: processing",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      "Valid body.",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // Valid file should still be migrated
    expect(fs.existsSync(path.join(bundleRoot, "habits", "valid.md"))).toBe(true)
  })

  it("preserves extra non-task frontmatter fields", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing extra field preservation",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-extra-fields")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    fs.writeFileSync(path.join(oldHabitsDir, "custom.md"), [
      "---",
      "title: Custom Habit",
      "status: processing",
      "cadence: \"1h\"",
      "lastRun: null",
      "custom_field: hello",
      "priority: high",
      "---",
      "",
      "Custom body.",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    const content = fs.readFileSync(path.join(bundleRoot, "habits", "custom.md"), "utf-8")
    expect(content).toContain("custom_field: hello")
    expect(content).toContain("priority: high")
  })

  it("is no-op when tasks/habits/ has only non-md files", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing empty md files",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-no-md")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })
    fs.writeFileSync(path.join(oldHabitsDir, "README.md"), "# Habits", "utf-8")
    fs.writeFileSync(path.join(oldHabitsDir, ".gitkeep"), "", "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    expect(fs.existsSync(path.join(bundleRoot, "habits"))).toBe(false)
  })

  it("skips files without frontmatter marker", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing missing frontmatter",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-no-frontmatter")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })
    fs.writeFileSync(path.join(oldHabitsDir, "no-front.md"), "Just plain text, no frontmatter.", "utf-8")
    fs.writeFileSync(path.join(oldHabitsDir, "valid.md"), [
      "---",
      "title: Valid",
      "status: processing",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      "Body.",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    expect(fs.existsSync(path.join(bundleRoot, "habits", "valid.md"))).toBe(true)
    expect(fs.existsSync(path.join(bundleRoot, "habits", "no-front.md"))).toBe(false)
  })

  it("skips files with unterminated frontmatter", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing unterminated frontmatter",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-unterminated")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })
    fs.writeFileSync(path.join(oldHabitsDir, "broken.md"), "---\ntitle: Broken\nstatus: processing\n", "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    expect(fs.existsSync(path.join(bundleRoot, "habits", "broken.md"))).toBe(false)
  })

  it("handles habit file without status field (defaults to active)", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing missing status field",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-no-status")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })
    fs.writeFileSync(path.join(oldHabitsDir, "no-status.md"), [
      "---",
      "title: No Status",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      "Body.",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    const content = fs.readFileSync(path.join(bundleRoot, "habits", "no-status.md"), "utf-8")
    expect(content).toContain("status: active")
  })

  it("handles habit file without title or cadence fields", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing missing title/cadence",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-no-title-cadence")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })
    fs.writeFileSync(path.join(oldHabitsDir, "minimal.md"), [
      "---",
      "status: processing",
      "lastRun: null",
      "---",
      "",
      "Minimal body.",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // Should still migrate, just without title/cadence in frontmatter
    expect(fs.existsSync(path.join(bundleRoot, "habits", "minimal.md"))).toBe(true)
  })

  it("handles files without timestamp prefix in name gracefully", async () => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.migration_test_start",
      message: "testing non-timestamped file migration",
      meta: {},
    })

    const bundleRoot = makeTempDir("migrate-no-timestamp")
    cleanup.push(bundleRoot)

    const oldHabitsDir = path.join(bundleRoot, "tasks", "habits")
    fs.mkdirSync(oldHabitsDir, { recursive: true })

    // File without timestamp prefix
    fs.writeFileSync(path.join(oldHabitsDir, "simple-habit.md"), [
      "---",
      "title: Simple Habit",
      "status: processing",
      "cadence: \"1h\"",
      "lastRun: null",
      "---",
      "",
      "Simple body.",
      "",
    ].join("\n"), "utf-8")

    const { migrateHabitsFromTaskSystem } = await import("../../../heart/daemon/habit-migration")
    migrateHabitsFromTaskSystem(bundleRoot)

    // Should be migrated as-is (filename already a slug)
    expect(fs.existsSync(path.join(bundleRoot, "habits", "simple-habit.md"))).toBe(true)
  })
})
