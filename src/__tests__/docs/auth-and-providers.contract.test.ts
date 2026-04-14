import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...parts), "utf-8")
}

describe("auth/provider documentation contract", () => {
  it("documents how to continue using an existing agent bundle", () => {
    const authGuide = readRepoFile("docs", "auth-and-providers.md")
    const machineGuide = readRepoFile("docs", "cross-machine-setup.md")
    const readme = readRepoFile("README.md")

    for (const content of [authGuide, machineGuide]) {
      expect(content).toContain("Continue An Existing Agent Bundle")
      expect(content).toContain("ouro clone <bundle-git-remote>")
      expect(content).toContain("ouro vault unlock --agent <agent>")
      expect(content).toContain("ouro provider refresh --agent <agent>")
      expect(content).toContain("ouro auth verify --agent <agent>")
      expect(content).toContain("ouro vault config status --agent <agent>")
      expect(content).toContain("ouro up")
    }

    expect(readme).toContain("docs/cross-machine-setup.md")
    expect(readme).toContain("bundle plus vault")
  })

  it("keeps Ouro-owned credential sources to the bundle and agent vault", () => {
    const corpus = [
      readRepoFile("README.md"),
      readRepoFile("AGENTS.md"),
      readRepoFile("docs", "auth-and-providers.md"),
      readRepoFile("docs", "cross-machine-setup.md"),
      readRepoFile("src", "repertoire", "vault-unlock.ts"),
      readRepoFile("src", "heart", "daemon", "cli-exec.ts"),
    ].join("\n")

    expect(corpus).toContain("The only Ouro-owned durable credential locations are the bundle and the agent vault.")
    expect(corpus).toContain("Local unlock material is a machine-local cache, not a credential source of truth.")
    expect(corpus).not.toContain("operator password manager")
  })
})
