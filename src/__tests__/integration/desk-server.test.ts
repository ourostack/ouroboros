import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { McpClient } from "../../repertoire/mcp-client"
import { bundledDeskDir, deskMcpServerConfig } from "../../repertoire/desk-mcp"

// The real Desk the package ships (vendor/desk, which `npm run build` fetches), run the way the daemon runs it, on a
// synthetic bundle: a desk folder inside the bundle's Git repository, next to files that are not Desk's.

const temps: string[] = []
const clients: McpClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.shutdown()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temps.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n")
}

/** A bundle repository with a desk holding only the harness's record, pushed to a bare remote. */
function syntheticBundle(): { bundle: string; desk: string; remote: string } {
  const remote = path.join(temp("bundle-remote-"), "bundle.git")
  git(path.dirname(remote), "init", "-q", "--bare", "-b", "main", remote)
  const bundle = temp("bundle-")
  git(bundle, "init", "-q", "-b", "main")
  git(bundle, "config", "user.email", "agent@example.com")
  git(bundle, "config", "user.name", "Agent")
  fs.writeFileSync(path.join(bundle, "agent.json"), "{}\n")
  fs.mkdirSync(path.join(bundle, "desk", "_record", "notes"), { recursive: true })
  fs.writeFileSync(path.join(bundle, "desk", "_record", "notes", "note.md"), "a note\n")
  git(bundle, "add", "-A")
  git(bundle, "commit", "-qm", "bundle")
  git(bundle, "remote", "add", "origin", remote)
  git(bundle, "push", "-q", "-u", "origin", "main")
  return { bundle, desk: path.join(bundle, "desk"), remote }
}

describe("the built-in Desk", () => {
  it("serves the desk it is bound to, and changes it only through commits of its own", async () => {
    expect(fs.existsSync(path.join(bundledDeskDir(), "mcp", "bootstrap.cjs"))).toBe(true)
    const { bundle, desk, remote } = syntheticBundle()
    const decoy = temp("decoy-desk-")
    const home = temp("home-")
    const config = deskMcpServerConfig(desk)
    const client = new McpClient({ ...config, env: { HOME: home, DESK: decoy } })
    clients.push(client)
    await client.connect()

    const tools = (await client.listTools()).map((tool) => tool.name)
    expect(tools).toEqual(expect.arrayContaining(["task_create", "task_update", "task_archive", "track_create", "desk_status", "desk_search", "desk_skill"]))

    // A fresh HOME makes Desk unpack its runtime first; it says when it has bound its root.
    const deadline = Date.now() + 90_000
    let root: { path: string | null; source: string | null } = { path: null, source: null }
    while (root.path === null && Date.now() < deadline) {
      root = JSON.parse(text(await client.callTool("desk_status", {}))).root
      if (root.path === null) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(root).toEqual({ path: desk, source: "explicit-root" })

    fs.writeFileSync(path.join(bundle, "agent.json"), "{\"dirty\":true}\n")
    expect(text(await client.callTool("track_create", { slug: "errands", title: "Errands", scope: "Small things to do" }))).not.toMatch(/error/i)
    expect(JSON.parse(text(await client.callTool("task_create", { track: "errands", slug: "buy-milk", title: "Buy milk" })))).toMatchObject({ status: "created", path: "errands/buy-milk/task.md" })

    expect(fs.existsSync(path.join(desk, "errands", "buy-milk", "task.md"))).toBe(true)
    expect(fs.existsSync(path.join(decoy, "errands"))).toBe(false)
    // Desk commits and pushes in the background, a moment after it answers.
    const pushed = () => git(remote, "log", "--format=%s", "main").split("\n").filter((subject) => subject.startsWith("task_create"))
    const pushDeadline = Date.now() + 60_000
    while (pushed().length === 0 && Date.now() < pushDeadline) await new Promise((resolve) => setTimeout(resolve, 500))
    expect(pushed()).toEqual(["task_create: errands/buy-milk"])
    expect(git(bundle, "status", "--porcelain", "--", "agent.json")).toBe("M agent.json")
    expect(git(bundle, "status", "--porcelain", "--", "desk")).toBe("")
  })
})
