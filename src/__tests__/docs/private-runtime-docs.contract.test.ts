import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...parts), "utf-8")
}

function listMarkdownFiles(root: string): string[] {
  const absoluteRoot = path.resolve(process.cwd(), root)
  const entries = fs.readdirSync(absoluteRoot, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const relativePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (relativePath === path.join("docs", "doing")) {
        continue
      }
      files.push(...listMarkdownFiles(relativePath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relativePath)
    }
  }

  return files
}

describe("private-runtime documentation contract", () => {
  it("documents canonical private-runtime commands instead of teaching the legacy inner alias", () => {
    const readme = readRepoFile("README.md")

    expect(readme).toContain("ouro private status --agent <agent>")
    expect(readme).toContain("ouro private decisions --agent <agent>")
    expect(readme).not.toMatch(/^ouro inner --agent <agent>.*private turn status$/m)
  })

  it("documents startup, habits, and provider readiness as no-hidden-spend policy boundaries", () => {
    const architecture = readRepoFile("ARCHITECTURE.md")
    const testingGuide = readRepoFile("docs", "testing-guide.md")
    const recoveryGuide = readRepoFile("docs", "known-issues-and-recovery.md")
    const machineGuide = readRepoFile("docs", "cross-machine-setup.md")

    for (const content of [architecture, testingGuide, recoveryGuide, machineGuide]) {
      expect(content).toContain("Starting the private runtime worker is process supervision, not a model turn.")
      expect(content).toContain("Denied/default private-runtime policy records or queues work with zero provider calls.")
      expect(content).toContain("Provider-readiness pings are explicit readiness checks, not private turns.")
    }

    expect(architecture).toContain("Daemon startup reconciles overdue habits through private-runtime policy; it does not spend merely because a habit is due.")
    expect(testingGuide).toContain("Passive startup/reload/restart must assert zero provider pings and zero private-turn executions.")
  })

  it("keeps provider lane names distinct from the private-runtime system name", () => {
    const architecture = readRepoFile("ARCHITECTURE.md")
    const authGuide = readRepoFile("docs", "auth-and-providers.md")
    const senseGuide = readRepoFile("docs", "sense-development.md")

    for (const content of [architecture, authGuide]) {
      expect(content).toContain("The `inner` lane is a provider/model lane, not the private-runtime system name.")
      expect(content).toContain("Provider/model selection belongs to `agent.json` lanes; `privateRuntime` cannot select providers or models.")
    }

    expect(senseGuide).toContain("Private runtime is not a durable sense/channel.")
    expect(senseGuide).toContain("policy-gated")
    expect(senseGuide).toContain("agent-facing runtime")
    expect(senseGuide).toContain("`inner` provider/model lane")
    expect(senseGuide).not.toContain("`teams`, `cli`, `inner`")
  })

  it("does not document inner as the current private execution or thinking runtime", () => {
    const currentDocPaths = ["README.md", "ARCHITECTURE.md", ...listMarkdownFiles("docs")]
    const staleCurrentRuntimePatterns = [
      /^## Inner Lane$/m,
      /\binner lane is the private execution lane\b/i,
      /\binner lane handles the agent's private thinking\b/i,
      /\binner lane is how a habit or private run thinks\b/i,
      /\bprivate execution lane\b/i,
      /\bprivate run thinks\b/i,
      /\bprivate runtime is the agent's private thinking space\b/i,
    ]

    for (const docPath of currentDocPaths) {
      const content = readRepoFile(docPath)

      for (const pattern of staleCurrentRuntimePatterns) {
        expect(content, `${docPath} must not match ${pattern}`).not.toMatch(pattern)
      }
    }
  })
})
