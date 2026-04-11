import { describe, expect, it } from "vitest"
import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const wrapperPath = path.resolve(__dirname, "../../../packages/ouro.bot/index.js")

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
if (args[0] === "view" && args[1] === "@ouro.bot/cli@alpha" && args[2] === "version") {
  process.stdout.write(${JSON.stringify(`${version}\n`)})
  process.exit(0)
}

if (args[0] === "install") {
  const prefixIndex = args.indexOf("--prefix")
  const prefix = args[prefixIndex + 1]
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

function runWrapper(args: string[], version = "0.1.0-alpha.328") {
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
      SHELL: "/bin/zsh",
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
      expect(result.stdout).toBe("0.1.0-alpha.328\n")
      expect(result.stderr).toContain("ouro is ready")
      expect(result.stderr).toContain("Then run: ouro")
    } finally {
      result.cleanup()
    }
  })

  it("preserves first-install guidance without starting a bare CLI session", () => {
    const result = runWrapper([])
    try {
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("ouro is ready")
      expect(result.stderr).toContain("Then run: ouro")
    } finally {
      result.cleanup()
    }
  })
})
