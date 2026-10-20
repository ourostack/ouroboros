import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCmuxClient } from "../../../senses/shepherd/client"
import { createCmuxNativeInput } from "../../../senses/shepherd/cmux-native"
import { createCmuxHost, type CmuxHostOptions } from "../../../senses/shepherd/cmux"
import type { ReturnedControl, ShepherdHostObservation } from "../../../senses/shepherd/host"
import { ackFrame, startFakeCmux, type FakeCmux } from "./fake-cmux"
import type { ShepherdManagedIdentity } from "../../../heart/shepherd/custody-types"
import { tree } from "./fixtures"

const surface = "11111111-1111-4111-8111-111111111111"
const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const boot = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const eventRevision = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const activityRevision = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const requestId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const profile = "a".repeat(64)
const executable = "b".repeat(64)
const identity = {
  kind: "agent_session", host_instance: boot, workspace_id: workspace, surface_id: surface,
  provider: "copilot", provider_session_id: "owned-provider-session", backend_pid: 314,
  backend_start_seconds: 12345, backend_start_microseconds: 6789, surface_generation: 7,
  executable_sha256: executable, profile_sha256: profile,
}
const expectedIdentity: ShepherdManagedIdentity = {
  kind: "agent_session", hostInstance: boot, workspaceId: workspace, surfaceId: surface,
  provider: "copilot", providerSessionId: "owned-provider-session", backendPid: 314,
  backendStartSeconds: 12345, backendStartMicroseconds: 6789, surfaceGeneration: 7,
  executableSha256: executable, profileSha256: profile,
}
let server: FakeCmux
let clock: number
let raw: string
let capture: Record<string, unknown>
let capabilities: Record<string, unknown>
let panelType: string
let managedReceipt: Record<string, unknown>

function qualify() {
  capabilities.shepherd_managed_input = { protocol_version: 1, state: "qualified", providers: ["copilot"], profiles: [profile] }
}

function host(options: Pick<CmuxHostOptions, "schedule" | "now"> = {}) {
  return createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } }), {
    now: () => clock,
    identifyTerminals: async ttys => {
      if (ttys.length) throw new Error("managed panel must not use TTY enrichment")
      return new Map()
    },
    ...options,
  })
}

beforeEach(async () => {
  clock = 100_000
  panelType = "agentSession"
  raw = "Painted managed task state\napi_key=synthetic-private-value\n"
  capture = {
    protocol_version: 1, host_instance: boot, identity: { ...identity }, cwd: "/native/project",
    screen: raw, screen_fingerprint: hash(raw), render_fingerprint: hash("paint-generation-7"),
    event_revision: eventRevision, activity_revision: activityRevision,
    idle: true, focused: false, composer_empty: true,
    observed_at_uptime_seconds: 123, observed_at_unix_ms: 50_000,
    token: { id: token, expires_at_uptime_seconds: 125 },
  }
  capabilities = {
    shepherd_guarded_input: { protocol_version: 1, state: "unqualified", agents: [],
      qualification_reason: "claude_native_input_attribution_unavailable" },
    shepherd_managed_input: { protocol_version: 1, state: "unqualified", providers: [], profiles: [],
      qualification_reason: "managed_native_runtime_unqualified" },
  }
  server = await startFakeCmux()
  server.respond("system.capabilities", () => capabilities)
  server.respond("system.tree", () => {
    const result = tree([{ id: surface, ref: "surface:1", type: panelType, tty: "untrusted-tree-tty", focused: false }])
    ;(result.windows as Array<{ workspaces: Array<{ id: string }> }>)[0]!.workspaces[0]!.id = workspace
    return result
  })
  server.respond("surface.shepherd.managed.inspect", () => capture)
  managedReceipt = {
    protocol_version: 1, receipt_version: 1, host_instance: boot, request_id: requestId, identity: { ...identity },
    state: "accepted", reason: "provider_acknowledged", editor_inserted: true, backend_write_admitted: true,
    provider_acknowledged: true, provider_input_id: "server-message-42",
  }
  server.respond("surface.shepherd.managed.continue", () => managedReceipt)
  server.respond("surface.shepherd.managed.receipt", () => managedReceipt)
  server.respond("events.stream", () => ackFrame())
})
afterEach(async () => { await server.close() })

describe("cmux managed native observation", () => {
  it("discovers managed qualification separately without erasing the classic blocker", async () => {
    expect(await host().capabilities!()).toEqual({
      state: "unqualified", protocolVersion: 1, agents: [],
      reason: "claude_native_input_attribution_unavailable",
      managed: { state: "unqualified", protocolVersion: 1, providers: [], profiles: [],
        reason: "managed_native_runtime_unqualified" },
    })
  })

  it.each([null, {}, { protocol_version: 2, state: "qualified", providers: ["copilot"], profiles: [profile] },
    { protocol_version: 1, state: "qualified", providers: ["unknown"], profiles: [profile] },
    { protocol_version: 1, state: "qualified", providers: ["copilot"], profiles: ["not-a-hash"] },
    { protocol_version: 1, state: "qualified", providers: [], profiles: [] },
    { protocol_version: 1, state: "qualified", providers: ["copilot"], profiles: [profile],
      qualification_reason: "managed_native_runtime_unqualified" },
  ])("refuses malformed or contradictory managed qualification: %j", async value => {
    capabilities.shepherd_managed_input = value
    await expect(host().capabilities!()).rejects.toThrow(/native Shepherd/i)
  })

  it("keeps managed inventory visible with its real kind, no TTY and no borrowed process identity", async () => {
    const cmux = host()
    expect(await cmux.list()).toMatchObject([{ id: surface, kind: "agent_session", tty: null, agent: null, cwd: null }])
    expect(await cmux.retirementInventory!()).toEqual([surface])
  })

  it("uses managed native identity and canonical CWD, hashes painted raw text before redaction", async () => {
    const value = await host().inspect!(surface)
    expect(value).toMatchObject({
      session: { id: surface, kind: "agent_session", agent: "copilot", cwd: "/native/project", tty: null },
      screen: "Painted managed task state\napi_key=[redacted]\n", screenFingerprint: hash(raw),
      activity: "idle", composer: "empty", backgroundWork: false,
      managed: { identity: expectedIdentity, eventRevision, activityRevision,
        renderFingerprint: hash("paint-generation-7"), token },
    })
    expect(value.guarded).toBeUndefined()
    expect(value.instance).toContain("agent_session")
    expect(value.instance).not.toBe("314:12345")
    expect(value.session.instance).toBe(value.instance)
    expect(value.managed!.expiresAtUnixMs).toBeGreaterThan(clock + 1_500)
    expect(value.managed!.expiresAtUnixMs).toBeLessThanOrEqual(clock + 2_000)
    expect(server.methods.find(call => call.method === "surface.shepherd.managed.inspect")!.params)
      .toEqual({ workspace_id: workspace, surface_id: surface })
    expect(server.methods.some(call => ["surface.read_text", "surface.shepherd.inspect"].includes(call.method))).toBe(false)
  })

  it.each(["absent", "unsupported"])("never falls back to classic observation for %s managed discovery", async state => {
    if (state === "absent") delete capabilities.shepherd_managed_input
    else capabilities.shepherd_managed_input = { protocol_version: 2, state: "unqualified", providers: [], profiles: [] }
    await expect(host().inspect!(surface)).rejects.toThrow(/managed|Shepherd/i)
    expect(server.methods.some(call => ["surface.read_text", "surface.shepherd.inspect"].includes(call.method))).toBe(false)
  })

  it.each([
    { identity: { ...identity, workspace_id: token } },
    { identity: { ...identity, host_instance: token } },
    { identity: { ...identity, backend_pid: 0 } },
    { identity: { ...identity, provider_session_id: " " } },
    { identity: { ...identity, provider_session_id: "x".repeat(257) } },
    { identity: { ...identity, backend_start_microseconds: 1_000_000 } },
    { identity: { ...identity, surface_generation: Number.MAX_SAFE_INTEGER + 1 } },
    { identity: { ...identity, profile_sha256: "not-a-digest" } },
    { protocol_version: 2 }, { host_instance: "not-a-host" },
    { cwd: null }, { cwd: "relative/project" }, { cwd: "/native/project/../other" }, { screen: "different painted text" },
    { event_revision: "not-a-revision" }, { activity_revision: null }, { render_fingerprint: "" },
    { idle: null }, { focused: null }, { composer_empty: null },
    { token: {} }, { token: { id: "bad-token", expires_at_uptime_seconds: 125 } },
    { token: { id: token, expires_at_uptime_seconds: "125" } },
  ])("rejects malformed or cross-target managed evidence without a classic fallback: %j", async patch => {
    Object.assign(capture, patch)
    await expect(host().inspect!(surface)).rejects.toThrow(/native Shepherd/i)
    expect(server.methods.some(call => ["surface.read_text", "surface.shepherd.inspect"].includes(call.method))).toBe(false)
  })

  it.each(["claude", "codex"])("retains the real %s provider identity without borrowing Copilot qualification", async provider => {
    capture.identity = { ...identity, provider }
    const cmux = host()
    const value = await cmux.inspect!(surface)
    expect(value.session.agent).toBe(provider)
    expect(value.managed!.identity.provider).toBe(provider)
    expect(await cmux.continueInput!({ requestId, expected: value, text: "Continue." }, () => true))
      .toMatchObject({ state: "not_sent" })
    expect(server.methods.some(call => call.method.includes(".continue"))).toBe(false)
  })

  it.each(["workspace", "surface"])("rejects matching but malformed %s UUIDs at the native transport seam", async field => {
    capture.identity = { ...identity, [field === "workspace" ? "workspace_id" : "surface_id"]: "not-a-uuid" }
    const native = createCmuxNativeInput(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } }), () => clock)
    await expect(native.inspectManaged({
      id: field === "surface" ? "not-a-uuid" : surface, ref: "surface:1", workspace: null,
      title: "", agent: null, kind: "agent_session", focused: false,
    }, field === "workspace" ? "not-a-uuid" : workspace)).rejects.toThrow(/native Shepherd/i)
  })

  it.each([{ idle: false }, { focused: true }, { composer_empty: false },
    { token: null }, { token: { id: token, expires_at_uptime_seconds: 123 } },
    { token: { id: token, expires_at_uptime_seconds: 126 } },
  ])("withholds managed input authority when readiness or the native lease is unavailable: %j", async patch => {
    Object.assign(capture, patch)
    expect(await host().inspect!(surface)).toMatchObject({ managed: { token: null, expiresAtUnixMs: null } })
  })

  it("does not upgrade a classic terminal merely because managed methods are advertised", async () => {
    panelType = "terminal"
    await expect(host().inspect!(surface)).rejects.toThrow()
    expect(server.methods.some(call => call.method === "surface.shepherd.managed.inspect")).toBe(false)
    expect(server.methods.some(call => call.method === "surface.shepherd.inspect")).toBe(true)
  })

  it("does not inspect or write to an absent native target", async () => {
    server.respond("system.tree", () => tree([]))
    await expect(host().inspect!(surface)).rejects.toThrow(/disappeared/i)
    expect(server.methods.some(call => call.method.startsWith("surface."))).toBe(false)
  })

  it("rejects a legacy presentation handle before a conditional classic write can be attempted", async () => {
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    await expect(cmux.promptIfUnchanged!("surface:1", "Continue.", expected, () => true)).rejects.toThrow(/UUID/i)
    expect(server.methods.some(call => ["terminal.paste", "surface.send_key"].includes(call.method))).toBe(false)
  })

  it("dispatches only the separately qualified managed operation with exact native stage evidence", async () => {
    qualify()
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue this authorized task." }, () => true))
      .toEqual({ state: "sent", receipt: {
        kind: "agent_session", receiptVersion: 1, requestId, nativeRequestId: requestId,
        identity: expectedIdentity, state: "accepted", reason: "provider_acknowledged",
        editorInserted: true, backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "server-message-42",
      } })
    expect(server.methods.filter(call => call.method === "surface.shepherd.managed.continue").map(call => call.params))
      .toEqual([{ request_id: requestId, token, text: "Continue this authorized task." }])
    expect(server.methods.some(call => ["surface.shepherd.continue", "terminal.paste", "surface.send_key", "surface.send_text"].includes(call.method))).toBe(false)
  })

  it.each(["copied", "mutated", "expired", "unqualified", "provider", "profile", "guard"])(
    "admits no input for invalid managed %s authority", async failure => {
      qualify()
      const cmux = host()
      let expected = await cmux.inspect!(surface)
      if (failure === "copied") expected = structuredClone(expected)
      if (failure === "mutated") expected.managed!.identity.backendStartMicroseconds++
      if (failure === "expired") clock += 2_001
      if (failure === "unqualified") capabilities.shepherd_managed_input = {
        protocol_version: 1, state: "unqualified", providers: [], profiles: [],
      }
      if (failure === "provider") capabilities.shepherd_managed_input = {
        protocol_version: 1, state: "qualified", providers: ["claude"], profiles: [profile],
      }
      if (failure === "profile") capabilities.shepherd_managed_input = {
        protocol_version: 1, state: "qualified", providers: ["copilot"], profiles: ["c".repeat(64)],
      }
      expect(await cmux.continueInput!({ requestId, expected, text: "Continue the task." }, () => failure !== "guard"))
        .toMatchObject({ state: "not_sent" })
      expect(server.methods.some(call => call.method.includes(".continue"))).toBe(false)
    })

  it("holds an inserted editor without an exact provider ACK as unknown, not as a terminal paste", async () => {
    qualify()
    managedReceipt = { ...managedReceipt, state: "unknown", reason: "provider_ack_pending",
      provider_acknowledged: false, provider_input_id: null }
    const cmux = host()
    expect(await cmux.continueInput!({ requestId, expected: await cmux.inspect!(surface), text: "Continue." }, () => true))
      .toMatchObject({ state: "unknown", receipt: {
        kind: "agent_session", editorInserted: true, backendWriteAdmitted: true, providerAcknowledged: false, providerInputId: null,
      } })
  })

  it.each([
    { receipt_version: 2 }, { host_instance: token }, { request_id: token },
    { identity: { ...identity, provider_session_id: "foreign-session" } },
    { identity: { ...identity, backend_start_microseconds: 6790 } },
    { identity: { ...identity, executable_sha256: "c".repeat(64) } },
    { editor_inserted: false }, { backend_write_admitted: false }, { provider_acknowledged: false },
    { provider_input_id: null }, { state: "not_sent" }, { state: "unknown" },
  ])("holds malformed or cross-identity managed receipts without retrying input: %j", async patch => {
    qualify()
    Object.assign(managedReceipt, patch)
    const cmux = host()
    await expect(cmux.continueInput!({ requestId, expected: await cmux.inspect!(surface), text: "Continue." }, () => true))
      .rejects.toThrow(/unknown/i)
    expect(server.methods.filter(call => call.method === "surface.shepherd.managed.continue")).toHaveLength(1)
    expect(server.methods.filter(call => call.method === "surface.shepherd.managed.receipt")).toHaveLength(1)
    expect(server.methods.some(call => call.method === "surface.shepherd.continue")).toBe(false)
  })

  it.each(["unknown", "not_sent"])("retains a native %s receipt without manufacturing unproved editor effects", async state => {
    qualify()
    managedReceipt = { ...managedReceipt, state, editor_inserted: false, backend_write_admitted: false,
      provider_acknowledged: false, provider_input_id: null, reason: "editor_insertion_unproven" }
    const cmux = host()
    expect(await cmux.continueInput!({ requestId, expected: await cmux.inspect!(surface), text: "Continue." }, () => true))
      .toMatchObject({ state, receipt: { kind: "agent_session", editorInserted: false, backendWriteAdmitted: false,
        providerAcknowledged: false, providerInputId: null } })
  })

  it("uses a single exact receipt read after a lost response, never a second managed write", async () => {
    qualify()
    server.respond("surface.shepherd.managed.continue", () => ({ __raw: "malformed reply" }))
    const cmux = host()
    expect(await cmux.continueInput!({ requestId, expected: await cmux.inspect!(surface), text: "Continue." }, () => true))
      .toMatchObject({ state: "sent", receipt: { kind: "agent_session", providerInputId: "server-message-42" } })
    expect(server.methods.filter(call => call.method === "surface.shepherd.managed.continue")).toHaveLength(1)
    expect(server.methods.filter(call => call.method === "surface.shepherd.managed.receipt").map(call => call.params))
      .toEqual([{ request_id: requestId }])
  })

  it("reads an exact retained managed receipt without inspection, qualification or another input attempt", async () => {
    const cmux = host()
    expect(typeof cmux.managedReceipt).toBe("function")
    expect(await cmux.managedReceipt!(requestId, expectedIdentity)).toMatchObject({
      kind: "agent_session", nativeRequestId: requestId, identity: expectedIdentity,
      editorInserted: true, backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "server-message-42",
    })
    expect(server.methods.map(call => call.method)).toEqual(["surface.shepherd.managed.receipt"])
  })

  it("refuses a malformed retained native request ID before issuing any socket lookup", async () => {
    await expect(host().managedReceipt!("not-a-uuid", expectedIdentity)).rejects.toThrow(/native Shepherd/i)
    expect(server.methods).toEqual([])
  })

  it("refuses a noncanonical managed continuation before attempting editor or backend input", async () => {
    qualify()
    const cmux = host()
    expect(await cmux.continueInput!({ requestId, expected: await cmux.inspect!(surface), text: "Continue.\n" }, () => true))
      .toMatchObject({ state: "not_sent" })
    expect(server.methods.some(call => call.method.includes(".continue"))).toBe(false)
  })

  it("rejects a retained receipt for another backend birth rather than adopting a fresh inspection", async () => {
    const cmux = host()
    expect(typeof cmux.managedReceipt).toBe("function")
    await expect(cmux.managedReceipt!(requestId, { ...expectedIdentity, kind: "agent_session", provider: "copilot", backendStartMicroseconds: 6790 }))
      .rejects.toThrow(/native Shepherd/i)
    expect(server.methods.map(call => call.method)).toEqual(["surface.shepherd.managed.receipt"])
  })

  it("expires managed authority on monotonic elapsed time despite a backward local wall clock", async () => {
    qualify()
    capture.token = { id: token, expires_at_uptime_seconds: 123.05 }
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    await new Promise(resolve => setTimeout(resolve, 70))
    clock -= 1_000
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue." }, () => true)).toMatchObject({ state: "not_sent" })
    expect(server.methods.some(call => call.method.includes(".continue"))).toBe(false)
  })

  it("observes managed work and returns only a new exact idle native generation, never a quiet terminal guess", async () => {
    const jobs: Array<() => void> = []
    const observations: ShepherdHostObservation[] = []
    const returned: ReturnedControl[] = []
    const cmux = host({ schedule: (fn, ms) => { if (ms === 4_000) jobs.push(fn); return () => {} } })
    const watcher = cmux.watch({ returned: event => returned.push(event), focused() {},
      observed: observation => observations.push(observation) })
    try {
      await vi.waitFor(() => expect(server.streamCount()).toBe(1))
      await vi.waitFor(() => expect(observations).toHaveLength(1))
      expect(observations[0]!.sessions).toMatchObject([{
        session: { id: surface, kind: "agent_session", agent: "copilot", cwd: "/native/project", tty: null },
        activity: "idle", observedAt: clock,
      }])
      expect(returned).toHaveLength(1)
      expect(returned[0]).toMatchObject({ sessionId: surface, agent: "copilot", cwd: "/native/project", backgroundWork: false })
      jobs.shift()!()
      await vi.waitFor(() => expect(observations).toHaveLength(2))
      expect(returned).toHaveLength(1)
      capture.idle = false
      capture.activity_revision = token
      jobs.shift()!()
      await vi.waitFor(() => expect(observations).toHaveLength(3))
      expect(observations[2]!.sessions[0]!.activity).toBe("working")
      expect(returned).toHaveLength(1)
      capture.idle = true
      capture.activity_revision = boot
      jobs.shift()!()
      await vi.waitFor(() => expect(observations).toHaveLength(4))
      expect(returned).toHaveLength(2)
      expect(returned[1]!.transitionId).not.toBe(returned[0]!.transitionId)
      expect(server.methods.some(call => ["surface.read_text", "surface.shepherd.inspect"].includes(call.method))).toBe(false)
      expect(server.methods.some(call => call.method.includes(".continue"))).toBe(false)
    } finally { watcher.close() }
  })

  it("keeps an unavailable managed observation unknown without retiring it or reading a terminal substitute", async () => {
    delete capabilities.shepherd_managed_input
    const observations: ShepherdHostObservation[] = []
    const cmux = host({ schedule: () => () => {} })
    const watcher = cmux.watch({ returned() { throw new Error("no managed readiness") }, focused() {},
      observed: observation => observations.push(observation) })
    try {
      await vi.waitFor(() => expect(server.streamCount()).toBe(1))
      await vi.waitFor(() => expect(observations).toHaveLength(1))
      expect(observations[0]!.sessions).toMatchObject([{
        session: { id: surface, kind: "agent_session" }, activity: "unknown", observedAt: null, error: "read_failed",
      }])
      expect(await cmux.retirementInventory!()).toEqual([surface])
      expect(server.methods.some(call => ["surface.read_text", "surface.shepherd.inspect"].includes(call.method))).toBe(false)
    } finally { watcher.close() }
  })

  it("does not publish or judge managed evidence that resolves after watcher shutdown", async () => {
    let watcher: { close(): void } | undefined
    server.respond("surface.shepherd.managed.inspect", () => { watcher!.close(); return capture })
    const observations: ShepherdHostObservation[] = []
    const returned: ReturnedControl[] = []
    let decoded = 0
    const cmux = host({ schedule: () => () => {}, now: () => { decoded++; return clock } })
    watcher = cmux.watch({ returned: event => returned.push(event), focused() {},
      observed: observation => observations.push(observation) })
    try {
      await vi.waitFor(() => expect(server.methods.some(call => call.method === "surface.shepherd.managed.inspect")).toBe(true))
      await vi.waitFor(() => expect(decoded).toBe(1))
      expect(observations).toEqual([])
      expect(returned).toEqual([])
    } finally { watcher.close() }
  })
})
