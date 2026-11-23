import { describe, expect, it } from "vitest"
import * as path from "path"

const {
  buildSteps,
  parseArgs,
  runBuildCli,
} = require(path.resolve(__dirname, "../../../scripts/build.cjs"))

type SpawnCall = {
  command: string
  args: string[]
  options: { cwd: string; stdio: string }
}

function makeDeps(statuses: number[] = []) {
  const calls: SpawnCall[] = []
  const stderr: string[] = []
  const repoRoot = "/repo"
  const deps = {
    defaultRepoRoot: repoRoot,
    execPath: "/node",
    join: path.join,
    resolve: path.resolve,
    resolveTypeScriptTsc: () => "/repo/node_modules/typescript/bin/tsc",
    spawnSync: (command: string, args: string[], options: { cwd: string; stdio: string }) => {
      calls.push({ command, args, options })
      return { status: statuses.shift() ?? 0 }
    },
    writeStderr: (text: string) => {
      stderr.push(text)
    },
  }
  return { calls, deps, stderr }
}

describe("build script", () => {
  it("runs every required package build step in order", () => {
    const { calls, deps, stderr } = makeDeps()

    expect(runBuildCli([], deps)).toBe(0)

    expect(calls).toEqual([
      {
        command: "/node",
        args: ["/repo/scripts/desk-vendor.cjs"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
      {
        command: "/node",
        args: ["/repo/scripts/clean-dist.cjs"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
      {
        command: "/node",
        args: ["/repo/node_modules/typescript/bin/tsc"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
      {
        command: "/node",
        args: ["/repo/scripts/sanctuary-health-acceptance-probe-entry-smoke.cjs"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
    ])
    expect(stderr).toEqual([])
  })

  it("stops at the first failing step instead of running the rest", () => {
    const { calls, deps, stderr } = makeDeps([0, 0, 0, 5])

    expect(runBuildCli([], deps)).toBe(5)

    expect(calls).toHaveLength(4)
    expect(stderr.join("")).toContain("build failed during smoke Sanctuary health acceptance probe entry with exit code 5")
  })

  it("stops when TypeScript compilation fails", () => {
    const { calls, deps, stderr } = makeDeps([0, 0, 2, 0, 0])

    expect(runBuildCli([], deps)).toBe(2)

    expect(calls).toHaveLength(3)
    expect(stderr.join("")).toContain("build failed during compile TypeScript with exit code 2")
  })

  it("builds the repository named as the first argument", () => {
    const { calls, deps } = makeDeps()

    expect(parseArgs(["/elsewhere"])).toEqual({ repoRoot: "/elsewhere" })
    expect(runBuildCli(["/elsewhere"], deps)).toBe(0)

    expect(calls.map((call) => call.options.cwd)).toEqual(["/elsewhere", "/elsewhere", "/elsewhere", "/elsewhere"])
  })

  it("defines only the Desk, clean, compile and smoke steps", () => {
    const { deps } = makeDeps()

    expect(buildSteps("/repo", deps).map((step: { label: string }) => step.label)).toEqual([
      "vendor the pinned Desk release",
      "clean dist",
      "compile TypeScript",
      "smoke Sanctuary health acceptance probe entry",
    ])
  })
})
