import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"
import { shepherdOverviewToolDefinition, shepherdReadToolDefinition, shepherdSignalToolDefinition, shepherdToolDefinitions, shepherdToolsEnabled } from "../../repertoire/tools-shepherd"
import { appendReturn, type ReturnRecord } from "../../senses/shepherd/returns"
import { startFakeCmux, type FakeCmux } from "../senses/shepherd/fake-cmux"
import { SCREENS, tree } from "../senses/shepherd/fixtures"

const AGENT = "shepherdtools"
let root = ""
let server: FakeCmux

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { agentName: AGENT, agentRoot: root, signin: async () => undefined, ...overrides } as ToolContext
}

async function call(definition: ToolDefinition, args: Record<string, unknown>, context: ToolContext | "none" = ctx()): Promise<Record<string, unknown>> {
  return JSON.parse(await definition.handler(args as Record<string, string>, context === "none" ? undefined : context)) as Record<string, unknown>
}

const record = (overrides: Partial<ReturnRecord>): ReturnRecord => ({ at: "2026-10-10T20:00:00.000Z", host: "cmux", session: "SF-1", transition: "t", agent: "claude", cwd: "/a", task: null, kind: "premature", action: "respond", reason: "r", reply: "Go on.", latencyMs: 1, inputTokens: 1, ...overrides })

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-tools-"))
  server = await startFakeCmux({ capability: "v1.t.s" })
  cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.t.s", socketPath: server.socketPath } })
  server.respond("system.tree", () => tree([{ id: "SF-1", ref: "surface:1", title: "app" }, { id: "SF-2", ref: "surface:2", title: "zsh" }]))
  server.respond("surface.read_text", (params) => ({ text: params.surface_id === "surface:1" ? `${SCREENS.claudePremature}\nghp_${"a".repeat(36)}` : "x".repeat(20_000) }))
  server.respond("notification.create", () => ({}))
})

afterEach(async () => {
  await server.close()
  resetRuntimeCredentialConfigCache()
})

describe("Shepherd tools", () => {
  it("are offered only when agent.json turns Shepherd on", async () => {
    expect(shepherdToolsEnabled(undefined)).toBe(false)
    expect(shepherdToolsEnabled(root)).toBe(false)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled: true } } }))
    expect(shepherdToolsEnabled(root)).toBe(true)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({}))
    expect(shepherdToolsEnabled(root)).toBe(false)
    expect(shepherdToolDefinitions.map((definition) => definition.tool.function.name)).toEqual(["shepherd_overview", "shepherd_read", "shepherd_signal"])
    const { selectToolsForChannel } = await import("../../repertoire/tools")
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled: true } } }))
    expect(selectToolsForChannel(undefined, undefined, undefined, undefined, undefined, undefined, { agentName: AGENT, agentRoot: root })
      .ordinary.map((definition) => definition.tool.function.name).filter((name) => name.startsWith("shepherd_"))).toEqual(["shepherd_overview", "shepherd_read", "shepherd_signal"])
  })

  it("overview lists each terminal with the last return Shepherd judged there", async () => {
    appendReturn(root, record({ transition: "old", reason: "older" }))
    appendReturn(root, record({ transition: "new", kind: "gate", action: "let_through", reason: "needs Ari", reply: null, task: "desk/x" }))
    expect(await call(shepherdOverviewToolDefinition, {})).toEqual({
      host: "cmux",
      sessions: [
        { id: "SF-1", ref: "surface:1", workspace: "workspace:1", title: "app", agent: null, lastReturn: { at: "2026-10-10T20:00:00.000Z", kind: "gate", action: "let_through", reason: "needs Ari", reply: null, task: "desk/x" } },
        { id: "SF-2", ref: "surface:2", workspace: "workspace:1", title: "zsh", agent: null },
      ],
    })
  })

  it("read redacts and bounds the screen", async () => {
    const read = await call(shepherdReadToolDefinition, { session: "surface:1", lines: "9999" })
    expect(read.text).toContain("Want me to go ahead")
    expect(read.text).not.toContain("ghp_")
    expect(server.methods.at(-1)?.params).toMatchObject({ lines: 400 })
    expect(await call(shepherdReadToolDefinition, { session: "surface:2", lines: 0 })).toMatchObject({ truncated: true })
    expect(server.methods.at(-1)?.params).toMatchObject({ lines: 1 })
    await call(shepherdReadToolDefinition, { session: "surface:2", lines: "x" })
    expect(server.methods.at(-1)?.params).toMatchObject({ lines: 60 })
    expect(await call(shepherdReadToolDefinition, { session: " " })).toEqual({ error: "name a session id or ref from shepherd_overview" })
  })

  it("signal sets or clears the status and can notify", async () => {
    expect(await call(shepherdSignalToolDefinition, { session: "surface:1", status: "waiting on Ari", notify_title: "Shepherd", notify_body: "gate" })).toEqual({ session: "surface:1", status: "set", notified: true })
    expect(await call(shepherdSignalToolDefinition, { session: "surface:1", status: "" })).toEqual({ session: "surface:1", status: "cleared", notified: false })
    expect(server.lines.filter((line) => line.includes("_status")).map((line) => line.split(" ").slice(2, 4).join(" "))).toEqual(["set_status ouro", "clear_status ouro"])
    expect(await call(shepherdSignalToolDefinition, { session: "", status: "x" })).toEqual({ error: "name a session id or ref from shepherd_overview" })
    expect(await call(shepherdSignalToolDefinition, { session: "surface:1", status: "a\nb" })).toEqual({ error: "status must be one line of at most 120 characters" })
    expect(await call(shepherdSignalToolDefinition, { session: "surface:9", status: "x" })).toEqual({ error: "no cmux terminal surface:9" })
  })

  it("explain a missing runtime or terminal host", async () => {
    expect(await call(shepherdOverviewToolDefinition, {}, "none")).toEqual({ error: "the Shepherd tools need an agent runtime" })
    resetRuntimeCredentialConfigCache()
    expect((await call(shepherdOverviewToolDefinition, {})).error).toContain("no terminal host is attached on this machine")
  })
})
