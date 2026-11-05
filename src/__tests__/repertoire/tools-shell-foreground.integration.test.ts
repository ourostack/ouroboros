import { describe, expect, it, vi } from "vitest"

vi.mock("../../heart/identity", () => ({
  getAgentName: () => "shell-fixture",
  getAgentRoot: () => "/unused-shell-fixture",
  loadAgentConfig: () => ({ shell: { defaultTimeout: 30000 } }),
}))

import { shellToolDefinitions } from "../../repertoire/tools-shell"

const shell = shellToolDefinitions.find(entry => entry.tool.function.name === "shell")!
const nodeCommand = (source: string) => `exec ${JSON.stringify(process.execPath)} -e '${source}'`

describe("foreground shell process boundary", () => {
  it("keeps the receiver event loop responsive while a foreground command is running", async () => {
    const events: string[] = []
    const tick = new Promise<void>(resolve => setTimeout(() => { events.push("receiver-tick"); resolve() }, 0))
    const output = await shell.handler({ command: nodeCommand('setTimeout(() => process.stdout.write("finished"), 100)') })
    events.push("shell-completed")
    await tick
    expect(output).toBe("finished")
    expect(events).toEqual(["receiver-tick", "shell-completed"])
  })

  it("rejects failed commands with their stdout and stderr intact", async () => {
    await expect(Promise.resolve().then(() => shell.handler({ command: nodeCommand('process.stdout.write("partial"); process.stderr.write("failure"); process.exit(7)') })))
      .rejects.toMatchObject({ stdout: "partial", stderr: "failure" })
  })

  it("closes unused stdin so foreground commands can finish on EOF", async () => {
    expect(await shell.handler({
      command: nodeCommand('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"))'),
      timeout_ms: "500",
    })).toBe("eof")
  })

  it("enforces a foreground timeout without blocking unrelated receiver work", async () => {
    let ticked = false
    const tick = new Promise<void>(resolve => setTimeout(() => { ticked = true; resolve() }, 0))
    await expect(Promise.resolve().then(() => shell.handler({
      command: nodeCommand('setTimeout(() => {}, 5000)'), timeout_ms: "100",
    }))).rejects.toBeInstanceOf(Error)
    expect(ticked).toBe(true)
    await tick
  })
})
