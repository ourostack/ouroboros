import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isPostToolUseHook, POST_TOOL_USE_QUIET_MS, POST_TOOL_USE_SEND_TIMEOUT_MS, runPostToolUseHook, type PostToolUseDeps,
} from "../../../heart/daemon/hook-post-tool-use"

describe("isPostToolUseHook", () => {
  it("is exactly hook post-tool-use --agent <agent>", () => {
    expect(isPostToolUseHook(["hook", "post-tool-use", "--agent", "hook-standin"])).toBe(true)
    expect(isPostToolUseHook(["hook", "session-start", "--agent", "hook-standin"])).toBe(false)
    expect(isPostToolUseHook(["hook", "post-tool-use", "--agent"])).toBe(false)
    expect(isPostToolUseHook(["hook", "post-tool-use", "--agent", "a b"])).toBe(false)
    expect(isPostToolUseHook(["hook", "post-tool-use", "--agent", "x", "--extra"])).toBe(false)
    expect(isPostToolUseHook(["hook", "post-tool-use", "--to", "x"])).toBe(false)
  })
})

describe("runPostToolUseHook", () => {
  let dir: string
  let socket: string
  let now: number
  let out: string[]
  let send: ReturnType<typeof vi.fn>
  const deps = (input: string): PostToolUseDeps => ({
    readStdin: () => input, writeStdout: (t) => { out.push(t) }, socketPath: socket,
    stampDir: path.join(dir, "stamps"), now: () => now, send,
  })
  const event = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "standin-session", tool_name: "Bash", ...extra })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-ptu-"))
    socket = path.join(dir, "daemon.sock")
    fs.writeFileSync(socket, "")
    now = 1_000_000_000_000
    out = []
    send = vi.fn(async () => ({ ok: true }))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("sends the note the CLI sent, once per session in each quiet window, and always answers continue", async () => {
    expect(await runPostToolUseHook("hook-standin", deps(event()))).toBe("sent")
    expect(send).toHaveBeenCalledWith(socket, {
      kind: "message.send", from: "claude-code:standin-session", to: "hook-standin",
      content: "[Claude Code used Bash in session standin-session]",
    }, { timeoutMs: POST_TOOL_USE_SEND_TIMEOUT_MS })
    now += POST_TOOL_USE_QUIET_MS - 1
    expect(await runPostToolUseHook("hook-standin", deps(event()))).toBe("quiet")
    expect(await runPostToolUseHook("hook-standin", deps(event({ session_id: "another" })))).toBe("sent")
    expect(await runPostToolUseHook("other-agent", deps(event()))).toBe("sent")
    now += 1
    expect(await runPostToolUseHook("hook-standin", deps(event()))).toBe("sent")
    expect(send).toHaveBeenCalledTimes(4)
    expect(out).toEqual(Array(5).fill('{"continue":true}'))
  })

  it("skips a subagent's tool call, and a session with no daemon, without a send", async () => {
    expect(await runPostToolUseHook("hook-standin", deps(event({ agent_id: "sub-1" })))).toBe("subagent")
    fs.rmSync(socket)
    expect(await runPostToolUseHook("hook-standin", deps(event()))).toBe("no-daemon")
    expect(send).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(dir, "stamps"))).toBe(false)
    expect(out).toEqual(['{"continue":true}', '{"continue":true}'])
  })

  it("answers continue when the input is malformed or the send fails, and names an unknown session", async () => {
    send.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    expect(await runPostToolUseHook("hook-standin", deps("not json"))).toBe("send-failed")
    expect(send.mock.calls[0][1]).toMatchObject({ from: "claude-code:unknown", content: "[Claude Code used  in session unknown]" })
    expect(await runPostToolUseHook("hook-standin", deps("[1]"))).toBe("quiet")
    expect(out).toHaveLength(2)
  })

  it("sends again when it can't write the stamp", async () => {
    fs.writeFileSync(path.join(dir, "stamps"), "a file, not a folder")
    expect(await runPostToolUseHook("hook-standin", deps(event()))).toBe("sent")
    expect(await runPostToolUseHook("hook-standin", deps(event()))).toBe("sent")
  })
})
