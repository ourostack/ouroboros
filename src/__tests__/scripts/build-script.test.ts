import { describe, expect, it } from "vitest"
import * as path from "path"

const {
  buildSteps,
  npmExecutable,
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
    npmExecutable: () => "npm",
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
        args: ["/repo/scripts/clean-dist.cjs"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
      {
        command: "/node",
        args: ["/repo/node_modules/typescript/bin/tsc"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
      {
        command: "npm",
        args: ["install", "--prefix", "packages/mailbox-ui", "--ignore-scripts"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
      {
        command: "npm",
        args: ["run", "build", "--prefix", "packages/mailbox-ui"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
      {
        command: "/node",
        args: ["/repo/scripts/copy-mailbox-ui.cjs"],
        options: { cwd: "/repo", stdio: "inherit" },
      },
    ])
    expect(stderr).toEqual([])
  })

  it("stops at the first failing step instead of skipping Mailbox UI assets", () => {
    const { calls, deps, stderr } = makeDeps([0, 0, 7, 0, 0])

    expect(runBuildCli([], deps)).toBe(7)

    expect(calls.map((call) => call.args.join(" "))).toEqual([
      "/repo/scripts/clean-dist.cjs",
      "/repo/node_modules/typescript/bin/tsc",
      "install --prefix packages/mailbox-ui --ignore-scripts",
    ])
    expect(stderr.join("")).toContain("build failed during install Mailbox UI dependencies with exit code 7")
  })

  it("stops when TypeScript compilation fails", () => {
    const { calls, deps, stderr } = makeDeps([0, 2, 0, 0, 0])

    expect(runBuildCli([], deps)).toBe(2)

    expect(calls).toHaveLength(2)
    expect(stderr.join("")).toContain("build failed during compile TypeScript with exit code 2")
  })

  it("uses npm.cmd on Windows", () => {
    expect(npmExecutable("win32")).toBe("npm.cmd")
    expect(npmExecutable("darwin")).toBe("npm")
  })

  it("keeps build step definitions pointed at the copied Mailbox UI assets", () => {
    const { deps } = makeDeps()

    expect(buildSteps("/repo", deps).map((step: { label: string }) => step.label)).toEqual([
      "clean dist",
      "compile TypeScript",
      "install Mailbox UI dependencies",
      "build Mailbox UI",
      "copy Mailbox UI assets",
    ])
  })
})
