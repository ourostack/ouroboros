import { EventEmitter } from "events"
import { PassThrough } from "stream"
import { describe, expect, it, vi } from "vitest"

import { resolveWorkbenchMcpPath, WorkbenchMcpClient } from "../../../repertoire/coding/workbench-client"

class FakeWorkbenchProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true
    return true
  }
}

describe("Workbench MCP client", () => {
  function clientWithCallToolJson() {
    const client = new WorkbenchMcpClient({
      executablePath: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
      existsSync: () => true,
    })
    return {
      client,
      callToolJson: vi.spyOn(client, "callToolJson"),
      callToolText: vi.spyOn(client, "callToolText"),
    }
  }

  it("prefers an explicit MCP executable before installed app candidates", () => {
    expect(
      resolveWorkbenchMcpPath({
        executablePath: "/custom/OuroWorkbenchMCP",
        homeDir: "/Users/test",
        existsSync: (target) => target === "/custom/OuroWorkbenchMCP",
      }),
    ).toBe("/custom/OuroWorkbenchMCP")
  })

  it("falls back to the user-installed app candidate and fails loudly when none exists", () => {
    const userCandidate = "/Users/test/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP"
    expect(
      resolveWorkbenchMcpPath({
        homeDir: "/Users/test",
        existsSync: (target) => target === userCandidate,
      }),
    ).toBe(userCandidate)

    expect(() => new WorkbenchMcpClient({ homeDir: "/Users/missing", existsSync: () => false })).toThrow(
      "OuroWorkbenchMCP not found",
    )
  })

  it("writes initialize and tools/call JSON-RPC messages to the Workbench MCP process", async () => {
    const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown>; stdin: string }> = []
    let child: FakeWorkbenchProcess | null = null

    const client = new WorkbenchMcpClient({
      executablePath: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
      existsSync: () => true,
      spawnFn: (command, args, options) => {
        child = new FakeWorkbenchProcess()
        const record = { command, args, options, stdin: "" }
        spawned.push(record)
        child.stdin.on("data", (chunk: Buffer) => {
          record.stdin += chunk.toString("utf-8")
        })
        child.stdin.on("finish", () => {
          child?.stdout.write("not-json-yet\n")
          child?.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`)
          child?.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ text: "{\"ok\":true,\"requestId\":\"req-1\"}" }] },
          })}\n`)
        })
        return child as never
      },
    })

    const result = await client.callToolJson<{ ok: boolean; requestId: string }>("workbench_request_action", {
      action: "sendInput",
      entry: "session-1",
      text: "continue",
      appendNewline: true,
      format: "json",
    })

    expect(client.commandPath).toBe("/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP")
    expect(result).toEqual({ ok: true, requestId: "req-1" })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe("/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP")
    expect(spawned[0].args).toEqual([])
    expect(spawned[0].options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"] })
    const messages = spawned[0].stdin.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(messages[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" })
    expect(messages[1]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "workbench_request_action",
        arguments: {
          action: "sendInput",
          entry: "session-1",
          text: "continue",
          appendNewline: true,
          format: "json",
        },
      },
    })
    expect(child?.killed).toBe(true)
  })

  it("rejects MCP tool error responses without hanging the process", async () => {
    let child: FakeWorkbenchProcess | null = null
    const client = new WorkbenchMcpClient({
      executablePath: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
      existsSync: () => true,
      spawnFn: () => {
        child = new FakeWorkbenchProcess()
        child.stdin.on("finish", () => {
          child?.stdout.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { isError: true, content: [{ text: "bad action" }] },
          })}\n`)
        })
        return child as never
      },
    })

    await expect(client.callToolText("workbench_request_action", { action: "sendInput" })).rejects.toThrow("bad action")
    expect(child?.killed).toBe(true)

    const rpcError = new WorkbenchMcpClient({
      executablePath: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
      existsSync: () => true,
      spawnFn: () => {
        const errorChild = new FakeWorkbenchProcess()
        errorChild.stdin.on("finish", () => {
          errorChild.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, error: {} })}\n`)
        })
        return errorChild as never
      },
    })
    await expect(rpcError.callToolText("workbench_status", {})).rejects.toThrow("returned an RPC error")
  })

  it("rejects process startup errors, stderr-only exits, timeouts, and non-JSON tool text", async () => {
    const startupError = new WorkbenchMcpClient({
      executablePath: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
      existsSync: () => true,
      spawnFn: () => {
        const child = new FakeWorkbenchProcess()
        queueMicrotask(() => child.emit("error", new Error("spawn failed")))
        return child as never
      },
    })
    await expect(startupError.callToolText("workbench_status", {})).rejects.toThrow("spawn failed")

    const stderrOnly = new WorkbenchMcpClient({
      executablePath: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
      existsSync: () => true,
      spawnFn: () => {
        const child = new FakeWorkbenchProcess()
        child.stdin.on("finish", () => {
          child.stderr.write("nope\n")
          child.emit("exit", 1, null)
        })
        return child as never
      },
    })
    await expect(stderrOnly.callToolText("workbench_status", {})).rejects.toThrow("nope")

    const timeout = new WorkbenchMcpClient({
      executablePath: "/Applications/Ouro Workbench.app/Contents/MacOS/OuroWorkbenchMCP",
      existsSync: () => true,
      timeoutMs: 1,
      spawnFn: () => new FakeWorkbenchProcess() as never,
    })
    await expect(timeout.callToolText("workbench_status", {})).rejects.toThrow("timed out")

    const nonJson = clientWithCallToolJson()
    nonJson.callToolText.mockResolvedValue("not-json")
    await expect(nonJson.client.callToolJson("workbench_status", {})).rejects.toThrow("non-JSON")
  })

  it("wraps Workbench tools with the expected programmatic JSON arguments", async () => {
    const { client, callToolJson, callToolText } = clientWithCallToolJson()
    callToolJson
      .mockResolvedValueOnce({ queued: true, requestId: "create-1" })
      .mockResolvedValueOnce({ sessions: [{ id: "session-1", name: "coding-codex-task" }] })
      .mockResolvedValueOnce({ ok: true, requestId: "action-1" })
      .mockResolvedValueOnce({ requestId: "action-1", state: "applied", succeeded: true })
    callToolText.mockResolvedValueOnce("tail")

    await expect(client.createSession({ owner: "slugger", name: "task" })).resolves.toEqual({
      queued: true,
      requestId: "create-1",
    })
    await expect(client.listSessions({ owner: "slugger" })).resolves.toEqual([{ id: "session-1", name: "coding-codex-task" }])
    await expect(client.transcriptTail("session-1", 12)).resolves.toBe("tail")
    await expect(client.requestAction({ action: "terminate", entry: "session-1" })).resolves.toEqual({
      ok: true,
      requestId: "action-1",
    })
    await expect(client.actionResult("action-1")).resolves.toEqual({
      requestId: "action-1",
      state: "applied",
      succeeded: true,
    })

    expect(callToolJson).toHaveBeenNthCalledWith(1, "workbench_create_session", {
      owner: "slugger",
      name: "task",
      format: "json",
    })
    expect(callToolJson).toHaveBeenNthCalledWith(2, "workbench_sessions", { owner: "slugger" })
    expect(callToolText).toHaveBeenCalledWith("workbench_transcript_tail", { entry: "session-1", maxBytes: 12 })
    expect(callToolJson).toHaveBeenNthCalledWith(3, "workbench_request_action", {
      action: "terminate",
      entry: "session-1",
      format: "json",
    })
    expect(callToolJson).toHaveBeenNthCalledWith(4, "workbench_action_result", { requestId: "action-1" })
  })

  it("creates a coding session, resolves its Workbench id, and injects the prompt", async () => {
    const { client } = clientWithCallToolJson()
    const createSession = vi.spyOn(client, "createSession").mockResolvedValue({ queued: true, requestId: "create-1" })
    const waitForSession = vi.spyOn(client, "waitForSession").mockResolvedValue({
      id: "session-1",
      name: "coding-codex-task",
      owner: { name: "slugger" },
    })
    const requestAction = vi.spyOn(client, "requestAction").mockResolvedValue({ ok: true, requestId: "prompt-1" })
    const waitForAction = vi.spyOn(client, "waitForAction").mockResolvedValue({
      requestId: "prompt-1",
      state: "applied",
      succeeded: true,
    })

    await expect(
      client.createCodingSession({
        owner: "slugger",
        name: "coding-codex-task",
        command: "codex",
        workingDirectory: "/repo",
        prompt: "please work",
      }),
    ).resolves.toMatchObject({
      session: { id: "session-1" },
      promptResult: { state: "applied" },
    })

    expect(createSession).toHaveBeenCalledWith({
      owner: "slugger",
      name: "coding-codex-task",
      command: "codex",
      workingDirectory: "/repo",
      group: "repo",
      createGroupIfMissing: true,
      trust: "trusted",
      autoResume: true,
      source: "ouro-coding",
    })
    expect(waitForSession).toHaveBeenCalledWith({ owner: "slugger", name: "coding-codex-task", timeoutMs: 10000 })
    expect(requestAction).toHaveBeenCalledWith({
      source: "ouro-coding",
      action: "sendInput",
      entry: "session-1",
      text: "please work",
      appendNewline: true,
    })
    expect(waitForAction).toHaveBeenCalledWith("prompt-1", 10000)
  })

  it("polls session and action results without treating queued actions as success", async () => {
    const { client } = clientWithCallToolJson()
    vi.spyOn(client, "listSessions")
      .mockResolvedValueOnce([{ id: "wrong", name: "other", owner: { name: "slugger" } }])
      .mockResolvedValueOnce([{ id: "session-1", name: "Coding-Codex-Task", owner: {} }])
    await expect(client.waitForSession({ owner: "slugger", name: "coding-codex-task", timeoutMs: 1000 })).resolves.toMatchObject({
      id: "session-1",
    })

    vi.spyOn(client, "actionResult")
      .mockResolvedValueOnce({ requestId: "action-1", state: "queued" })
      .mockResolvedValueOnce({ requestId: "action-1", state: "appliedUnconfirmed", succeeded: true })
    await expect(client.waitForAction("action-1", 1000)).resolves.toMatchObject({ state: "appliedUnconfirmed" })

    vi.spyOn(client, "listSessions").mockResolvedValue([])
    await expect(client.waitForSession({ owner: "slugger", name: "missing", timeoutMs: -1 })).rejects.toThrow(
      "Workbench did not create session",
    )

    vi.spyOn(client, "actionResult").mockResolvedValue({ requestId: "stuck", state: "queued" })
    await expect(client.waitForAction("stuck", -1)).resolves.toEqual({ requestId: "stuck", state: "queued" })
  })
})
