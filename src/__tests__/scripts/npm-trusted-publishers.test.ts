import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, expect, it } from "vitest"

const {
  EXPECTED_REPOSITORY,
  EXPECTED_WORKFLOW,
  buildRepairPlan,
  collectTrustIds,
  formatCommand,
  isAuthRequired,
  runRepair,
  trustCreateCommand,
  trustInteractiveAuthCommand,
  trustListCommand,
  trustOutputMatchesExpected,
  validateTrustedPublisherLocalContract,
} = require(path.resolve(__dirname, "../../../scripts/npm-trusted-publishers.cjs"))

function makeRepoFixture(input: {
  rootRepositoryUrl?: string
  wrapperRepositoryUrl?: string
  workflow?: string
} = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-npm-trust-"))
  fs.mkdirSync(path.join(root, "packages", "ouro.bot"), { recursive: true })
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true })

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "@ouro.bot/cli",
    repository: {
      type: "git",
      url: input.rootRepositoryUrl ?? "git+https://github.com/ourostack/ouroboros.git",
    },
  }))
  fs.writeFileSync(path.join(root, "packages", "ouro.bot", "package.json"), JSON.stringify({
    name: "ouro.bot",
    repository: {
      type: "git",
      url: input.wrapperRepositoryUrl ?? "git+https://github.com/ourostack/ouroboros.git",
    },
  }))
  fs.writeFileSync(path.join(root, ".github", "workflows", "coverage.yml"), input.workflow ?? `
publish:
  permissions:
    contents: read
    id-token: write
  steps:
    - uses: actions/setup-node@v6
      with:
        node-version: 24
        registry-url: https://registry.npmjs.org
        package-manager-cache: false
    - name: Install latest npm (trusted publishing requires npm >=11.5.1 on Node >=22.14)
      run: npm install -g npm@latest
    - run: npm publish --access public --tag "$TAG"
    - run: npm publish --access public --tag "\${{ steps.wrapper-publish-tag.outputs.tag }}"
`)

  return root
}

describe("npm trusted publisher contract", () => {
  it("passes when package metadata and publish workflow match the expected npm OIDC identity", () => {
    const root = makeRepoFixture()
    const result = validateTrustedPublisherLocalContract({ repoRoot: root })
    fs.rmSync(root, { recursive: true, force: true })

    expect(result.ok).toBe(true)
    expect(result.expectedRepository).toBe("ourostack/ouroboros")
    expect(result.messages.join("\n")).toContain("@ouro.bot/cli, ouro.bot")
  })

  it("fails when a published package still points at the old GitHub owner", () => {
    const root = makeRepoFixture({
      rootRepositoryUrl: "git+https://github.com/ouroborosbot/ouroboros.git",
    })
    const result = validateTrustedPublisherLocalContract({ repoRoot: root })
    fs.rmSync(root, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("@ouro.bot/cli repository.url must be")
    expect(result.errors.join("\n")).toContain("ouroborosbot/ouroboros")
  })

  it("fails when the publish workflow loses OIDC permission", () => {
    const root = makeRepoFixture({
      workflow: `
publish:
  permissions:
    contents: read
  steps:
    - run: npm publish --access public --tag "$TAG"
    - run: npm publish --access public --tag "\${{ steps.wrapper-publish-tag.outputs.tag }}"
`,
    })
    const result = validateTrustedPublisherLocalContract({ repoRoot: root })
    fs.rmSync(root, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("id-token: write")
  })

  it("prints the exact npm trust commands instead of relying on npm UI edits", () => {
    const plan = buildRepairPlan()

    expect(plan).toContain(EXPECTED_REPOSITORY)
    expect(plan).toContain(EXPECTED_WORKFLOW)
    expect(plan).toContain(formatCommand(trustListCommand("@ouro.bot/cli")))
    expect(plan).toContain(formatCommand(trustCreateCommand("ouro.bot")))
    expect(plan).toContain("--allow-publish")
  })

  it("detects whether npm trust JSON output matches the expected publisher", () => {
    expect(trustOutputMatchesExpected({
      id: "trusted-publisher-id",
      provider: "github",
      repository: "ourostack/ouroboros",
      workflow: "coverage.yml",
      allowedActions: ["npm publish"],
    })).toBe(true)

    expect(trustOutputMatchesExpected({
      id: "trusted-publisher-id",
      provider: "github",
      repository: "ouroborosbot/ouroboros",
      workflow: "coverage.yml",
      allowedActions: ["npm publish"],
    })).toBe(false)
  })

  it("collects trust relationship ids from nested npm trust JSON shapes", () => {
    expect(Array.from(collectTrustIds({
      trustedPublishers: [
        { id: "first" },
        { trustId: "second" },
        { nested: { _id: "third" } },
      ],
    })).sort()).toEqual(["first", "second", "third"])
  })

  it("recognizes npm web proof errors as auth-required output", () => {
    expect(isAuthRequired("npm error code EOTP\nOpen this URL: https://www.npmjs.com/auth/cli/test")).toBe(true)
    expect(isAuthRequired("404 package missing")).toBe(false)
  })

  it("uses an interactive auth probe before retrying trust repair when npm requires web proof", () => {
    const capturedCommands: string[][] = []
    const interactiveCommands: string[][] = []

    const oldTrust = {
      trustedPublishers: [
        {
          id: "old-trust",
          repository: "ouroborosbot/ouroboros",
          workflow: "coverage.yml",
          allowedActions: ["npm publish"],
        },
      ],
    }
    const expectedTrust = {
      trustedPublishers: [
        {
          id: "expected-trust",
          repository: EXPECTED_REPOSITORY,
          workflow: EXPECTED_WORKFLOW,
          allowedActions: ["npm publish"],
        },
      ],
    }

    const runCommandImpl = (args: string[]) => {
      capturedCommands.push(args)
      const joined = args.join(" ")
      const packageName = args.includes("@ouro.bot/cli") ? "@ouro.bot/cli" : "ouro.bot"

      if (capturedCommands.length === 1) {
        return {
          status: 1,
          stdout: "",
          stderr: "npm error code EOTP\nhttps://www.npmjs.com/auth/cli/test",
          output: "npm error code EOTP\nhttps://www.npmjs.com/auth/cli/test",
        }
      }

      if (joined.includes(" trust list ")) {
        return {
          status: 0,
          stdout: JSON.stringify(packageName === "@ouro.bot/cli" ? oldTrust : expectedTrust),
          stderr: "",
          output: "",
        }
      }

      return {
        status: 0,
        stdout: "",
        stderr: "",
        output: "",
      }
    }

    const spawnSyncImpl = (command: string, args: string[]) => {
      interactiveCommands.push([command, ...args])
      return { status: 0 }
    }

    runRepair({
      runCommandImpl,
      spawnSyncImpl,
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    })

    expect(interactiveCommands).toEqual([trustInteractiveAuthCommand("@ouro.bot/cli")])
    expect(capturedCommands.filter((args) => args.join(" ").includes(" trust list @ouro.bot/cli "))).toHaveLength(2)
    expect(capturedCommands.some((args) => args.includes("old-trust"))).toBe(true)
    expect(capturedCommands.some((args) => args.join(" ").includes(" trust github @ouro.bot/cli "))).toBe(true)
  })

  it("keeps npm web proof human-required when repair is not running in a TTY", () => {
    expect(() => runRepair({
      runCommandImpl: () => ({
        status: 1,
        stdout: "",
        stderr: "npm error code EOTP\nhttps://www.npmjs.com/auth/cli/test",
        output: "npm error code EOTP\nhttps://www.npmjs.com/auth/cli/test",
      }),
      stdin: { isTTY: false },
      stdout: { isTTY: false },
    })).toThrow(/requires human npm 2FA/)
  })
})
