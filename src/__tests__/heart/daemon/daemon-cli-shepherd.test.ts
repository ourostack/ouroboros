import { describe, expect, it, vi } from "vitest"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { getCommandHelp } from "../../../heart/daemon/cli-help"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

describe("dedicated Shepherd CLI", () => {
  it("uses the daemon frontend lifecycle and launches the independent composer, not chat.connect", async () => {
    let launch: any
    const deps = {
      socketPath: "/tmp/composer-cli.sock",
      sendCommand: async () => { throw new Error("must not dispatch human input") },
      startDaemonProcess: async () => ({ pid: 1 }),
      writeStdout: () => {},
      checkSocketAlive: async () => true,
      cleanupStaleSocket: () => {},
      fallbackPendingMessage: () => "",
      ensureDaemonForFrontend: vi.fn(async () => ({ ok: true })),
      startShepherdChat: async (input: any) => { launch = input },
    } as OuroCliDeps
    await expect(runOuroCli(["shepherd", "chat", "--agent", "ouro"], deps)).resolves.toBe("")
    expect(launch).toEqual({ agent: "ouro", socketPath: "/tmp/composer-cli.sock.frontend" })
    expect(deps.ensureDaemonForFrontend).toHaveBeenCalledWith("ouro")
  })
  it("parses a dedicated chat with an explicit stable target", () => {
    expect(parseOuroCommand(["shepherd", "chat", "--agent", "ouro", "--session", "11111111-1111-4111-8111-111111111111"]))
      .toEqual({ kind: "shepherd.chat", agent: "ouro", session: "11111111-1111-4111-8111-111111111111" })
    expect(parseOuroCommand(["shepherd", "chat", "--agent", "ouro"])).toEqual({ kind: "shepherd.chat", agent: "ouro" })
  })

  it.each([
    ["shepherd"], ["shepherd", "send"], ["shepherd", "chat"],
    ["shepherd", "chat", "--agent"], ["shepherd", "chat", "--agent", "../ouro"],
    ["shepherd", "chat", "--agent", "ouro", "--session", "surface:1"],
    ["shepherd", "chat", "--agent", "ouro", "--friend", "someone"],
    ["shepherd", "chat", "--agent", "ouro", "--agent", "other"],
    ["shepherd", "chat", "--agent", "ouro", "--session"],
  ])("rejects ambiguous or unsafe arguments %j", (...args) => {
    expect(() => parseOuroCommand(args)).toThrow("ouro shepherd chat")
  })

  it("explains the independent composer rather than promising agent input hooks", () => {
    expect(getCommandHelp("shepherd")).toContain("ouro shepherd chat --agent <name> [--session <UUID>]")
    expect(getCommandHelp("shepherd")).toContain("independent")
  })
})
