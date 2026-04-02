import { describe, expect, it } from "vitest"
import { buildToolResultSummary } from "../../repertoire/tools"

describe("Unit 2.6 - tool result formatting for remote channels", () => {
  it("edit_file result includes compact diff summary", () => {
    // edit_file handler returns a contextual diff; we simulate a result with changed lines
    const result = "  10 | const x = 1\n→ 11 | const y = 2\n→ 12 | const z = 3\n  13 | return x"
    const summary = buildToolResultSummary("edit_file", { path: "src/foo.ts", old_string: "old", new_string: "new\nlines\nadded" }, result, true)
    expect(summary).toContain("+")
    expect(summary).toContain("src/foo.ts")
  })

  it("edit_file failure uses arg summary", () => {
    const summary = buildToolResultSummary("edit_file", { path: "src/foo.ts", old_string: "missing", new_string: "new" }, "error: old_string not found in src/foo.ts", false)
    expect(summary).toContain("src/foo.ts")
  })

  it("shell result includes command and exit code", () => {
    const summary = buildToolResultSummary("shell", { command: "npm test" }, "all tests passed", true)
    expect(summary).toContain("$ npm test")
    expect(summary).toContain("exit 0")
  })

  it("shell failure includes command and non-zero exit", () => {
    const summary = buildToolResultSummary("shell", { command: "npm test" }, "error: Command failed", false)
    expect(summary).toContain("$ npm test")
    expect(summary).toContain("exit 1")
  })

  it("coding_spawn result includes task ref and status", () => {
    const summary = buildToolResultSummary("coding_spawn", { runner: "claude", taskRef: "fix-bug-123", workdir: "/repo", prompt: "fix the bug" }, "session abc123 spawned", true)
    expect(summary).toContain("fix-bug-123")
    expect(summary).toContain("spawned")
  })

  it("coding_spawn failure includes task ref and failed status", () => {
    const summary = buildToolResultSummary("coding_spawn", { runner: "claude", taskRef: "fix-bug-123", workdir: "/repo", prompt: "fix" }, "error: spawn failed", false)
    expect(summary).toContain("fix-bug-123")
    expect(summary).toContain("failed")
  })

  it("edit_file handles missing path arg gracefully", () => {
    const summary = buildToolResultSummary("edit_file", { old_string: "a", new_string: "b" }, "ok", true)
    expect(summary).toContain("unknown")
  })

  it("shell handles missing command arg gracefully", () => {
    const summary = buildToolResultSummary("shell", {}, "ok", true)
    expect(summary).toContain("$ ?")
  })

  it("coding_spawn handles missing taskRef gracefully", () => {
    const summary = buildToolResultSummary("coding_spawn", { runner: "claude", workdir: "/repo", prompt: "do it" }, "spawned", true)
    expect(summary).toContain("unknown")
  })

  it("unrecognized tool falls back to arg summary", () => {
    const summary = buildToolResultSummary("recall", { query: "something" }, "some result", true)
    expect(summary).toContain("query=something")
  })

  it("read_file result shows path", () => {
    const summary = buildToolResultSummary("read_file", { path: "/src/index.ts" }, "contents...", true)
    expect(summary).toContain("path=/src/index.ts")
  })

  it("read_file handles missing path gracefully", () => {
    const summary = buildToolResultSummary("read_file", {}, "contents...", true)
    expect(summary).toContain("path=unknown")
  })

  it("write_file result shows path", () => {
    const summary = buildToolResultSummary("write_file", { path: "/src/out.ts" }, "ok", true)
    expect(summary).toContain("path=/src/out.ts")
  })

  it("glob result shows pattern and cwd", () => {
    const summary = buildToolResultSummary("glob", { pattern: "src/**/*.ts", cwd: "/repo" }, "found files", true)
    expect(summary).toContain("pattern=src/**/*.ts")
    expect(summary).toContain("cwd=/repo")
  })

  it("glob result shows pattern without cwd when absent", () => {
    const summary = buildToolResultSummary("glob", { pattern: "*.json" }, "found files", true)
    expect(summary).toContain("pattern=*.json")
    expect(summary).not.toContain("cwd=")
  })

  it("grep result shows pattern and path", () => {
    const summary = buildToolResultSummary("grep", { pattern: "TODO", path: "/src" }, "matches", true)
    expect(summary).toContain("pattern=TODO")
    expect(summary).toContain("path=/src")
  })

  it("grep result shows pattern without path when absent", () => {
    const summary = buildToolResultSummary("grep", { pattern: "FIXME" }, "matches", true)
    expect(summary).toContain("pattern=FIXME")
    expect(summary).not.toContain("path=")
  })
})
