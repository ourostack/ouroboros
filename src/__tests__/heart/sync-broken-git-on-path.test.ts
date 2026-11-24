import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { registerGlobalLogSink } from "../../nerves"
import { gitRuntimeEnv, resetGitBinaryCache, resolveGitBinary } from "../../heart/git-binary"
import { fetchRemote } from "../../heart/sync"

const SAVED = ["PATH", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_SYSTEM"] as const
let root: string
let saved: Record<string, string | undefined>
let unregister: () => void

function git(cwd: string, args: string[]): string {
  return execFileSync("/usr/bin/git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString().trim()
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-broken-git-")))
  saved = Object.fromEntries(SAVED.map((key) => [key, process.env[key]]))
  resetGitBinaryCache()
  unregister = registerGlobalLogSink(() => undefined)
})

afterEach(() => {
  unregister()
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

/** The Copilot app's relocatable git without the app's GIT_EXEC_PATH: it looks for its helpers under "//libexec". */
function brokenGitDir(): string {
  const bin = path.join(root, "broken-bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "git"), [
    "#!/bin/sh",
    'for a in "$@"; do [ "$a" = "--exec-path" ] && { echo //libexec/git-core; exit 0; }; done',
    "echo \"git: 'remote-https' is not a git command. See 'git --help'.\" >&2",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 })
  return bin
}

describe("a git on PATH that cannot reach remotes", () => {
  it("is skipped for one that can, and two consecutive fetches both land", async () => {
    const remote = path.join(root, "remote.git")
    const seed = path.join(root, "seed")
    const bundle = path.join(root, "agent.ouro")
    git(root, ["init", "-q", "--bare", "-b", "main", remote])
    git(root, ["init", "-q", "-b", "main", seed])
    git(seed, ["commit", "-q", "--allow-empty", "-m", "one"])
    git(seed, ["push", "-q", remote, "main"])
    git(root, ["clone", "-q", remote, bundle])
    const config = { enabled: true, remote: "origin", branch: "main" }

    delete process.env.GIT_EXEC_PATH
    process.env.PATH = `${brokenGitDir()}${path.delimiter}${process.env.PATH ?? ""}`
    expect(() => execFileSync("git", ["fetch"], { cwd: bundle, stdio: "pipe" })).toThrow()

    for (const message of ["two", "three"]) {
      git(seed, ["commit", "-q", "--allow-empty", "-m", message])
      git(seed, ["push", "-q", remote, "main"])
      const result = await fetchRemote(bundle, config)
      expect(result).toMatchObject({ ok: true })
      expect(git(bundle, ["rev-parse", "origin/main"])).toBe(git(seed, ["rev-parse", "HEAD"]))
    }
    expect(resolveGitBinary({ ...process.env })).not.toBe("git")
  })

  it("falls back to plain git when no candidate is healthy, and drops dead location variables", () => {
    const env = { PATH: "/nonexistent" }
    expect(resolveGitBinary({}, () => false)).toBe("git")
    expect(resolveGitBinary(env, () => false)).toBe("git")
    expect(resolveGitBinary(env, () => false)).toBe("git")
    const cleaned = gitRuntimeEnv({ GIT_EXEC_PATH: "/gone", GIT_TEMPLATE_DIR: "/gone", GIT_CONFIG_SYSTEM: "", KEEP: "1" }, () => false)
    expect(cleaned).toEqual({ GIT_CONFIG_SYSTEM: "", KEEP: "1" })
    const kept = gitRuntimeEnv({ GIT_EXEC_PATH: "/good", GIT_TEMPLATE_DIR: "/good" }, () => true)
    expect(kept).toEqual({ GIT_EXEC_PATH: "/good", GIT_TEMPLATE_DIR: "/good" })
  })
})
