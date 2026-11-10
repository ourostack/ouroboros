import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const roots = vi.hoisted(() => ({ agent: "", repo: "", agentThrows: false }))
vi.mock("../../heart/identity", async (original) => ({
  ...await original<typeof import("../../heart/identity")>(),
  getAgentRoot: () => {
    if (roots.agentThrows) throw new Error("no agent")
    return roots.agent
  },
  getRepoRoot: () => roots.repo,
}))

const events = vi.hoisted(() => [] as Array<{ event: string; meta?: Record<string, unknown> }>)
vi.mock("../../nerves/runtime", async (original) => {
  const actual = await original<typeof import("../../nerves/runtime")>()
  return {
    ...actual,
    emitNervesEvent: (event: Parameters<typeof actual.emitNervesEvent>[0]) => {
      events.push(event)
      actual.emitNervesEvent(event)
    },
  }
})

import { skillWhenLines, whenLine } from "../../repertoire/skill-summaries"

describe("whenLine", () => {
  it("takes the first 'i use this when' sentence", () => {
    expect(whenLine("# fleet skill\n\ni use this when ari asks what is going on across his machines. more after.\n\n## the picture\nuse this when other")).toBe(
      "i use this when ari asks what is going on across his machines.",
    )
  })

  it("accepts 'use this when', 'we use it when' and 'use when'", () => {
    expect(whenLine("Use this when a deploy fails")).toBe("Use this when a deploy fails")
    expect(whenLine("we use it when mail breaks!")).toBe("we use it when mail breaks!")
    expect(whenLine("use when stuck? then read on")).toBe("use when stuck?")
  })

  it("prefers a frontmatter description, quoted or not", () => {
    expect(whenLine("---\nname: word-docs\ndescription: \"Convert drafts to Word. Uses pandoc.\"\n---\ni use this when x")).toBe("Convert drafts to Word.")
    expect(whenLine("---\ndescription: plain one\n---\nbody")).toBe("plain one")
  })

  it("reads the body when the frontmatter has no description", () => {
    expect(whenLine("---\nname: x\n---\ni use this when y")).toBe("i use this when y")
  })

  it("treats an unclosed frontmatter as body", () => {
    expect(whenLine("---\ni use this when z")).toBe("i use this when z")
  })

  it("is null without a when line", () => {
    expect(whenLine("# code review\n\nreview code carefully")).toBeNull()
    expect(whenLine("")).toBeNull()
  })

  it("clips a long line", () => {
    const got = whenLine(`i use this when ${"a".repeat(400)}`)!
    expect(got.length).toBe(220)
    expect(got.endsWith("…")).toBe(true)
  })
})

describe("skillWhenLines", () => {
  beforeEach(() => {
    roots.agent = fs.mkdtempSync(path.join(os.tmpdir(), "skill-when-agent-"))
    roots.repo = fs.mkdtempSync(path.join(os.tmpdir(), "skill-when-repo-"))
    roots.agentThrows = false
    fs.mkdirSync(path.join(roots.agent, "skills", "protocols"), { recursive: true })
    fs.mkdirSync(path.join(roots.repo, "skills"), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(roots.agent, { recursive: true, force: true })
    fs.rmSync(roots.repo, { recursive: true, force: true })
  })

  it("reads the agent's skills, then protocol mirrors, then the harness's, and leaves out skills without a line", () => {
    fs.writeFileSync(path.join(roots.agent, "skills", "fleet.md"), "i use this when ari asks what is going on.")
    fs.writeFileSync(path.join(roots.agent, "skills", "protocols", "proto.md"), "use this when a protocol applies")
    fs.writeFileSync(path.join(roots.repo, "skills", "fleet.md"), "use this when shadowed")
    fs.writeFileSync(path.join(roots.repo, "skills", "harness.md"), "use when the harness helps")
    fs.writeFileSync(path.join(roots.agent, "skills", "plain.md"), "# nothing")
    fs.mkdirSync(path.join(roots.agent, "skills", "dir.md"))
    const got = skillWhenLines(["fleet", "proto", "harness", "plain", "dir", "missing"])
    expect(events.at(-1)).toMatchObject({ event: "repertoire.skill_when_lines", meta: { skills: 6, described: 3 } })
    expect([...got.entries()]).toEqual([
      ["fleet", "i use this when ari asks what is going on."],
      ["proto", "use this when a protocol applies"],
      ["harness", "use when the harness helps"],
    ])
  })

  it("falls back to the harness skills when there is no agent root", () => {
    roots.agentThrows = true
    fs.writeFileSync(path.join(roots.repo, "skills", "harness.md"), "use when the harness helps")
    expect([...skillWhenLines(["harness"]).keys()]).toEqual(["harness"])
  })
})
