import { describe, expect, it, vi } from "vitest"
import { identifyTerminalProcesses } from "../../../senses/shepherd/terminal-process"

describe("terminal foreground identity", () => {
  it("binds a unique current foreground PID to its start time, never a PID alone", async () => {
    let start = "Thu Oct 15 23:00:00 2026"
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "lsof") return "p20\nn/synthetic\n"
      if (args[0] === "-axo") return "20 1 20 20 ttys001 copilot"
      return `20 1 20 20 ttys001 ${start} copilot`
    })
    expect((await identifyTerminalProcesses(["ttys001"], run)).get("ttys001")?.instance).toBe("20:Thu Oct 15 23:00:00 2026")
    start = "Thu Oct 15 23:01:00 2026"
    expect((await identifyTerminalProcesses(["ttys001"], run)).get("ttys001")?.instance).toBe("20:Thu Oct 15 23:01:00 2026")
    expect(run.mock.calls.filter(([command, args]) => command === "ps" && args.includes("pid=,ppid=,pgid=,tpgid=,tty=,lstart=,comm="))).toHaveLength(2)
  })

  it.each(["", "junk", "20 1 20 20 ttys002 Thu Oct 15 23:00:00 2026 copilot", "20 1 20 21 ttys001 Thu Oct 15 23:00:00 2026 copilot",
    "20 1 20 20 ttys001 Thu Oct 15 23:00:00 2026 zsh", "20 2 20 20 ttys001 Thu Oct 15 23:00:00 2026 copilot",
    "20 1 20 20 ttys001 Thu Oct 15 23:00:00 2026 copilot\n20 1 20 20 ttys001 Thu Oct 15 23:00:00 2026 copilot",
  ])("omits an unverified or changed start snapshot (%s)", async snapshot => {
    const run = async (command: string, args: string[]) => command === "lsof" ? "" : args[0] === "-axo" ? "20 1 20 20 ttys001 copilot" : snapshot
    expect((await identifyTerminalProcesses(["ttys001"], run)).get("ttys001")?.instance).toBeUndefined()
  })

  it("keeps presentation but grants no instance to ambiguous roots or cyclic parentage", async () => {
    const run = async (command: string, args: string[]) => command === "lsof" ? "" : args[0] === "-axo"
      ? "20 1 20 20 ttys001 copilot\n21 1 20 20 ttys001 copilot\n30 31 30 30 ttys002 claude\n31 30 30 30 ttys002 claude"
      : "20 1 20 20 ttys001 Thu Oct 15 23:00:00 2026 copilot"
    const identities = await identifyTerminalProcesses(["ttys001", "ttys002"], run)
    expect(identities.get("ttys001")?.instance).toBeUndefined()
    expect(identities.get("ttys002")?.instance).toBeUndefined()
  })
  it("identifies the real Node-hosted Copilot entry script without treating arbitrary Node arguments as an agent", async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === "lsof") return "p20\nn/probe/copilot\n"
      if (args[0] === "-axo") return [
        "20 1 20 20 ttys001 /Users/microsoft/.nvm/versions/node/v22.23.3/bin/node",
        "30 1 30 30 ttys002 /usr/local/bin/node",
        "40 1 40 40 ttys003 node",
      ].join("\n")
      return [
        "20 /Users/microsoft/.nvm/versions/node/v22.23.3/bin/node /Users/microsoft/Library/Caches/copilot/pkg/darwin-arm64/1.0.97/cli-main.js --allow-all",
        "30 node /tmp/server.js --prompt /Users/microsoft/Library/Caches/copilot/pkg/darwin-arm64/1.0.97/cli-main.js",
        "40 node /tmp/copilot/cli-main.js --allow-all",
        "999 node /Users/microsoft/Library/Caches/copilot/pkg/darwin-arm64/1.0.97/cli-main.js",
        "junk",
      ].join("\n")
    })
    expect([...await identifyTerminalProcesses(["ttys001", "ttys002", "ttys003"], run)]).toEqual([
      ["ttys001", { agent: "Copilot", cwd: "/probe/copilot" }],
    ])
  })

  it("preserves native identities if a Node argv lookup fails", async () => {
    const run = async (command: string, args: string[]) => {
      if (command === "lsof") return "p20\nn/native\n"
      if (args[0] !== "-axo") throw new Error("Node process exited")
      return "20 1 20 20 ttys001 /opt/copilot\n30 1 30 30 ttys002 node"
    }
    expect([...await identifyTerminalProcesses(["ttys001", "ttys002"], run)]).toEqual([
      ["ttys001", { agent: "Copilot", cwd: "/native" }],
    ])
  })

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
    expect(run).toHaveBeenCalledTimes(3)
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
