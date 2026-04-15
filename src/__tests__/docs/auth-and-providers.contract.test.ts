import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.resolve(process.cwd(), ...parts), "utf-8")
}

function readPackagedSkillCorpus(): string {
  const skillDir = path.resolve(process.cwd(), "skills")
  return fs.readdirSync(skillDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => readRepoFile("skills", entry))
    .join("\n")
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

  it("documents how to migrate old auth-style agents without legacy credential paths", () => {
    const authGuide = readRepoFile("docs", "auth-and-providers.md")
    const machineGuide = readRepoFile("docs", "cross-machine-setup.md")
    const retiredCredentialDir = [".agent", "secrets"].join("")

    expect(authGuide).toContain("## Old Auth-Style Agents")
    expect(authGuide).toContain("predates the vault-backed credential model")
    expect(authGuide).toContain("ouro vault status --agent <agent>")
    expect(authGuide).toContain("ouro vault create --agent <agent> --generate-unlock-secret")
    expect(authGuide).toContain("ouro auth --agent <agent> --provider <provider>")
    expect(authGuide).toContain("ouro vault config set --agent <agent> --key bluebubbles.serverUrl")
    expect(authGuide).toContain("ouro use --agent <agent> --lane outward --provider <provider> --model <model>")
    expect(authGuide).toContain("Do not copy old local credential files into the bundle.")
    expect(authGuide).not.toContain(`~/${retiredCredentialDir}`)
    expect(authGuide).not.toContain(retiredCredentialDir)

    expect(machineGuide).toContain("Old Auth-Style Agents")
    expect(machineGuide).toContain("predates the vault-backed auth model")
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

  it("keeps packaged skill credential guidance on the agent vault model", () => {
    const corpus = readPackagedSkillCorpus()
    const retiredCredentialDir = [".agent", "secrets"].join("")

    expect(corpus).toContain("agent's Bitwarden/Vaultwarden credential vault")
    expect(corpus).not.toContain(`~/${retiredCredentialDir}`)
    expect(corpus).not.toContain(retiredCredentialDir)
    expect(corpus).not.toContain("bundle vault")
    expect(corpus).not.toContain("vault.key")
    expect(corpus).not.toContain("Bitwarden Agent Access CLI")
  })
})
