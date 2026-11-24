/**
 * Slugger's projection on a synthetic bundle shaped like his: a git repository with a file in every folder the
 * projection drops, a token in an MCP server's `env`, a `vault` key, a symbolic link, an old fact store and the
 * household's leak patterns. None of what is dropped may reach the output, and the run's writable paths must exist.
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkProfile } from "../../../eval/sandbox/agent-profile"
import {
  archiveBundle,
  leakLint,
  projectAgentConfig,
  projectSlugger,
  readLeakPatterns,
  removeArchive,
  SLUGGER_WRITABLE,
  sluggerProfile,
} from "../../../eval/sandbox/slugger-projection"

const TOKEN = "tok-3f9a1c-synthetic-secret"
const DROPPED = ["friends", "state", "desk", "arc", "tasks", "family", "facts", "travel", "trips", "rsvp", "inbox", "scratch", ".backup"]
const FAKES = { spoonjoy: { command: "node", args: ["/opt/eval/fakes/spoonjoy.js"], tools: "tools/spoonjoy.json" } }
const INCLUDE = ["agent.json", "psyche", "skills", "bundle-meta.json"]

function write(root: string, relative: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  fs.writeFileSync(path.join(root, relative), text)
}

function files(root: string): string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name
      const stat = fs.lstatSync(path.join(root, child))
      if (stat.isDirectory()) { found.push(`${child}/`); walk(child) } else found.push(child)
    }
  }
  walk("")
  return found
}

const git = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim()
const commitAll = (repo: string, message: string): string => {
  git(repo, "add", "-A")
  git(repo, "-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "--no-verify", "-q", "-m", message)
  return git(repo, "rev-parse", "HEAD")
}

describe("Slugger's projection", () => {
  let root: string
  let repo: string
  let commit: string
  const made: string[] = []

  const archive = async (): Promise<string> => {
    const { dir } = await archiveBundle({ repo, commit, workRoot: root })
    made.push(dir)
    return dir
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-slugger-")))
    repo = path.join(root, "slugger.ouro")
    fs.mkdirSync(repo)
    write(repo, "agent.json", JSON.stringify({
      version: 2, enabled: true, humanFacing: { provider: "copilot", model: "m" }, agentFacing: { provider: "copilot", model: "m" },
      context: { maxTokens: 1000 }, phrases: { thinking: ["hm"], tool: ["on it"], followup: ["and"] },
      senses: { bluebubbles: { enabled: true, hostUsername: "household-mac" }, teams: { enabled: false }, shepherd: { enabled: true, notify: "every" } },
      mcpServers: { spoonjoy: { command: "/usr/local/bin/spoonjoy", env: { TOKEN } }, browser: { command: "browser-mcp" } },
      vault: { email: "agent@example.invalid" }, home: "/Users/household", sync: { enabled: true }, privateRuntime: {}, desks: { a: "~/desk" },
      habitPaidTurnsPerDay: 3,
    }))
    write(repo, "psyche/SOUL.md", "be kind")
    write(repo, "psyche/TACIT.md", "what was learned")
    write(repo, "psyche/memory/facts.json", "{}")
    write(repo, "skills/cooking.md", "use the recipe tools")
    write(repo, "skills/.git/config", "nested")
    write(repo, "psyche/.backup/SOUL.md", "an older copy")
    // A folder whose only content is left out still comes out empty, so its name must be linted too.
    fs.mkdirSync(path.join(repo, "skills/only-a-link"), { recursive: true })
    fs.symlinkSync("../../friends/private.md", path.join(repo, "skills/only-a-link/friend.md"))
    write(repo, "bundle-meta.json", "{}")
    write(repo, "eval/leak-patterns.json", JSON.stringify({ literals: ["Zephyrine", "zz-handle"] }))
    write(repo, "vault", "a vault file")
    for (const dir of DROPPED) write(repo, `${dir}/private.md`, "private")
    fs.symlinkSync("../friends/private.md", path.join(repo, "skills/friend-link.md"))
    git(repo, "init", "-q")
    commit = commitAll(repo, "synthetic")
    // Not committed: the live working tree must never be read.
    write(repo, "skills/uncommitted.md", "working tree only")
  })

  afterEach(() => {
    for (const dir of made.splice(0)) {
      try { removeArchive(dir) } catch { /* removed by the test */ }
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("keeps only the allowlist, rewrites agent.json, drops every private path, and makes the writable paths", async () => {
    const dir = await archive()
    const out = path.join(root, "out")
    const { gaps } = projectSlugger({ archive: dir, include: INCLUDE, out, fakes: FAKES })
    expect(files(out)).toEqual([
      "agent.json", "arc/", "books/", "books/ledger.ndjson", "books/removed/", "books/work/", "bundle-meta.json", "desk/", "desk/_record/",
      "desk/_record/diary/", "desk/_record/diary/daily/", "desk/_record/notes/", "friends/", "psyche/", "psyche/SOUL.md", "skills/",
      "skills/cooking.md", "skills/only-a-link/", "state/",
    ])
    expect(fs.readFileSync(path.join(out, "books/ledger.ndjson"), "utf8")).toBe("")
    const config = JSON.parse(fs.readFileSync(path.join(out, "agent.json"), "utf8"))
    expect(Object.keys(config).sort()).toEqual(["agentFacing", "context", "enabled", "humanFacing", "mcpServers", "phrases", "senses", "version"])
    expect(config.senses).toEqual({ bluebubbles: { enabled: true }, shepherd: { enabled: true }, teams: { enabled: false } })
    expect(config.mcpServers).toEqual({ spoonjoy: FAKES.spoonjoy })
    expect(files(out).flatMap((file) => file.endsWith("/") ? [] : [fs.readFileSync(path.join(out, file), "utf8")]).join("\n")).not.toContain(TOKEN)
    expect(gaps).toEqual(expect.arrayContaining([
      "skills/friend-link.md: a symbolic link, left out",
      "agent.json: left out desks, habitPaidTurnsPerDay, home, privateRuntime, sync, vault, senses.bluebubbles.hostUsername, senses.shepherd.notify, mcpServers.browser",
      "spoonjoy: a fake MCP server with synthetic data stands in for the real one",
      "browser: left out",
    ]))
    for (const entry of SLUGGER_WRITABLE) expect(fs.existsSync(path.join(out, entry))).toBe(true)
  })

  it("gives a profile the sandbox accepts, named slugger, whose source is the projection", async () => {
    const dir = await archive()
    const profile = sluggerProfile({ archive: dir, fakes: {} })
    expect(profile.agent).toBe("slugger")
    expect(() => checkProfile(profile)).not.toThrow()
    const out = path.join(root, "out")
    expect(profile.bundleSource({ include: ["skills"], out }).gaps).toContain("skills/friend-link.md: a symbolic link, left out")
    expect(fs.existsSync(path.join(out, "agent.json"))).toBe(false)
  })

  it("stops on a leak pattern, in any case, in a file's contents or its name, and leaves no projection", async () => {
    write(repo, "skills/notes.md", "ask ZEPHYRINE first")
    commit = commitAll(repo, "leak")
    const dir = await archive()
    const out = path.join(root, "out")
    expect(() => projectSlugger({ archive: dir, include: INCLUDE, out, fakes: {} })).toThrow(/^Slugger projection: 1 projected path\(s\) or gap\(s\) hold a leak pattern; nothing was run$/)
    expect(fs.existsSync(out)).toBe(false)
    const named = path.join(root, "named")
    write(named, "skills/zz-handle.md", "plain")
    fs.mkdirSync(path.join(named, "skills/Zephyrine"))
    expect(leakLint(named, ["zz-handle", "zephyrine"])).toEqual(["skills/Zephyrine/", "skills/zz-handle.md"])
    expect(leakLint(named, ["nothing-here"])).toEqual([])
  })

  it("stops on a leak pattern in a gap, such as a left-out server's or link's name", async () => {
    const dir = await archive()
    const config = JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8"))
    config.mcpServers["zephyrine-calendar"] = { command: "x" }
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify(config))
    const out = path.join(root, "out")
    expect(() => projectSlugger({ archive: dir, include: ["agent.json"], out, fakes: {} })).toThrow(/1 projected path\(s\) or gap\(s\) hold a leak pattern/)
    expect(fs.existsSync(out)).toBe(false)
  })

  it("refuses a bundle without leak patterns, or with unusable ones", async () => {
    const dir = await archive()
    const out = path.join(root, "out")
    fs.rmSync(path.join(dir, "eval/leak-patterns.json"))
    expect(() => projectSlugger({ archive: dir, include: INCLUDE, out, fakes: {} })).toThrow(/has no eval\/leak-patterns\.json/)
    write(dir, "eval/leak-patterns.json", "not json")
    expect(() => readLeakPatterns(dir)).toThrow(/is not JSON/)
    for (const bad of [{}, { literals: [] }, { literals: ["ab"] }, { literals: [3] }, []]) {
      write(dir, "eval/leak-patterns.json", JSON.stringify(bad))
      expect(() => readLeakPatterns(dir)).toThrow(/non-empty "literals"/)
    }
    write(dir, "eval/leak-patterns.json", JSON.stringify({ literals: ["  Ab C "] }))
    expect(readLeakPatterns(dir)).toEqual(["ab c"])
  })

  it.each([
    ["a dropped folder", "friends"],
    ["the fact store", "psyche/memory"],
    ["TACIT.md", "psyche/TACIT.md"],
    ["a path that climbs out", "skills/../friends"],
    ["the leak patterns", "eval"],
  ])("refuses a case that includes %s", async (_name, include) => {
    const dir = await archive()
    expect(() => projectSlugger({ archive: dir, include: [include], out: path.join(root, "out"), fakes: {} })).toThrow(/a case may include/)
  })

  it("refuses a source it didn't archive, an archive already removed, and an output folder that exists", async () => {
    const out = path.join(root, "out")
    expect(() => projectSlugger({ archive: repo, include: INCLUDE, out, fakes: {} })).toThrow(/is no git archive this run made/)
    const dir = await archive()
    fs.mkdirSync(out)
    expect(() => projectSlugger({ archive: dir, include: INCLUDE, out, fakes: {} })).toThrow(/already exists/)
    removeArchive(dir)
    expect(fs.existsSync(dir)).toBe(false)
    expect(() => removeArchive(dir)).toThrow(/is no archive this run made/)
    expect(() => projectSlugger({ archive: dir, include: INCLUDE, out: path.join(root, "out2"), fakes: {} })).toThrow(/is no git archive this run made/)
    const stuck = await archive()
    const exists = vi.spyOn(fs, "existsSync").mockReturnValueOnce(true)
    expect(() => removeArchive(stuck)).toThrow(/still there after its removal/)
    exists.mockRestore()
  })

  it("lists nothing as left out of an agent.json that holds only allowed keys", async () => {
    const dir = await archive()
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ version: 2, phrases: { thinking: [], tool: [], followup: [] } }))
    const { gaps } = projectSlugger({ archive: dir, include: ["agent.json"], out: path.join(root, "out"), fakes: {} })
    expect(gaps.filter((gap) => gap.startsWith("agent.json"))).toEqual([])
  })

  it("reports a missing or broken agent.json, a missing include and a path under a link", async () => {
    const dir = await archive()
    fs.symlinkSync("../friends", path.join(dir, "skills/linked"))
    const { gaps } = projectSlugger({ archive: dir, include: ["skills/absent.md", "skills/linked/private.md"], out: path.join(root, "a"), fakes: {} })
    expect(gaps).toEqual(expect.arrayContaining(["skills/absent.md: not in the bundle", "skills/linked/private.md: under a symbolic link, left out"]))
    fs.writeFileSync(path.join(dir, "agent.json"), "{")
    expect(() => projectSlugger({ archive: dir, include: ["agent.json"], out: path.join(root, "b"), fakes: {} })).toThrow(/agent\.json is missing or not JSON/)
  })

  it("builds agent.json from the allowlist only, whatever shape the senses and servers take", () => {
    expect(() => projectAgentConfig([], {})).toThrow(/not an object/)
    expect(projectAgentConfig({ version: 1, senses: { cli: "on", mail: { enabled: "yes" } }, mcpServers: [] }, {})).toEqual({
      config: { version: 1, senses: { cli: { enabled: false }, mail: { enabled: false } } }, dropped: [],
    })
    expect(projectAgentConfig({ senses: null, mcpServers: { a: { command: "x" } } }, { a: { command: "fake" } })).toEqual({ config: { mcpServers: { a: { command: "fake" } } }, dropped: [] })
  })

  it("archives a commit, not the working tree, and cleans up when it can't", async () => {
    const dir = await archive()
    expect(fs.existsSync(path.join(dir, "skills/cooking.md"))).toBe(true)
    expect(fs.existsSync(path.join(dir, "skills/uncommitted.md"))).toBe(false)
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false)
    await expect(archiveBundle({ repo, commit: "no-such-commit", workRoot: root })).rejects.toThrow(/rev-parse .* exited 128/)
    // An unpacker that reads the whole archive and succeeds but writes nothing.
    const swallow = path.join(root, "swallow.sh")
    fs.writeFileSync(swallow, "#!/bin/sh\ncat > /dev/null\n", { mode: 0o755 })
    const before = fs.readdirSync(root).length
    await expect(archiveBundle({ repo, commit, workRoot: root, tar: "false" })).rejects.toThrow(/exited/)
    await expect(archiveBundle({ repo, commit, workRoot: root, tar: swallow })).rejects.toThrow(/is missing \d+ of its top-level entries/)
    expect(fs.readdirSync(root).length).toBe(before)
    const { dir: inTemp } = await archiveBundle({ repo, commit })
    made.push(inTemp)
    expect(path.dirname(inTemp)).toBe(os.tmpdir())
  })

  it("reads top-level names that git would quote", async () => {
    write(repo, "café.md", "plain")
    commit = commitAll(repo, "accent")
    const dir = await archive()
    expect(fs.existsSync(path.join(dir, "café.md"))).toBe(true)
  })

  it("removes a projection it refuses partway", async () => {
    const dir = await archive()
    fs.writeFileSync(path.join(dir, "agent.json"), "{")
    const out = path.join(root, "out")
    expect(() => projectSlugger({ archive: dir, include: ["skills", "agent.json"], out, fakes: {} })).toThrow(/not JSON/)
    expect(fs.existsSync(out)).toBe(false)
  })

  it("doesn't wait on git when the unpacker stops before a large archive is written", async () => {
    write(repo, "skills/large.md", "x".repeat(4 * 1024 * 1024))
    commitAll(repo, "large")
    const before = fs.readdirSync(root).length
    await expect(archiveBundle({ repo, commit: "HEAD", workRoot: root, tar: "true" })).rejects.toThrow(/archive/)
    expect(fs.readdirSync(root).length).toBe(before)
  }, 30_000)
})
