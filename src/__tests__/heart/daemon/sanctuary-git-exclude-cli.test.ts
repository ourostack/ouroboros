import { beforeAll, describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"
import { SANCTUARY_GIT_EXCLUDES, sanctuaryGitExcludeText } from "../../../heart/daemon/sanctuary-bundle-migration"

// The cutover runs this command in the shipped image as
// `docker run --rm --network none --entrypoint node <image> /opt/ouro/dist/heart/daemon/ouro-entry.js sanctuary git-exclude --print`.
const IMAGE_ENTRY = "/opt/ouro/dist/heart/daemon/ouro-entry.js"
const BUILT_ENTRY = path.resolve("dist/heart/daemon/ouro-entry.js")
// The compiled files this command runs through; a stale or missing one means the test compiles first.
const COMMAND_SOURCES = ["ouro-entry", "cli-exec", "cli-parse", "sanctuary-bundle-migration"]

function builtIsCurrent(): boolean {
  return COMMAND_SOURCES.every((name) => {
    const built = path.resolve("dist/heart/daemon", `${name}.js`)
    const source = path.resolve("src/heart/daemon", `${name}.ts`)
    return fs.existsSync(built) && fs.statSync(built).mtimeMs >= fs.statSync(source).mtimeMs
  })
}

describe("ouro sanctuary git-exclude --print", () => {
  beforeAll(() => {
    if (builtIsCurrent()) return
    // The TypeScript step of the repo's build (scripts/build.cjs), which writes dist/ as the image copies it.
    const build = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "."], { encoding: "utf8" })
    if (build.status !== 0) throw new Error(`tsc failed: ${build.stdout}${build.stderr}`)
  }, 300_000)

  it("parses only the exact form", () => {
    expect(parseOuroCommand(["sanctuary", "git-exclude", "--print"])).toEqual({ kind: "sanctuary.git-exclude" })
    for (const args of [["sanctuary"], ["sanctuary", "git-exclude"], ["sanctuary", "git-exclude", "--write"], ["sanctuary", "git-exclude", "--print", "--agent", "x"]]) {
      expect(() => parseOuroCommand(args)).toThrow("Usage: ouro sanctuary git-exclude --print")
    }
  })

  it("writes the list and touches nothing else", async () => {
    const writeStdout = vi.fn()
    // Every other dependency is missing: reaching the daemon, the network or a bundle would throw.
    const text = await runOuroCli(["sanctuary", "git-exclude", "--print"], { writeStdout } as unknown as OuroCliDeps)
    expect(text).toBe(sanctuaryGitExcludeText())
    expect(writeStdout).toHaveBeenCalledOnce()
    expect(writeStdout).toHaveBeenCalledWith(`${SANCTUARY_GIT_EXCLUDES.join("\n")}\n`)
  })

  it("the image's CLI entry prints exactly SANCTUARY_GIT_EXCLUDES, one per line, and exits 0", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    expect(dockerfile).toContain("WORKDIR /opt/ouro")
    expect(dockerfile).toContain("COPY dist ./dist")
    expect(path.relative("/opt/ouro", IMAGE_ENTRY)).toBe(path.relative(process.cwd(), BUILT_ENTRY))

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "git-exclude-cli-"))
    try {
      const run = spawnSync(process.execPath, [BUILT_ENTRY, "sanctuary", "git-exclude", "--print"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home },
        timeout: 60_000,
      })
      expect(run.stderr).toBe("")
      expect(run.status).toBe(0)
      expect(run.stdout).toBe(`${SANCTUARY_GIT_EXCLUDES.join("\n")}\n`)
      expect(run.stdout.trimEnd().split("\n")).toEqual([...SANCTUARY_GIT_EXCLUDES])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
})
