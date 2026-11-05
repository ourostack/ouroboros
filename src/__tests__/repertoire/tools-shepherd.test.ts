import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { registerGlobalLogSink, type LogEvent } from "../../nerves"

import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"
import { shepherdOverviewToolDefinition, shepherdReadToolDefinition, shepherdSendToolDefinition, shepherdSignalToolDefinition, shepherdToolDefinitions, shepherdToolsEnabled } from "../../repertoire/tools-shepherd"
import { screenFingerprint } from "../../senses/shepherd/redact"
import * as shepherdHost from "../../senses/shepherd/host"
import { appendReturn, type ReturnRecord } from "../../senses/shepherd/returns"
import { shepherdReturnId } from "../../senses/shepherd/guidance"
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
  fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ displayName: "Ouro" }))
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
  it("attributes requested terminal text to this configured agent instead of a universal name", async () => {
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ displayName: "Orchid One" }))
    for (const method of ["terminal.paste", "surface.send_key"]) server.respond(method, () => ({}))
    const result = await call(shepherdSendToolDefinition, { session: "SF-1", text: "Continue the requested tests." }, ctx({
      context: { friend: { id: "owner", name: "Ari", trustLevel: "family" } } as ToolContext["context"],
    }))
    expect(result.submitted).toEqual({ text: "[Orchid One for Ari] Continue the requested tests." })
  })

  it("are offered only when agent.json turns Shepherd on", async () => {
    expect(shepherdToolsEnabled(undefined)).toBe(false)
    expect(shepherdToolsEnabled(path.join(root, "missing"))).toBe(false)
    expect(shepherdToolsEnabled(root)).toBe(false)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled: true } } }))
    expect(shepherdToolsEnabled(root)).toBe(true)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({}))
    expect(shepherdToolsEnabled(root)).toBe(false)
    expect(shepherdToolDefinitions.map((definition) => definition.tool.function.name)).toEqual([
      "shepherd_overview", "shepherd_read", "shepherd_signal", "shepherd_send",
      "shepherd_history", "shepherd_correct", "shepherd_guidance", "shepherd_update_principle",
      "shepherd_forget_principle", "shepherd_pause", "shepherd_resume",
    ])
    const { selectToolsForChannel } = await import("../../repertoire/tools")
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { shepherd: { enabled: true } } }))
    expect(selectToolsForChannel(undefined, undefined, undefined, undefined, undefined, undefined, { agentName: AGENT, agentRoot: root })
      .ordinary.map((definition) => definition.tool.function.name).filter((name) => name.startsWith("shepherd_"))).toEqual(shepherdToolDefinitions.map(definition => definition.tool.function.name))
  })

  it("overview lists each terminal with the last return Shepherd judged there", async () => {
    server.respond("surface.read_text", params => ({ text: `current ${params.surface_id}` }))
    appendReturn(root, record({ transition: "old", reason: "older" }))
    appendReturn(root, record({ transition: "new", kind: "gate", action: "let_through", reason: "needs Ari", reply: null, task: "desk/x" }))
    expect(await call(shepherdOverviewToolDefinition, {})).toEqual({
      host: "cmux",
      terminalCount: 2,
      sessions: [
        { id: "SF-1", ref: "surface:1", workspace: "workspace:1", workspaceTitle: "app", title: "app", tty: null, cwd: null, agent: null, focused: false, currentScreen: { at: expect.any(String), text: "current SF-1", truncated: false }, lastReturn: { id: shepherdReturnId(record({ transition: "new", kind: "gate", action: "let_through", reason: "needs Ari", reply: null, task: "desk/x" })), at: "2026-10-10T20:00:00.000Z", kind: "gate", action: "let_through", reason: "needs Ari", reply: null, task: "desk/x" } },
        { id: "SF-2", ref: "surface:2", workspace: "workspace:1", workspaceTitle: "app", title: "zsh", tty: null, cwd: null, agent: null, focused: false, currentScreen: { at: expect.any(String), text: "current SF-2", truncated: false } },
      ],
    })
  })

  it("overview reads every current screen rather than presenting an old done judgment as current work", async () => {
    appendReturn(root, record({ kind: "done", action: "let_through", reason: "The earlier task finished." }))
    server.respond("surface.read_text", (params) => ({ text: params.surface_id === "SF-1" ? "Running the new task's tests." : "Waiting for your approval." }))
    const overview = await call(shepherdOverviewToolDefinition, {})
    expect(overview.terminalCount).toBe(2)
    expect(overview.sessions).toEqual([
      expect.objectContaining({
        id: "SF-1",
        currentScreen: { at: expect.any(String), text: "Running the new task's tests.", truncated: false },
        lastReturn: expect.objectContaining({ kind: "done", reason: "The earlier task finished." }),
      }),
      expect.objectContaining({
        id: "SF-2",
        currentScreen: { at: expect.any(String), text: "Waiting for your approval.", truncated: false },
      }),
    ])
    expect(server.methods.filter(m => m.method === "surface.read_text").map(m => m.params)).toEqual([
      { surface_id: "SF-1", lines: 80, scrollback: true },
      { surface_id: "SF-2", lines: 80, scrollback: true },
    ])
  })

  it("overview attaches a real stable historical return id for natural correction", async () => {
    const value = record({ kind: "done", action: "let_through", reply: null })
    appendReturn(root, value)
    const overview = await call(shepherdOverviewToolDefinition, {})
    const sessions = overview.sessions as Array<{ lastReturn?: { id: string } }>
    expect(sessions[0]!.lastReturn!.id).toBe(shepherdReturnId(value))
  })

  it("overview redacts before bounding and removes terminal frame padding from the snapshot", async () => {
    server.respond("surface.read_text", () => ({ text: `╭────╮\n│\n│ Work completed.      │\n│ ghp_${"a".repeat(36)}      │\n╰────╯\n${"x".repeat(5_000)}` }))
    const overview = await call(shepherdOverviewToolDefinition, {})
    const sessions = overview.sessions as Array<{ currentScreen: { text: string; truncated: boolean } }>
    expect(sessions.every(s => s.currentScreen.text.length === 4_000 && s.currentScreen.truncated)).toBe(true)
    server.respond("surface.read_text", () => ({ text: `╭────╮\n│\n│ Work completed.      │\n│ ghp_${"a".repeat(36)}      │\n╰────╯\n` }))
    const compact = (await call(shepherdOverviewToolDefinition, {})).sessions as Array<{ currentScreen: { text: string; truncated: boolean } }>
    expect(compact[0]!.currentScreen).toEqual({ at: expect.any(String), text: " Work completed.\n [redacted]", truncated: false })
    expect(compact.every(s => !s.currentScreen.text.includes("ghp_") && !s.currentScreen.text.includes("─"))).toBe(true)
  })

  it("overview bounds the combined screen payload as the terminal count grows", async () => {
    server.respond("system.tree", () => tree(Array.from({ length: 20 }, (_, i) => ({ id: `SF-${i}`, ref: `surface:${i}` }))))
    server.respond("surface.read_text", () => ({ text: "x".repeat(5_000) }))
    const overview = await call(shepherdOverviewToolDefinition, {})
    const sessions = overview.sessions as Array<{ currentScreen: { text: string } }>
    expect(overview.terminalCount).toBe(20)
    expect(sessions.map(s => s.currentScreen.text.length)).toEqual(Array(20).fill(3_200))
    expect(sessions.reduce((sum, s) => sum + s.currentScreen.text.length, 0)).toBe(64_000)
  })

  it("overview keeps a failed terminal read explicit without dropping other live screens", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    server.respond("surface.read_text", params => {
      if (params.surface_id === "SF-1") throw new Error("terminal is gone")
      return { text: "Still working." }
    })
    try {
      const overview = await call(shepherdOverviewToolDefinition, {})
      expect(overview.sessions).toEqual([
        expect.objectContaining({ id: "SF-1", currentScreen: { at: expect.any(String), error: "terminal is gone" } }),
        expect.objectContaining({ id: "SF-2", currentScreen: { at: expect.any(String), text: "Still working.", truncated: false } }),
      ])
      expect(events).toContainEqual(expect.objectContaining({ event: "repertoire.shepherd_overview_read_error", level: "warn" }))
    } finally {
      unregister()
    }
    server.respond("system.tree", () => tree([]))
    expect(await call(shepherdOverviewToolDefinition, {})).toEqual({ host: "cmux", terminalCount: 0, sessions: [] })
  })

  it("overview redacts even a non-Error read rejection in its inline error and warning", async () => {
    const createHost = shepherdHost.createShepherdHost
    const spy = vi.spyOn(shepherdHost, "createShepherdHost").mockImplementation((...args) => {
      const host = createHost(...args)
      host.read = async () => { throw `failed ghp_${"a".repeat(36)}` }
      return host
    })
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      const sessions = (await call(shepherdOverviewToolDefinition, {})).sessions as Array<{ currentScreen: { error: string } }>
      expect(sessions.every(s => s.currentScreen.error === "failed [redacted]")).toBe(true)
      expect(events.filter(e => e.event === "repertoire.shepherd_overview_read_error")).toHaveLength(2)
      expect(JSON.stringify(events)).not.toContain("ghp_")
    } finally {
      spy.mockRestore()
      unregister()
    }
  })

  it("read redacts and bounds the screen", async () => {
    const read = await call(shepherdReadToolDefinition, { session: "surface:1", lines: "9999" })
    expect(read.text).toContain("Want me to go ahead")
    expect(read.text).not.toContain("ghp_")
    expect(read.screen).toBe(screenFingerprint(`${SCREENS.claudePremature}\nghp_${"a".repeat(36)}`))
    expect(server.methods.at(-1)?.params).toMatchObject({ lines: 400 })
    // A short read still takes enough lines for a fingerprint, and shows only the lines asked for.
    expect((await call(shepherdReadToolDefinition, { session: "surface:1", lines: 1 })).text).toBe("[redacted]")
    expect(await call(shepherdReadToolDefinition, { session: "surface:2", lines: 0 })).toMatchObject({ truncated: true })
    expect(server.methods.at(-1)?.params).toMatchObject({ lines: 40 })
    await call(shepherdReadToolDefinition, { session: "surface:2", lines: "x" })
    expect(server.methods.at(-1)?.params).toMatchObject({ lines: 60 })
    expect(await call(shepherdReadToolDefinition, { session: " " })).toEqual({ error: "name a session id or ref from shepherd_overview" })
  })

  it("signal sets or clears the status and can notify", async () => {
    expect(await call(shepherdSignalToolDefinition, { session: "surface:1", status: "waiting on Ari", notify_title: "Shepherd", notify_body: "gate" })).toEqual({ session: "surface:1", status: "set", notified: true })
    expect(await call(shepherdSignalToolDefinition, { session: "surface:1", status: "" })).toEqual({ session: "surface:1", status: "cleared", notified: false })
    expect(server.lines.filter((line) => line.includes("_status")).map((line) => line.split(" ").slice(2, 4).join(" "))).toEqual(["set_status ouro_surface_1", "clear_status ouro_surface_1"])
    expect(await call(shepherdSignalToolDefinition, { session: "", status: "x" })).toEqual({ error: "name a session id or ref from shepherd_overview" })
    expect(await call(shepherdSignalToolDefinition, { session: "surface:1", status: "a\nb" })).toEqual({ error: "status must be one line of at most 120 characters" })
    expect(await call(shepherdSignalToolDefinition, { session: "surface:9", status: "x" })).toEqual({ error: "no cmux terminal surface:9" })
  })

  it("explain a missing runtime or terminal host", async () => {
    expect(await call(shepherdOverviewToolDefinition, {}, "none")).toEqual({ error: "the Shepherd tools need an agent runtime" })
    resetRuntimeCredentialConfigCache()
    expect((await call(shepherdOverviewToolDefinition, {})).error).toContain("no terminal host is attached on this machine")
  })

  it("enforces the bound composer UUID on reads, signals and sends even when its short ref is recycled", async () => {
    const bound = ctx({
      currentShepherdSurface: { id: "SF-1", host: "cmux", label: "original" },
      context: { friend: { id: "friend-ari", name: "Ari", trustLevel: "family" } },
    } as unknown as Partial<ToolContext>)
    server.respond("system.tree", () => tree([{ id: "SF-2", ref: "surface:1", title: "replacement" }]))
    for (const session of ["surface:1", "SF-2", "SF-1"]) {
      for (const [definition, args] of [
        [shepherdReadToolDefinition, { session }],
        [shepherdSignalToolDefinition, { session, status: "changed" }],
        [shepherdSendToolDefinition, { session, text: "continue" }],
      ] as const) {
        expect((await call(definition, args, bound)).error).toMatch(/bound|gone|no cmux terminal/)
      }
    }
    expect(server.methods.filter(entry => ["terminal.paste", "surface.send_key", "surface.send_text", "surface.read_text", "notification.create"].includes(entry.method))).toEqual([])
    expect(server.lines.filter(line => /\b(?:set_status|clear_status)\b/.test(line))).toEqual([])
  })

  it("allows operations on the exact bound UUID but refuses a different host", async () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      const bound = ctx({ currentShepherdSurface: { id: "SF-1", host: "cmux", label: "original" } })
      expect((await call(shepherdReadToolDefinition, { session: "SF-1" }, bound)).text).toBeTruthy()
      expect((await call(shepherdReadToolDefinition, { session: "SF-1" }, { ...bound, currentShepherdSurface: { id: "SF-1", host: "herdr", label: "other host" } } as unknown as ToolContext)).error).toMatch(/host|bound/)
      expect(events).toContainEqual(expect.objectContaining({ event: "senses.shepherd_target_refused", meta: { host: "herdr", session: "SF-1" } }))
    } finally { unregister() }
  })

  describe("send", () => {
    const family = (overrides: Record<string, unknown> = {}): ToolContext => ctx({ context: { friend: { id: "friend-ari", name: "Ari", trustLevel: "family", ...overrides } } } as unknown as Partial<ToolContext>)
    const screen = "Bash command\n  npm test\nDo you want to proceed?\n> 1. Yes\n  2. No\nesc to cancel · 12s"
    let events: LogEvent[] = []
    let unregister = () => {}
    const sends = () => server.methods.filter((entry) => ["terminal.paste", "surface.send_key", "surface.send_text"].includes(entry.method)).map(({ method, params }) => ({ method, key: params.key, text: params.text }))

    beforeEach(() => {
      events = []
      unregister = registerGlobalLogSink((entry) => { if (entry.event.startsWith("repertoire.shepherd_send")) events.push(entry) })
      server.respond("surface.read_text", () => ({ text: screen }))
      for (const method of ["terminal.paste", "surface.send_key", "surface.send_text"]) server.respond(method, () => ({}))
    })
    afterEach(() => unregister())

    it("reports only host submission while a credential gate delays receiver delivery", async () => {
      const pending: string[] = []
      server.respond("terminal.paste", params => { pending.push(params.text as string); return {} })
      server.respond("surface.read_text", () => ({ text: "Waiting for credential access approval." }))
      const result = await call(shepherdSendToolDefinition, { session: "surface:1", text: "Run the requested checks." }, family())
      expect(result).not.toHaveProperty("sent")
      expect(result).toMatchObject({
        submitted: { text: "[Ouro for Ari] Run the requested checks." },
        submission: {
          state: "accepted",
          attemptId: expect.any(String),
          attemptedAt: expect.any(String),
          target: { host: "cmux", id: "SF-1", ref: "surface:1", instance: null },
        },
        verification: { received: "unverified", execution: "unverified", capability: "unverified", progress: "unverified" },
      })
      const original = JSON.stringify(result)
      expect((await call(shepherdReadToolDefinition, { session: "SF-1" })).text).toContain("credential access approval")
      // The isolated receiver releases its queued input later, then reports useful progress.
      server.respond("surface.read_text", () => ({ text: `${pending[0]}\nReceived. Tests passed.` }))
      expect((await call(shepherdReadToolDefinition, { session: "SF-1" })).text).toContain("Tests passed.")
      expect(JSON.stringify(result)).toBe(original)
      server.respond("system.tree", () => tree([{ id: "SF-foreign", ref: "surface:1", title: "replacement" }]))
      expect((await call(shepherdOverviewToolDefinition, {})).sessions).toEqual([
        expect.objectContaining({ id: "SF-foreign", currentScreen: expect.objectContaining({ text: expect.stringContaining("Tests passed.") }) }),
      ])
      expect(result.verification).toEqual({ received: "unverified", execution: "unverified", capability: "unverified", progress: "unverified" })
      expect((result.submission as { target: unknown }).target).toEqual({ host: "cmux", id: "SF-1", ref: "surface:1", instance: null })
      expect(sends()).toHaveLength(2)
      expect(server.lines.some(line => line.includes("submitted for Ari; receipt unverified"))).toBe(true)
    })

    it.each(["terminal.paste", "surface.send_key"])("keeps an uncertain %s attempt instead of claiming non-delivery or retrying", async method => {
      server.respond(method, () => { throw new Error("credential approval timed out") })
      const result = await call(shepherdSendToolDefinition, { session: "surface:1", text: "Run the checks once." }, family())
      expect(result).toMatchObject({
        error: "credential approval timed out",
        attempted: { text: "[Ouro for Ari] Run the checks once." },
        submission: {
          state: "unknown", attemptId: expect.any(String),
          target: { host: "cmux", id: "SF-1", ref: "surface:1", instance: null },
        },
        verification: { received: "unverified", execution: "unverified", capability: "unverified", progress: "unverified" },
        retry: "Do not resend blindly; reconcile this attempt with the exact receiver first.",
      })
      expect(result).not.toHaveProperty("submitted")
      expect(sends().filter(send => send.method === method)).toHaveLength(1)
      expect(events).toContainEqual(expect.objectContaining({
        event: "repertoire.shepherd_send_unknown",
        meta: expect.objectContaining({ attemptId: (result.submission as { attemptId: string }).attemptId, session: "SF-1" }),
      }))
    })

    it("preserves the observed instance and redacts a non-Error key failure without retrying", async () => {
      const createHost = shepherdHost.createShepherdHost
      const spy = vi.spyOn(shepherdHost, "createShepherdHost").mockImplementation((...args) => {
        const host = createHost(...args)
        const list = host.list
        host.list = async () => (await list()).map(session => ({ ...session, instance: "fixture-process:started-before-attempt" }))
        host.key = async () => { throw `timeout ghp_${"a".repeat(36)}` }
        return host
      })
      try {
        const result = await call(shepherdSendToolDefinition, { session: "SF-1", key: "escape" }, family())
        expect(result).toMatchObject({
          error: "timeout [redacted]", attempted: { key: "escape" },
          submission: { state: "unknown", target: { id: "SF-1", instance: "fixture-process:started-before-attempt" } },
        })
        expect(JSON.stringify(result)).not.toContain("ghp_")
        expect(JSON.stringify(events)).not.toContain("ghp_")
        expect(sends()).toEqual([])
      } finally { spy.mockRestore() }
    })

    it("types only for a family member who asked in this conversation", async () => {
      const refusal = { error: "shepherd_send types only for a family member who asked for it in this conversation" }
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "go" }, "none")).toEqual(refusal)
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "go" })).toEqual(refusal)
      for (const trustLevel of ["stranger", "acquaintance", "friend"]) {
        expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "go" }, family({ trustLevel }))).toEqual(refusal)
      }
      // The private runtime's self friend is family, but it is Ouro acting on its own.
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "go" }, family({ id: "self" }))).toEqual(refusal)
      expect(sends()).toEqual([])
      expect(events.map((entry) => [entry.event, entry.meta.friendId])).toEqual([
        ["repertoire.shepherd_send_refused", null], ["repertoire.shepherd_send_refused", null],
        ["repertoire.shepherd_send_refused", "friend-ari"], ["repertoire.shepherd_send_refused", "friend-ari"], ["repertoire.shepherd_send_refused", "friend-ari"],
        ["repertoire.shepherd_send_refused", "self"],
      ])
    })

    it("validates the session, text and key before touching the terminal", async () => {
      const send = (args: Record<string, unknown>) => call(shepherdSendToolDefinition, args, family())
      expect(await send({ session: " ", text: "go" })).toEqual({ error: "name a session id or ref from shepherd_overview" })
      expect(await send({ session: "surface:1" })).toEqual({ error: "give exactly one of text or key" })
      expect(await send({ session: "surface:1", text: "go", key: "enter", screen: "x" })).toEqual({ error: "give exactly one of text or key" })
      expect((await send({ session: "surface:1", key: "ctrl-d" })).error).toBe("key must be one of enter, escape, up, down, tab, ctrl-c, 1, 2, 3, 4, 5, 6, 7, 8, 9, y, n")
      expect(await send({ session: "surface:1", text: "a".repeat(2_001) })).toEqual({ error: "text must be at most 2000 characters" })
      for (const text of ["run\nrm -rf /", "go\u001b[A", "go\tnow", "a\u2028b"]) {
        expect(await send({ session: "surface:1", text })).toEqual({ error: "text must be one line with no control characters; press enter, escape or ctrl-c with key" })
      }
      for (const key of ["enter", "tab", "2", "y", "N"]) {
        expect((await send({ session: "surface:1", key })).error).toContain("can approve or choose on a prompt, so pass screen from a shepherd_read made just before")
      }
      expect(sends()).toEqual([])
      expect(events.every((entry) => entry.event === "repertoire.shepherd_send_refused" && !JSON.stringify(entry.meta).includes("rm -rf"))).toBe(true)
    })

    it("does not double the prefix when the agent already wrote it", async () => {
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "[ouro FOR ari] Ship it." }, family())).toMatchObject({ submitted: { text: "[Ouro for Ari] Ship it." } })
    })

    it("types the human's line with Shepherd's prefix, and audits it without the text", async () => {
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "  Run the tests, then open a PR. token=abc123  " }, family())).toMatchObject({ session: "surface:1", submitted: { text: "[Ouro for Ari] Run the tests, then open a PR. token=abc123" }, focused: false })
      expect(sends()).toEqual([
        { method: "terminal.paste", key: undefined, text: "[Ouro for Ari] Run the tests, then open a PR. token=abc123" },
        { method: "surface.send_key", key: "enter", text: undefined },
      ])
      expect(server.methods.filter((entry) => entry.method === "surface.read_text").at(-1)?.params).toMatchObject({ surface_id: "SF-1", lines: 40 })
      expect(server.lines.some((line) => line.includes("set_status ouro_surface_1 \"submitted for Ari; receipt unverified\""))).toBe(true)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ event: "repertoire.shepherd_send", meta: { session: "SF-1", ref: "surface:1", chars: 43, key: null, friendId: "friend-ari", focused: false, screenChecked: false } })
      expect(JSON.stringify(events[0])).not.toContain("abc123")
    })

    it("presses one key, mapping ctrl-c and checking the screen for keys that choose", async () => {
      const seen = screenFingerprint(screen.replace("12s", "13s"))
      expect(await call(shepherdSendToolDefinition, { session: "SF-1", key: "escape" }, family())).toMatchObject({ session: "surface:1", submitted: { key: "escape" }, focused: false })
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", key: "ctrl-c" }, family())).toMatchObject({ submitted: { key: "ctrl-c" } })
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", key: "1", screen: seen }, family())).toMatchObject({ submitted: { key: "1" } })
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", key: "Enter", screen: seen }, family())).toMatchObject({ submitted: { key: "enter" } })
      expect(sends()).toEqual([
        { method: "surface.send_key", key: "escape", text: undefined },
        { method: "surface.send_key", key: "ctrl+c", text: undefined },
        { method: "surface.send_text", key: undefined, text: "1" },
        { method: "surface.send_key", key: "enter", text: undefined },
      ])
      expect(events.map((entry) => [entry.meta.key, entry.meta.screenChecked])).toEqual([["escape", false], ["ctrl-c", false], ["1", true], ["enter", true]])
    })

    it("sends nothing when the terminal changed since it was read or is gone", async () => {
      const seen = screenFingerprint(screen)
      server.respond("surface.read_text", () => ({ text: `${screen}\nBash command\n  git push --force` }))
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", key: "enter", screen: seen }, family())).toEqual({ error: "the terminal changed since it was read, so nothing was sent; read it again" })
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "yes, go", screen: seen }, family())).toEqual({ error: "the terminal changed since it was read, so nothing was sent; read it again" })
      expect(await call(shepherdSendToolDefinition, { session: "surface:9", text: "go" }, family())).toEqual({ error: "session surface:9 is gone; check shepherd_overview" })
      expect(sends()).toEqual([])
      expect(events.map((entry) => entry.event)).toEqual(["repertoire.shepherd_send_refused", "repertoire.shepherd_send_refused", "repertoire.shepherd_send_refused"])
    })

    it("reports a failed send, and a status line that fails does not undo a send", async () => {
      server.respond("terminal.paste", () => { throw new Error("paste refused") })
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "go" }, family())).toMatchObject({ error: "paste refused", submission: { state: "unknown" } })
      expect(events.map(entry => entry.event)).toEqual(["repertoire.shepherd_send_unknown"])
      server.respond("terminal.paste", () => ({}))
      server.v1(() => "ERROR: status refused")
      expect(await call(shepherdSendToolDefinition, { session: "surface:1", text: "go" }, family())).toMatchObject({ submitted: { text: "[Ouro for Ari] go" }, submission: { state: "accepted" } })
      expect(events.map((entry) => entry.event)).toEqual(["repertoire.shepherd_send_unknown", "repertoire.shepherd_send"])
    })
  })
})
