import { describe, expect, it } from "vitest"
import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const wrapperPath = path.resolve(__dirname, "../../../packages/ouro.bot/index.js")
const wrapperPackagePath = path.resolve(__dirname, "../../../packages/ouro.bot/package.json")
const wrapperPackageVersion = JSON.parse(fs.readFileSync(wrapperPackagePath, "utf8")).version as string

function writeFakeNpm(binDir: string, version: string): void {
  const fakeNpmPath = path.join(binDir, "npm")
  const installedEntry = [
    "#!/usr/bin/env node",
    `const version = ${JSON.stringify(version)}`,
    "if (process.argv.slice(2).includes(\"--version\")) {",
    "  process.stdout.write(version + \"\\n\")",
    "} else {",
    "  process.stdout.write(\"ran installed ouro \" + JSON.stringify(process.argv.slice(2)) + \"\\n\")",
    "}",
    "",
  ].join("\n")
  const script = `#!/usr/bin/env node
const fs = require("fs")
const path = require("path")

const args = process.argv.slice(2)
if (args[0] === "view") {
  process.stderr.write("wrapper must not query npm view during bootstrap: " + JSON.stringify(args) + "\\n")
  process.exit(1)
}

if (args[0] === "install") {
  const prefixIndex = args.indexOf("--prefix")
  const prefix = args[prefixIndex + 1]
  const packageRef = args.find((arg) => arg.startsWith("@ouro.bot/cli@"))
  if (packageRef !== ${JSON.stringify(`@ouro.bot/cli@${version}`)}) {
    process.stderr.write("unexpected cli package ref: " + JSON.stringify(packageRef) + "\\n")
    process.exit(1)
  }
  const entry = path.join(prefix, "node_modules", "@ouro.bot", "cli", "dist", "heart", "daemon", "ouro-entry.js")
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, ${JSON.stringify(installedEntry)})
  fs.chmodSync(entry, 0o755)
  process.exit(0)
}

process.stderr.write("unexpected fake npm args: " + JSON.stringify(args) + "\\n")
process.exit(1)
`
  fs.writeFileSync(fakeNpmPath, script, { mode: 0o755 })
}

function runWrapper(args: string[], options: { version?: string; shell?: string } = {}) {
  const { version = wrapperPackageVersion, shell = "/bin/zsh" } = options
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-bot-package-test-"))
  const home = path.join(root, "home")
  const binDir = path.join(root, "bin")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  writeFakeNpm(binDir, version)

  const result = spawnSync(process.execPath, [wrapperPath, ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      SHELL: shell,
    },
    encoding: "utf-8",
  })

  return {
    ...result,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

describe("ouro.bot package bootstrap", () => {
  it("passes CLI args through after a fresh first install", () => {
    const result = runWrapper(["--version"])
    try {
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`${wrapperPackageVersion}\n`)
      expect(result.stderr).toContain("ouro is ready")
    } finally {
      result.cleanup()
    }
  })

  it("always passes through to CLI on first install (hatch-or-clone flow)", () => {
    const result = runWrapper([])
    try {
      // First install with no args now passes through to CLI
      // (previously stopped early with "Then run: ouro")
      expect(result.stderr).toContain("ouro is ready")
      // CLI is invoked — may produce output from the hatch/clone flow
      // We just verify the wrapper ran without a hard crash
      expect(result.status === 0 || result.status === 1).toBe(true)
    } finally {
      result.cleanup()
    }
  })

  it("shows shell-aware PATH hint on first install (zsh)", () => {
    const result = runWrapper(["--version"], { shell: "/bin/zsh" })
    try {
      expect(result.stderr).toContain("source ~/.zshrc")
    } finally {
      result.cleanup()
    }
  })

  it("shows shell-aware PATH hint on first install (bash)", () => {
    const result = runWrapper(["--version"], { shell: "/bin/bash" })
    try {
      // macOS uses .bash_profile, Linux uses .bashrc
      const expectedProfile = process.platform === "darwin" ? "~/.bash_profile" : "~/.bashrc"
      expect(result.stderr).toContain(`source ${expectedProfile}`)
    } finally {
      result.cleanup()
    }
  })

  it("shows shell-aware PATH hint on first install (fish)", () => {
    const result = runWrapper(["--version"], { shell: "/usr/bin/fish" })
    try {
      expect(result.stderr).toContain("source ~/.config/fish/config.fish")
    } finally {
      result.cleanup()
    }
  })

  it("shows generic PATH hint on first install (unknown shell)", () => {
    const result = runWrapper(["--version"], { shell: "/bin/tcsh" })
    try {
      expect(result.stderr).toContain("restart your shell")
    } finally {
      result.cleanup()
    }
  })
})
