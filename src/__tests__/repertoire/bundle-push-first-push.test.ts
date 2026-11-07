/**
 * probeFirstPush: whether a bundle_push would be the first push of the sync
 * branch (which needs the Directive D confirmation token). It asks the remote
 * through sync's own ls-remote, against real local remotes here: an empty one,
 * one with the branch, and one that cannot be reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { probeFirstPush } from "../../repertoire/tools-bundle"

const OWNER = ["-c", "user.name=Owner", "-c", "user.email=owner@example.invalid", "-c", "commit.gpgsign=false"]

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()
}

let tmp: string
let bundle: string
let remote: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "first-push-probe-"))
  remote = path.join(tmp, "remote.git")
  bundle = path.join(tmp, "agent.ouro")
  git(tmp, ["init", "-q", "--bare", "-b", "main", remote])
  git(tmp, ["init", "-q", "-b", "main", bundle])
  fs.writeFileSync(path.join(bundle, "agent.json"), "{}\n")
  git(bundle, [...OWNER, "add", "-A"])
  git(bundle, [...OWNER, "commit", "-q", "-m", "seed"])
  git(bundle, ["remote", "add", "origin", remote])
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("probeFirstPush", () => {
  it("says first for an empty remote", async () => {
    expect(await probeFirstPush(bundle, "origin", "main")).toEqual({ kind: "first" })
  })

  it("says pushed for a remote that has the branch", async () => {
    git(bundle, ["push", "-q", "origin", "HEAD:refs/heads/main"])
    expect(await probeFirstPush(bundle, "origin", "main")).toEqual({ kind: "pushed" })
  })

  it("says first for a populated remote that lacks this branch, and asks only for that branch", async () => {
    git(bundle, ["push", "-q", "origin", "HEAD:refs/heads/other"])
    expect(await probeFirstPush(bundle, "origin", "main")).toEqual({ kind: "first" })
    expect(await probeFirstPush(bundle, "origin", "other")).toEqual({ kind: "pushed" })
  })

  it("says unreachable, not first, when ls-remote fails", async () => {
    git(bundle, ["remote", "set-url", "origin", path.join(tmp, "missing.git")])
    const probe = await probeFirstPush(bundle, "origin", "main")
    expect(probe.kind).toBe("unreachable")
    expect(probe.kind === "unreachable" && probe.error).toMatch(/^git ls-remote failed/)
  })
})
