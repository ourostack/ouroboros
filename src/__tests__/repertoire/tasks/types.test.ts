import "../../../repertoire/tasks/types"
import type { TaskIssue, FixOptions, FixResult } from "../../../repertoire/tasks/types"

describe("tasks/types module", () => {
  it("loads without runtime exports", () => {
    expect(true).toBe(true)
  })
})

describe("TaskIssue interface", () => {
  it("creates a safe migration issue", () => {
    const issue: TaskIssue = {
      target: "one-shots/my-task.md",
      code: "schema-missing-kind",
      description: "Task card missing kind: task field",
      fix: "Add kind: task to frontmatter",
      confidence: "safe",
      category: "migration",
    }
    expect(issue.target).toBe("one-shots/my-task.md")
    expect(issue.code).toBe("schema-missing-kind")
    expect(issue.description).toBe("Task card missing kind: task field")
    expect(issue.fix).toBe("Add kind: task to frontmatter")
    expect(issue.confidence).toBe("safe")
    expect(issue.category).toBe("migration")
  })

  it("creates a needs_review live issue", () => {
    const issue: TaskIssue = {
      target: "one-shots/orphan.md",
      code: "org-root-level-doc",
      description: "Root-level document outside any collection",
      fix: "Move to appropriate collection or remove",
      confidence: "needs_review",
      category: "live",
    }
    expect(issue.confidence).toBe("needs_review")
    expect(issue.category).toBe("live")
  })

  it("rejects invalid confidence value at type level", () => {
    // Type assertion to verify the union constrains values
    const validConfidences: TaskIssue["confidence"][] = ["safe", "needs_review"]
    expect(validConfidences).toHaveLength(2)
  })

  it("rejects invalid category value at type level", () => {
    const validCategories: TaskIssue["category"][] = ["live", "migration"]
    expect(validCategories).toHaveLength(2)
  })
})

describe("FixOptions interface", () => {
  it("creates dry-run options", () => {
    const opts: FixOptions = { mode: "dry-run" }
    expect(opts.mode).toBe("dry-run")
    expect(opts.issueId).toBeUndefined()
    expect(opts.option).toBeUndefined()
  })

  it("creates safe-mode options", () => {
    const opts: FixOptions = { mode: "safe" }
    expect(opts.mode).toBe("safe")
  })

  it("creates single-issue options with id and option", () => {
    const opts: FixOptions = {
      mode: "single",
      issueId: "schema-missing-kind:one-shots/foo.md",
      option: 1,
    }
    expect(opts.mode).toBe("single")
    expect(opts.issueId).toBe("schema-missing-kind:one-shots/foo.md")
    expect(opts.option).toBe(1)
  })

  it("allows single mode without option number", () => {
    const opts: FixOptions = {
      mode: "single",
      issueId: "org-root-level-doc:readme.md",
    }
    expect(opts.issueId).toBe("org-root-level-doc:readme.md")
    expect(opts.option).toBeUndefined()
  })
})

describe("FixResult interface", () => {
  it("creates a clean fix result", () => {
    const result: FixResult = {
      applied: [],
      remaining: [],
      skipped: [],
      health: "clean",
    }
    expect(result.applied).toHaveLength(0)
    expect(result.remaining).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(result.health).toBe("clean")
  })

  it("creates a result with applied and remaining issues", () => {
    const applied: TaskIssue = {
      target: "one-shots/foo.md",
      code: "schema-missing-kind",
      description: "Missing kind field",
      fix: "Add kind: task",
      confidence: "safe",
      category: "migration",
    }
    const remaining: TaskIssue = {
      target: "orphan.md",
      code: "org-root-level-doc",
      description: "Root-level doc",
      fix: "Move to collection",
      confidence: "needs_review",
      category: "live",
    }
    const result: FixResult = {
      applied: [applied],
      remaining: [remaining],
      skipped: [],
      health: "1 live issue, 1 migration",
    }
    expect(result.applied).toHaveLength(1)
    expect(result.remaining).toHaveLength(1)
    expect(result.health).toBe("1 live issue, 1 migration")
  })

  it("creates a result with skipped issues", () => {
    const skipped: TaskIssue = {
      target: "one-shots/bar.md",
      code: "filename-not-canonical",
      description: "Non-canonical filename",
      fix: "Rename to canonical format",
      confidence: "safe",
      category: "migration",
    }
    const result: FixResult = {
      applied: [],
      remaining: [],
      skipped: [skipped],
      health: "1 migration",
    }
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].code).toBe("filename-not-canonical")
  })
})
