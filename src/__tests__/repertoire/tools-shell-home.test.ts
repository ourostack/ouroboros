import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

vi.mock("../../heart/identity", () => ({
  getAgentName: () => "shell-home",
  getAgentRoot: () => { throw new Error("no agent") },
  loadAgentConfig: () => ({ shell: { defaultTimeout: 30000 } }),
}))

import { shellToolDefinitions } from "../../repertoire/tools-shell"

const shell = shellToolDefinitions.find((entry) => entry.tool.function.name === "shell")!
const node = (source: string) => `${JSON.stringify(process.execPath)} -e '${source}'`

describe("shell at home", () => {
  let home: string
  let ctx: { signin: () => Promise<undefined>; agentRoot: string; agentName: string }
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shell-home-test-")))
    ctx = { signin: async () => undefined, agentRoot: home, agentName: "shell-home" }
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it("describes itself in two sentences", () => {
    expect(shell.tool.function.description!.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2)
  })

  it("starts in the agent's home", async () => {
    expect((await shell.handler({ command: "pwd" }, ctx as any)).trim()).toBe(home)
  })

  it("starts in the process directory when there is no agent at all", async () => {
    expect((await shell.handler({ command: "pwd" })).trim()).toBe(fs.realpathSync(process.cwd()))
  })

  it("returns short output unchanged and writes no file", async () => {
    expect(await shell.handler({ command: "echo hi" }, ctx as any)).toBe("hi\n")
    expect(fs.existsSync(path.join(home, "state", "tool-output"))).toBe(false)
  })

  it("keeps the last 2000 lines and saves the full output (0600)", async () => {
    const out = await shell.handler({ command: node('for (let i=1;i<=2500;i++) console.log("line"+i)') }, ctx as any)
    const saved = /full output saved to (\S+?\.txt);/.exec(out)![1]
    expect(out).toContain("[output cut to its last 2000 of 2500 lines;")
    expect(out).toContain("read_file it with an offset]")
    expect(out).toContain("line2500")
    expect(out).not.toContain("line500\n")
    expect(path.dirname(saved)).toBe(path.join(home, "state", "tool-output"))
    expect(fs.readFileSync(saved, "utf-8")).toContain("line1\n")
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600)
  })

  it("keeps the last 30,000 characters when lines are long", async () => {
    const out = await shell.handler({ command: node('for (let i=1;i<=100;i++) console.log("c"+i+" "+"x".repeat(997))') }, ctx as any)
    expect(out).toContain("c100 ")
    expect(out).not.toContain("c1 ")
    expect(out.length).toBeLessThan(30_400)
  })

  it("cuts a single over-long line with no line break to its last 30,000 characters", async () => {
    const out = await shell.handler({ command: node('process.stdout.write("z".repeat(40000))') }, ctx as any)
    expect(out).toContain("[output cut to its last 1 of 1 lines;")
    expect(out.length).toBeLessThan(30_400)
  })

  it("gives a failing command's output the same tail cap and saved file", async () => {
    // exitCode, not exit(): exit() can drop stderr still queued for the pipe, and a short stderr has nothing to cut
    const failing = node('for (let i=1;i<=2500;i++) console.error("err"+i); process.exitCode = 3')
    const error = await shell.handler({ command: failing }, ctx as any).then(() => undefined, (e: Error & { stderr: string }) => e)
    expect(error).toBeDefined()
    expect(error!.message).toContain("[output cut to its last 2000")
    expect(error!.message).toContain("err2500")
    expect(error!.message).not.toContain("err500\n")
    expect(error!.stderr).toContain("full output saved to")
    expect(fs.readdirSync(path.join(home, "state", "tool-output")).length).toBeGreaterThanOrEqual(2)
  })

  it("keeps a short failure whole", async () => {
    const error = await shell.handler({ command: "echo bad >&2; exit 2" }, ctx as any).then(() => undefined, (e: Error) => e)
    expect(error!.message).toContain("bad")
    expect(fs.existsSync(path.join(home, "state", "tool-output"))).toBe(false)
  })

  it("starts a background shell in the agent's home", async () => {
    const started = JSON.parse(await shell.handler({ command: "pwd", background: true } as any, ctx as any))
    const tail = shellToolDefinitions.find((entry) => entry.tool.function.name === "shell_tail")!
    let out = ""
    for (let i = 0; i < 100 && !out.includes(home); i++) {
      await new Promise((r) => setTimeout(r, 50))
      out = String(await tail.handler({ id: started.id }, ctx as any))
    }
    expect(out).toContain(home)
  })

  it("does not throw on output beyond Node's old 1 MB buffer", async () => {
    const out = await shell.handler({ command: node('process.stdout.write("a".repeat(3000000))') }, ctx as any)
    expect(out).toContain("full output saved to")
  })
})
