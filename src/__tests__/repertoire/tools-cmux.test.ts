import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import { emptyCmuxState, writeCmuxState } from "../../senses/cmux/attention"
import type { ToolContext } from "../../repertoire/tools-base"
import { cmuxOverviewToolDefinition, cmuxReadToolDefinition, cmuxSignalToolDefinition, cmuxToolsEnabled } from "../../repertoire/tools-cmux"
import { startFakeCmux, type FakeCmux } from "../senses/cmux/fake-cmux"

const AGENT = "cmuxtools"
let root = ""
let server: FakeCmux

const tree = {
  windows: [{
    id: "W-1",
    workspaces: [
      { id: "WS-1", ref: "workspace:1", title: "ouroboros", selected: true, panes: [{ surfaces: [{ id: "SF-1", ref: "surface:1", title: "claude", type: "terminal" }, { id: "SF-2", ref: "surface:2", title: "zsh", type: "terminal" }] }] },
      { id: "WS-2", ref: "workspace:2", title: "desk", panes: [{}, "junk"] },
    ],
  }, {}],
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { agentName: AGENT, agentRoot: root, signin: async () => undefined, ...overrides } as ToolContext
}

async function call(definition: typeof cmuxReadToolDefinition, args: Record<string, unknown>, context: ToolContext | "none" = ctx()): Promise<Record<string, unknown>> {
  return JSON.parse(await definition.handler(args as Record<string, string>, context === "none" ? undefined : context)) as Record<string, unknown>
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-tools-"))
  server = await startFakeCmux({ capability: "v1.t.s" })
  cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.t.s", socketPath: server.socketPath } })
  server.respond("system.tree", () => tree)
})

afterEach(async () => {
  await server.close()
  resetRuntimeCredentialConfigCache()
  fs.rmSync(root, { recursive: true, force: true })
})

describe("cmux tool gate", () => {
  it("offers the tools only when agent.json turns the cmux sense on", () => {
    expect(cmuxToolsEnabled(undefined)).toBe(false)
    expect(cmuxToolsEnabled(root)).toBe(false)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { cmux: { enabled: false } } }))
    expect(cmuxToolsEnabled(root)).toBe(false)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { cmux: { enabled: true } } }))
    expect(cmuxToolsEnabled(root)).toBe(true)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({}))
    expect(cmuxToolsEnabled(root)).toBe(false)
  })
})

describe("cmux tool selection", () => {
  it("adds the cmux tools to an agent's menu only when its cmux sense is on", async () => {
    const { selectToolsForChannel } = await import("../../repertoire/tools")
    const names = () => selectToolsForChannel(undefined, undefined, undefined, undefined, undefined, undefined, { agentName: AGENT, agentRoot: root })
      .ordinary.map((definition) => definition.tool.function.name).filter((name) => name.startsWith("cmux_"))
    expect(names()).toEqual([])
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { cmux: { enabled: true } } }))
    expect(names()).toEqual(["cmux_overview", "cmux_read", "cmux_signal"])
  })
})

describe("cmux_overview", () => {
  it("lists who is waiting on the human and what each terminal's agent last did", async () => {
    const state = emptyCmuxState("2026-10-10T20:00:00.000Z")
    state.connected = true
    state.surfaces["SF-1"] = { workspaceId: "WS-1", agent: "claude", sessionId: "claude-s1", cwd: "/repo", lifecycle: "waiting", lastHook: "PermissionRequest", lastTool: "Bash", at: "2026-10-10T19:59:00.000Z" }
    writeCmuxState(path.join(root, "state", "senses", "cmux", "state.json"), state)
    server.respond("feed.list", () => ({
      items: [
        { kind: "permissionRequest", status: "pending", request_id: "r1", source: "claude", tool_name: "Bash", cwd: "/repo", workstream_id: "claude-s1", created_at: "t", tool_input: `{"command":"curl -H 'Authorization: Bearer abcdefgh123' x"}` },
        { kind: "question", status: "pending", request_id: "r2", source: "codex", workstream_id: "other" },
        { kind: "permissionRequest", status: "pending", request_id: "r3", source: "claude", tool_input: "x".repeat(700) },
        { kind: "permissionRequest", status: "pending", request_id: "r4", source: "claude", tool_input: "short", tool_input_truncated: true },
      ],
    }))

    const result = await call(cmuxOverviewToolDefinition, {})

    expect(result.sense).toEqual({ connected: true, lastError: null })
    const waiting = result.waitingOnHuman as Array<Record<string, unknown>>
    expect(waiting[0]).toMatchObject({ requestId: "r1", kind: "permissionRequest", agent: "claude", tool: "Bash", workspace: "workspace:1", surface: "surface:1", requestTruncated: false })
    expect(waiting[0]!.request).toContain("Bearer [redacted]")
    expect(waiting[1]).toMatchObject({ requestId: "r2", workspace: null, surface: null, request: null, requestTruncated: false })
    expect(waiting[2]).toMatchObject({ requestTruncated: true })
    expect((waiting[2]!.request as string).length).toBe(600)
    expect(waiting[3]).toMatchObject({ request: "short", requestTruncated: true })
    const workspaces = result.workspaces as Array<{ ref: string; selected: boolean; surfaces: Array<Record<string, unknown>> }>
    expect(workspaces.map((workspace) => [workspace.ref, workspace.selected, workspace.surfaces.length])).toEqual([["workspace:1", true, 2], ["workspace:2", false, 0]])
    expect(workspaces[0]!.surfaces[0]).toMatchObject({ ref: "surface:1", agent: "claude", lifecycle: "waiting", lastTool: "Bash", cwd: "/repo" })
    expect(workspaces[0]!.surfaces[1]).toEqual({ ref: "surface:2", title: "zsh", type: "terminal" })
    expect(server.methods.find((entry) => entry.method === "system.tree")!.params).toEqual({ all_windows: true })
    expect(server.methods.find((entry) => entry.method === "feed.list")!.params).toEqual({ pending_only: true })
  })

  it("tolerates an empty tree and reports socket failures as errors", async () => {
    server.respond("system.tree", () => ({ windows: "nope" }))
    server.respond("feed.list", () => ({}))
    expect(await call(cmuxOverviewToolDefinition, {})).toMatchObject({ waitingOnHuman: [], workspaces: [], sense: { connected: false } })
    server.respond("feed.list", () => { throw new Error("feed broke") })
    expect(await call(cmuxOverviewToolDefinition, {})).toEqual({ error: "feed broke" })
  })

  it("names the repair when this machine has no cmux credential, and needs an agent runtime", async () => {
    resetRuntimeCredentialConfigCache()
    expect(String((await call(cmuxOverviewToolDefinition, {})).error)).toContain("ouro vault config set --agent cmuxtools --scope machine --key cmux.socketCapability")
    expect(await call(cmuxOverviewToolDefinition, {}, "none")).toEqual({ error: "the cmux tools need an agent runtime" })
    expect(await call(cmuxOverviewToolDefinition, {}, ctx({ agentRoot: undefined }))).toEqual({ error: "the cmux tools need an agent runtime" })
  })
})

describe("cmux_read", () => {
  it("reads a terminal with bounded lines and redacted secrets", async () => {
    server.respond("surface.read_text", (params) => ({ text: `line one\nexport TOKEN=abc123 and ${String(params.surface_id)}`, surface_ref: "surface:1", workspace_ref: "workspace:1" }))
    const result = await call(cmuxReadToolDefinition, { surface: " surface:1 ", lines: 9999, scrollback: true })
    expect(result).toEqual({ surface: "surface:1", workspace: "workspace:1", text: "line one\nexport TOKEN=[redacted] and surface:1", truncated: false })
    expect(server.methods.at(-1)!.params).toEqual({ surface_id: "surface:1", lines: 400, scrollback: true })

    await call(cmuxReadToolDefinition, { surface: "SF-1", lines: "0", scrollback: "true" })
    expect(server.methods.at(-1)!.params).toEqual({ surface_id: "SF-1", lines: 1, scrollback: true })
    await call(cmuxReadToolDefinition, { surface: "SF-1", lines: "lots" })
    expect(server.methods.at(-1)!.params).toEqual({ surface_id: "SF-1", lines: 60, scrollback: false })
  })

  it("keeps the newest text when the screen is too long and falls back to the asked surface", async () => {
    server.respond("surface.read_text", () => ({ text: `${"a".repeat(16_000)}END` }))
    const result = await call(cmuxReadToolDefinition, { surface: "surface:9", lines: 12.7 })
    expect(result).toMatchObject({ surface: "surface:9", workspace: null, truncated: true })
    expect((result.text as string).endsWith("END")).toBe(true)
    expect((result.text as string).length).toBe(16_000)
    server.respond("surface.read_text", () => ({}))
    expect(await call(cmuxReadToolDefinition, { surface: "surface:9" })).toMatchObject({ text: "", truncated: false })
  })

  it("rejects a missing surface and reports failures", async () => {
    expect(await call(cmuxReadToolDefinition, {})).toEqual({ error: "name a surface ref or id from cmux_overview" })
    expect(await call(cmuxReadToolDefinition, { surface: "surface:1" }, "none")).toEqual({ error: "the cmux tools need an agent runtime" })
    server.respond("surface.read_text", () => { throw new Error("Surface not found") })
    expect(await call(cmuxReadToolDefinition, { surface: "surface:404" })).toEqual({ error: "Surface not found" })
  })
})

describe("cmux_signal", () => {
  it("sets and clears this agent's workspace status with safe quoting", async () => {
    const commands: string[] = []
    server.v1((line) => { commands.push(line); return "OK" })
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:1", status: ` needs you: "push" \\ ok ` })).toEqual({ workspace: "workspace:1", done: ["status set"] })
    expect(await call(cmuxSignalToolDefinition, { workspace: "WS-1", status: "" })).toEqual({ workspace: "workspace:1", done: ["status cleared"] })
    expect(commands).toEqual([
      `set_status ouro "needs you: \\"push\\" \\\\ ok" --tab=WS-1`,
      "clear_status ouro --tab=WS-1",
    ])
  })

  it("posts a notification tied to the workspace", async () => {
    server.respond("notification.create", () => ({ ok: true }))
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:2", notify_title: "Ari", notify_body: "two sessions need you" })).toEqual({ workspace: "workspace:2", done: ["notification sent"] })
    expect(server.methods.at(-1)).toEqual({ method: "notification.create", params: { title: "Ari", subtitle: "", body: "two sessions need you", workspace_id: "WS-2" } })
    server.v1(() => "OK")
    await call(cmuxSignalToolDefinition, { workspace: "workspace:2", status: "x", notify_title: "t" })
    expect(server.methods.at(-1)!.params).toMatchObject({ body: "" })
  })

  it("validates its input before touching cmux", async () => {
    expect(await call(cmuxSignalToolDefinition, { status: "x" })).toEqual({ error: "name a workspace ref or id from cmux_overview" })
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:1" })).toEqual({ error: "give a status, a notify_title, or both" })
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:1", status: "x".repeat(121) })).toEqual({ error: "status must be one line of at most 120 characters" })
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:1", status: "a\nb" })).toEqual({ error: "status must be one line of at most 120 characters" })
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:1", status: "x" }, "none")).toEqual({ error: "the cmux tools need an agent runtime" })
    expect(server.methods).toEqual([])
  })

  it("reports an unknown workspace and command failures", async () => {
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:9", status: "x" })).toEqual({ error: "no cmux workspace workspace:9; see cmux_overview" })
    server.v1(() => "ERROR: Tab not found")
    expect(await call(cmuxSignalToolDefinition, { workspace: "workspace:1", status: "x" })).toEqual({ error: "ERROR: Tab not found" })
  })

  it("declares its risk and summary keys", () => {
    expect(cmuxSignalToolDefinition.riskProfile).toMatchObject({ mutates: "external_side_effect", risk: "high" })
    expect(cmuxOverviewToolDefinition.riskProfile).toEqual({ mutates: "none", risk: "low" })
    expect(cmuxReadToolDefinition.summaryKeys).toEqual(["surface"])
  })
})
