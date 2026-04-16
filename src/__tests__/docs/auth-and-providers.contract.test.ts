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
      expect(content).toContain("ouro repair --agent <agent>")
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
    expect(authGuide).toContain("ouro vault create --agent <agent>")
    expect(authGuide).toContain("ouro vault replace --agent <agent>")
    expect(authGuide).toContain("only when the bundle already has vault coordinates")
    expect(authGuide).toContain("no local credential export")
    expect(authGuide).toContain("stable agent vault email")
    expect(authGuide).toContain("does not invent timestamped `+replaced` addresses")
    expect(authGuide).toContain("only use `--email <email>` when intentionally moving the agent")
    expect(authGuide).toContain("vault locator: not configured in agent.json")
    expect(authGuide).toContain("The prompt does not echo the secret.")
    expect(authGuide).toContain("ouro auth --agent <agent> --provider <provider>")
    expect(authGuide).toContain("ouro vault config set --agent <agent> --key bluebubbles.serverUrl")
    expect(authGuide).toContain("ouro use --agent <agent> --lane outward --provider <provider> --model <model>")
    expect(authGuide).toContain("Do not copy old local credential files into the bundle.")
    expect(authGuide).not.toContain(`~/${retiredCredentialDir}`)
    expect(authGuide).not.toContain(retiredCredentialDir)
    expect(authGuide).not.toContain("+replaced-")
    expect(authGuide).not.toContain("+recovered-")

    expect(machineGuide).toContain("Old Auth-Style Agents")
    expect(machineGuide).toContain("predates the vault-backed auth model")
    expect(machineGuide).toContain("ouro vault create --agent <agent>")
    expect(machineGuide).toContain("ouro vault replace --agent <agent>")
    expect(machineGuide).toContain("bundle already has vault coordinates")
    expect(machineGuide).toContain("stable agent vault email")
    expect((machineGuide.match(/```/g) ?? []).length % 2).toBe(0)
    expect(machineGuide).not.toContain("+replaced-")
    expect(machineGuide).not.toContain("+recovered-")
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

  it("documents hatchling vault unlock secrets as human-provided and non-echoing", () => {
    const authGuide = readRepoFile("docs", "auth-and-providers.md")
    const specialistPrompt = readRepoFile("src", "heart", "hatch", "specialist-prompt.ts")

    expect(authGuide).toContain("Prompt the human outside model context for a human-chosen hatchling vault unlock secret.")
    expect(authGuide).toContain("The hatchling vault unlock secret is not generated, printed, included in tool arguments, or sent through chat.")
    expect(specialistPrompt).toContain("complete_adoption tool triggers a hidden terminal prompt")
    expect(specialistPrompt).toContain("I must never ask the human to type the vault unlock secret into chat")
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
