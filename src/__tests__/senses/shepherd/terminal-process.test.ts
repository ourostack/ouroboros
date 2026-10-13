import { describe, expect, it, vi } from "vitest"
import { identifyTerminalProcesses } from "../../../senses/shepherd/terminal-process"

describe("terminal foreground identity", () => {
  it("finds the outermost agent in the foreground group and batches cwd reads", async () => {
    const run = vi.fn(async (command: string) => command === "ps" ? [
      "1 0 1 20 ttys001 /bin/zsh",
      "20 1 20 20 ttys001 /Users/a/.local/bin/claude",
      "21 20 20 20 ttys001 /Users/a/.local/bin/claude",
      "30 1 30 40 ttys002 /Users/a/.local/bin/claude",
      "40 1 40 40 ttys002 /opt/copilot",
      "50 1 50 50 ttys003 /opt/codex",
      "60 1 60 60 ttys004 /bin/zsh",
      "70 1 70 70 ttys999 /opt/copilot",
      "junk", "",
    ].join("\n") : "p20\nfcwd\nn/Users/a/one\np40\nfcwd\nn/Users/a/two\np50\nfcwd\nn/Users/a/three\n")
    const result = await identifyTerminalProcesses(["ttys001", "ttys002", "/dev/ttys003", "ttys004"], run)
    expect([...result]).toEqual([
      ["ttys001", { agent: "Claude Code", cwd: "/Users/a/one" }],
      ["ttys002", { agent: "Copilot", cwd: "/Users/a/two" }],
      ["ttys003", { agent: "Codex", cwd: "/Users/a/three" }],
    ])
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]).toEqual(["lsof", ["-a", "-p", "20,40,50", "-d", "cwd", "-Fn"]])
  })

  it("leaves shells and background agents unidentified and does not probe absent ttys", async () => {
    const run = vi.fn(async () => "1 0 1 2 ttys001 /opt/claude\n2 0 2 2 ttys001 /bin/zsh")
    expect(await identifyTerminalProcesses([], run)).toEqual(new Map())
    expect(run).not.toHaveBeenCalled()
    expect(await identifyTerminalProcesses(["ttys001"], run)).toEqual(new Map())
    expect(run).toHaveBeenCalledOnce()
  })

  it("keeps a known foreground agent when its cwd cannot be read", async () => {
    const run = vi.fn(async (command: string) => command === "ps" ? "20 1 20 20 ttys001 copilot" : "n/unbound\np99\nn/not-the-agent\np20\nfcwd\n")
    expect(await identifyTerminalProcesses(["ttys001"], run)).toEqual(new Map([["ttys001", { agent: "Copilot", cwd: null }]]))
    run.mockImplementation(async (command: string) => {
      if (command === "lsof") throw new Error("process exited")
      return "20 1 20 20 ttys001 copilot"
    })
    expect(await identifyTerminalProcesses(["ttys001"], run)).toEqual(new Map([["ttys001", { agent: "Copilot", cwd: null }]]))
  })

  it("reports a failed process lookup without inventing an identity", async () => {
    expect(await identifyTerminalProcesses(["ttys001"], async () => { throw new Error("ps unavailable") })).toEqual(new Map())
  })

  it("runs the real bounded process lookup", async () => {
    expect(await identifyTerminalProcesses(["ouro-test-no-tty"])).toEqual(new Map())
  })
})
