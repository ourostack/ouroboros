import { EventEmitter } from "events"
import React from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

import { claimTerminal, withTerminalHandedOff } from "../../senses/terminal-handoff"
import { TuiStore } from "../../senses/cli/tui-store"

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode
    return this
  })
  setEncoding(): this { return this }
  resume(): this { return this }
  pause(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
}

class FakeStdout extends EventEmitter {
  isTTY = true
  columns = 100
  rows = 60
  writes: string[] = []
  write = (chunk: string): boolean => {
    this.writes.push(chunk)
    return true
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe("withTerminalHandedOff", () => {
  it("runs the prompt directly when no live session owns the terminal", async () => {
    await expect(withTerminalHandedOff(async () => "answer")).resolves.toBe("answer")
  })

  it("suspends the owner before the prompt and resumes it afterwards, even when the prompt fails", async () => {
    const calls: string[] = []
    const release = claimTerminal({
      suspend: async () => { calls.push("suspend") },
      resume: () => { calls.push("resume") },
    })
    try {
      await expect(withTerminalHandedOff(async () => {
        calls.push("prompt")
        return "secret"
      })).resolves.toBe("secret")
      await expect(withTerminalHandedOff(async () => {
        calls.push("failing prompt")
        throw new Error("not a terminal")
      })).rejects.toThrow("not a terminal")
    } finally {
      release()
    }
    expect(calls).toEqual(["suspend", "prompt", "resume", "suspend", "failing prompt", "resume"])

    await withTerminalHandedOff(async () => calls.push("after release"))
    expect(calls.at(-1)).toBe("after release")
  })

  it("only releases the owner that is still registered", async () => {
    const first = { suspend: vi.fn(async () => undefined), resume: vi.fn() }
    const second = { suspend: vi.fn(async () => undefined), resume: vi.fn() }
    const releaseFirst = claimTerminal(first)
    const releaseSecond = claimTerminal(second)
    releaseFirst()
    await withTerminalHandedOff(async () => undefined)
    releaseSecond()
    expect(first.suspend).not.toHaveBeenCalled()
    expect(second.suspend).toHaveBeenCalledTimes(1)
  })
})

describe("createExitOnToolCallExecTool", () => {
  it("ends the session on the exit tool unless its result is rejected", async () => {
    const { createExitOnToolCallExecTool } = await import("../../senses/cli")
    const results: Record<string, string> = {
      complete_adoption: "error: failed to write secrets: vault down",
      write_file: "ok",
    }
    const onExit = vi.fn()
    const execTool = createExitOnToolCallExecTool(
      async (name) => results[name],
      "complete_adoption",
      (result) => !result.startsWith("error:"),
      onExit,
    )

    await expect(execTool("write_file", {})).resolves.toBe("ok")
    await expect(execTool("complete_adoption", {})).resolves.toBe("error: failed to write secrets: vault down")
    expect(onExit).not.toHaveBeenCalled()

    results.complete_adoption = JSON.stringify({ success: true, agentName: "Housesitter" })
    await execTool("complete_adoption", {})
    expect(onExit).toHaveBeenCalledWith(results.complete_adoption)
  })

  it("ends the session on any exit tool result when no check is given", async () => {
    const { createExitOnToolCallExecTool } = await import("../../senses/cli")
    const onExit = vi.fn()
    const execTool = createExitOnToolCallExecTool(async () => "error: nope", "complete_adoption", undefined, onExit)
    await execTool("complete_adoption", {})
    expect(onExit).toHaveBeenCalledWith("error: nope")
  })
})

describe("TUI pause for a hidden terminal prompt", () => {
  it("tracks the paused state in the store and notifies the renderer", () => {
    const store = new TuiStore()
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.paused).toBe(false)
    store.pause()
    expect(store.paused).toBe(true)
    store.resume()
    expect(store.paused).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("stops the spinner and stops reading or echoing keystrokes while paused", async () => {
    const { render } = await import("ink")
    const { OuroTui } = await import("../../senses/cli/ouro-tui")
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const onSubmit = vi.fn()
    const props = {
      agentName: "SerpentGuide",
      model: "test-model",
      completedMessages: [],
      inputHistory: [],
      queuedInputs: [],
      live: {
        streamingText: "",
        loading: true,
        spinnerPhrase: "winding through the files",
        spinnerPhrasePool: ["winding through the files"],
        activeTool: null,
        errorMessage: null,
        kickMessage: null,
        inputSuppressed: false,
      },
      elapsedSeconds: 40,
      contextPercent: 0,
      onSubmit,
      onCtrlC: () => "clear" as const,
      onPopQueue: () => [],
      headerShown: true,
      cwd: "~",
    }
    const instance = render(React.createElement(OuroTui, props), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await settle()
      expect(stdin.listenerCount("data")).toBeGreaterThan(0)
      expect(stdin.isRaw).toBe(true)
      expect(stdout.writes.at(-1)).toContain("winding through the files")

      instance.rerender(React.createElement(OuroTui, { ...props, paused: true }))
      await settle()
      expect(stdin.listenerCount("data")).toBe(0)
      expect(stdin.isRaw).toBe(false)
      const pausedFrame = stdout.writes.at(-1) ?? ""
      expect(pausedFrame).not.toContain("winding through the files")

      const writesBeforeTyping = stdout.writes.length
      for (const key of "Hatch-secret1!") stdin.emit("data", key)
      stdin.emit("data", "\r")
      await settle()
      expect(onSubmit).not.toHaveBeenCalled()
      expect(stdout.writes.slice(writesBeforeTyping).join("")).not.toContain("Hatch-secret1!")

      instance.rerender(React.createElement(OuroTui, { ...props, paused: false }))
      await settle()
      expect(stdin.listenerCount("data")).toBeGreaterThan(0)
      expect(stdin.isRaw).toBe(true)
      expect(stdout.writes.at(-1)).toContain("winding through the files")
      expect(stdout.writes.at(-1)).not.toContain("Hatch-secret1!")
    } finally {
      instance.unmount()
    }
  })
})
