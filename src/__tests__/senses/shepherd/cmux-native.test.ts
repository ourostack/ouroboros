import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createCmuxClient } from "../../../senses/shepherd/client"
import { createCmuxHost } from "../../../senses/shepherd/cmux"
import { createCmuxNativeInput } from "../../../senses/shepherd/cmux-native"
import type { CmuxClient } from "../../../senses/shepherd/client"
import { startFakeCmux, type FakeCmux } from "./fake-cmux"
import { tree } from "./fixtures"

const surface = "11111111-1111-4111-8111-111111111111"
const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const boot = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const instance = "42:123456789"
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
let server: FakeCmux
let clock: number
let raw: string
let capture: Record<string, unknown>
let capabilities: Record<string, unknown>

function receipt(state = "accepted") {
  return { protocol_version: 1, host_instance: boot, request_id: requestId, surface_id: surface,
    workspace_id: workspace, process_instance: instance, state, reason: state === "accepted" ? "submitted" : "refused",
    paste_admitted: state !== "not_sent", submit_admitted: state === "accepted" }
}

function host() {
  return createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "none" } }), {
    now: () => clock,
    identifyTerminals: async () => { throw new Error("legacy-enrichment-should-not-run") },
  })
}

beforeEach(async () => {
  clock = 100_000
  raw = "Native task state\napi_key=synthetic-private-value\n"
  capture = {
    protocol_version: 1, host_instance: boot, screen: raw,
    observed_at_uptime_seconds: 123, observed_at_unix_ms: 50_000,
    token: { id: token, expires_at_uptime_seconds: 125 },
    snapshot: { workspace_id: workspace, surface_id: surface, process_instance: instance,
      agent: "claude", cwd: "/native/project", tty: "/dev/ttys007", surface_generation: 3,
      screen_fingerprint: hash(raw), outside_composer_fingerprint: hash("Native task state\n"),
      input_revision: 4, focus_revision: 5, focused: false, idle: true,
      composer: { state: "empty", draft_length: 0 }, background_work: false, accepts_immediate_input: true },
  }
  capabilities = { shepherd_guarded_input: { protocol_version: 1, state: "qualified", agents: ["claude"] },
    methods: ["surface.shepherd.inspect", "surface.shepherd.continue", "surface.shepherd.receipt"] }
  server = await startFakeCmux()
  server.respond("system.capabilities", () => capabilities)
  server.respond("system.tree", () => {
    const result = tree([{ id: surface, ref: "surface:1", tty: "legacy-tty", focused: false }])
    ;(result.windows as Array<{ workspaces: Array<{ id: string }> }>)[0]!.workspaces[0]!.id = workspace
    return result
  })
  server.respond("surface.shepherd.inspect", () => capture)
  server.respond("surface.shepherd.continue", () => receipt())
  server.respond("surface.shepherd.receipt", () => receipt())
})
afterEach(async () => { await server.close() })

describe("cmux native guarded transport", () => {
  it("recognizes only an explicit method-not-found as absent discovery, not auth or transport failure", async () => {
    const cmux = host()
    server.respond("system.capabilities", () => ({ __raw: JSON.stringify({ ok: false,
      error: { code: "method_not_found", message: "Old host" } }) }))
    expect(await cmux.capabilities!()).toMatchObject({ state: "unsupported", reason: "native_guarded_discovery_unavailable" })
    server.respond("system.capabilities", () => ({ __raw: JSON.stringify({ ok: false,
      error: { code: "access_denied", message: "Not authorized" } }) }))
    await expect(cmux.capabilities!()).rejects.toThrow()
    const failure = new Error("lower client failed before decoding")
    const client: CmuxClient = { call: async () => { throw failure },
      command: async () => "", stream: () => ({ close() {} }) }
    await expect(createCmuxNativeInput(client, () => clock).capabilities()).rejects.toBe(failure)
  })

  it.each([null, [], {}, { protocol_version: 2, state: "qualified", agents: ["claude"] },
    { protocol_version: 1, state: "ready", agents: ["claude"] },
    { protocol_version: 1, state: "qualified", agents: [null] }])("refuses malformed qualification instead of silently using a fallback: %j", async value => {
    capabilities = { shepherd_guarded_input: value }
    await expect(host().capabilities!()).rejects.toThrow(/native Shepherd/i)
  })

  it("discovers explicit qualification without treating method existence as permission", async () => {
    const cmux = host()
    expect(await cmux.capabilities!()).toEqual({ state: "qualified", protocolVersion: 1, agents: ["claude"] })
    capabilities = { methods: capabilities.methods }
    expect(await cmux.capabilities!()).toMatchObject({ state: "unsupported" })
    capabilities = { shepherd_guarded_input: { protocol_version: 1, state: "unqualified", agents: [] } }
    expect(await cmux.capabilities!()).toEqual({ state: "unqualified", protocolVersion: 1, agents: [] })
  })

  it("uses only the canonical native capture and native-scoped identity, hashing before redaction", async () => {
    const expected = await host().inspect!(surface)
    expect(expected).toMatchObject({
      instance, screen: "Native task state\napi_key=[redacted]\n", screenFingerprint: hash(raw),
      session: { id: surface, agent: "claude", cwd: "/native/project", tty: "/dev/ttys007", instance },
      activity: "idle", composer: "empty", backgroundWork: false,
      guarded: { hostInstance: boot, workspaceId: workspace, token, surfaceGeneration: 3, inputRevision: 4, focusRevision: 5 },
    })
    expect(expected.guarded!.expiresAtUnixMs).toBeGreaterThan(clock + 1_500)
    expect(expected.guarded!.expiresAtUnixMs).toBeLessThanOrEqual(clock + 2_000)
    expect(server.methods.some(call => call.method === "surface.read_text")).toBe(false)
    expect(server.methods.find(call => call.method === "surface.shepherd.inspect")!.params)
      .toEqual({ workspace_id: workspace, surface_id: surface })
  })

  it("preserves the tree/event surface spelling while comparing native UUID echoes case-insensitively", async () => {
    const nativeSurface = "abcdefab-cdef-4abc-8abc-abcdefabcdef"
    const eventSurface = nativeSurface.toUpperCase()
    Object.assign(capture.snapshot as object, { surface_id: nativeSurface })
    server.respond("system.tree", () => {
      const result = tree([{ id: eventSurface, ref: "surface:1", focused: false }])
      ;(result.windows as Array<{ workspaces: Array<{ id: string }> }>)[0]!.workspaces[0]!.id = workspace
      return result
    })
    server.respond("surface.shepherd.continue", () => ({ ...receipt(), surface_id: eventSurface }))
    const cmux = host()
    const expected = await cmux.inspect!(eventSurface)
    expect(expected.session.id).toBe(eventSurface)
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue this task." }, () => true))
      .toMatchObject({ state: "sent", receipt: { surfaceId: eventSurface } })
  })

  it("keeps unknown native identity unknown rather than grafting legacy process facts", async () => {
    Object.assign(capture.snapshot as object, { process_instance: null, agent: null, cwd: null, tty: null,
      idle: null, background_work: null, outside_composer_fingerprint: "", composer: { state: "unknown", draft_length: null } })
    capture.token = null
    const value = await host().inspect!(surface)
    expect(value).toMatchObject({ instance: null, activity: "unknown", composer: "unknown", backgroundWork: null,
      session: { agent: null, cwd: null, tty: null, instance: null }, guarded: { token: null, expiresAtUnixMs: null } })
  })

  it.each([
    { idle: false, composer: { state: "draft", draft_length: 17 }, expected: { activity: "working", composer: "draft" } },
    { idle: null, composer: { state: "dialog", draft_length: null }, expected: { activity: "unknown", composer: "unknown" } },
  ])("reports busy/draft/dialog states but cannot authorize input: %j", async value => {
    Object.assign(capture.snapshot as object, { idle: value.idle, composer: value.composer })
    expect(await host().inspect!(surface)).toMatchObject({ ...value.expected, guarded: { token: null, expiresAtUnixMs: null } })
  })

  it("reports unavailable canonical capture as unknown and never hashes a different screen", async () => {
    capture.screen = null
    capture.token = null
    expect(await host().inspect!(surface)).toMatchObject({ screen: "", screenFingerprint: "", activity: "unknown",
      composer: "unknown", guarded: { token: null, expiresAtUnixMs: null } })
  })

  it.each([122, 123, 126])("withholds an expired or overlong native lease at uptime %s", async expires => {
    capture.token = { id: token, expires_at_uptime_seconds: expires }
    expect(await host().inspect!(surface)).toMatchObject({ guarded: { token: null, expiresAtUnixMs: null } })
  })

  it("expires the native lease on elapsed time even when the local wall clock stops or rolls backward", async () => {
    capture.token = { id: token, expires_at_uptime_seconds: 123.5 }
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    expect(expected.guarded!.token).toBe(token)
    await new Promise(resolve => setTimeout(resolve, 550))
    clock -= 100
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue the task." }, () => true))
      .toMatchObject({ state: "not_sent" })
    expect(server.methods.some(call => call.method === "surface.shepherd.continue")).toBe(false)
  })

  it.each([
    { focused: true }, { accepts_immediate_input: false }, { agent: null }, { cwd: null }, { tty: null },
    { outside_composer_fingerprint: "" }, { background_work: true },
  ])("withholds a native token if any required readiness fact is missing: %j", async patch => {
    Object.assign(capture.snapshot as object, patch)
    expect(await host().inspect!(surface)).toMatchObject({ guarded: { token: null, expiresAtUnixMs: null } })
  })

  it("dispatches a native UUID/token/text only and translates an exactly bound native receipt", async () => {
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue this authorized task." }, () => true))
      .toMatchObject({ state: "sent", receipt: { requestId, hostInstance: boot, workspaceId: workspace,
        surfaceId: surface, processInstance: instance, pasteAdmitted: true, submitAdmitted: true, state: "accepted" } })
    expect(server.methods.filter(call => call.method === "surface.shepherd.continue").map(call => call.params))
      .toEqual([{ request_id: requestId, token, text: "Continue this authorized task." }])
    expect(server.methods.some(call => ["terminal.paste", "surface.send_key", "surface.send_text"].includes(call.method))).toBe(false)
  })

  it.each(["copied", "mutated", "expired", "unqualified", "guard"])("admits zero native RPC input for %s authority", async failure => {
    const cmux = host()
    let expected = await cmux.inspect!(surface)
    if (failure === "copied") expected = structuredClone(expected)
    if (failure === "mutated") expected.session.cwd = "/other/project"
    if (failure === "expired") clock += 2_001
    if (failure === "unqualified") capabilities = { shepherd_guarded_input: { protocol_version: 1, state: "unqualified", agents: [] } }
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue the task." }, () => failure !== "guard"))
      .toMatchObject({ state: "not_sent" })
    expect(server.methods.some(call => call.method === "surface.shepherd.continue")).toBe(false)
  })

  it.each([
    { host_instance: "not-a-boot" }, { protocol_version: 2 }, { screen: "not the hashed capture" },
    { observed_at_uptime_seconds: -1 }, { observed_at_unix_ms: -1 },
    { token: { id: "not-a-token", expires_at_uptime_seconds: 125 } },
    { snapshot: { ...{}, surface_id: surface } },
  ])("rejects malformed native capture without reading a legacy fallback: %j", async patch => {
    Object.assign(capture, patch)
    await expect(host().inspect!(surface)).rejects.toThrow(/native|Shepherd/i)
    expect(server.methods.some(call => call.method === "surface.read_text")).toBe(false)
  })

  it.each([
    { surface_id: token }, { workspace_id: token }, { process_instance: "" }, { cwd: false }, { tty: {} },
    { surface_generation: -1 }, { input_revision: 0.5 }, { focus_revision: Number.MAX_SAFE_INTEGER + 1 },
    { idle: "true" }, { background_work: "false" }, { focused: null }, { accepts_immediate_input: 1 },
    { outside_composer_fingerprint: "not-a-hash" }, { screen_fingerprint: "" },
    { composer: null }, { composer: { state: "arbitrary", draft_length: null } },
    { composer: { state: "draft", draft_length: 0 } }, { composer: { state: "empty", draft_length: 5 } },
  ])("rejects malformed or cross-target native facts without recovering authority from the tree: %j", async patch => {
    Object.assign(capture.snapshot as object, patch)
    await expect(host().inspect!(surface)).rejects.toThrow(/native Shepherd/i)
  })

  it.each(["not_sent", "unknown"])("retains native %s without pretending paste was never attempted", async state => {
    server.respond("surface.shepherd.continue", () => receipt(state))
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue the task." }, () => true))
      .toMatchObject({ state, receipt: { state, pasteAdmitted: state === "unknown", submitAdmitted: false } })
  })

  it("looks up the exact receipt after a lost continuation reply without retrying input", async () => {
    server.respond("surface.shepherd.continue", () => ({ __raw: "invalid JSON reply" }))
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    expect(await cmux.continueInput!({ requestId, expected, text: "Continue the task." }, () => true))
      .toMatchObject({ state: "sent", receipt: { requestId, hostInstance: boot } })
    expect(server.methods.filter(call => call.method === "surface.shepherd.continue")).toHaveLength(1)
    expect(server.methods.filter(call => call.method === "surface.shepherd.receipt").map(call => call.params))
      .toEqual([{ request_id: requestId }])
  })

  it("does not treat missing retained receipts as proof that zero input was admitted", async () => {
    server.respond("surface.shepherd.continue", () => ({ __raw: "lost response" }))
    server.respond("surface.shepherd.receipt", () => ({ __raw: JSON.stringify({ ok: false,
      error: { code: "not_found", message: "No receipt" } }) }))
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    await expect(cmux.continueInput!({ requestId, expected, text: "Continue the task." }, () => true)).rejects.toThrow(/unknown/i)
    expect(server.methods.filter(call => call.method === "surface.shepherd.continue")).toHaveLength(1)
  })

  it.each([
    { request_id: token }, { host_instance: token }, { surface_id: token }, { workspace_id: token },
    { process_instance: "other:123" }, { paste_admitted: false }, { submit_admitted: false },
  ])("holds unknown for a mismatched receipt, including failed lookup: %j", async patch => {
    server.respond("surface.shepherd.continue", () => ({ ...receipt(), ...patch }))
    server.respond("surface.shepherd.receipt", () => ({ ...receipt(), ...patch }))
    const cmux = host()
    const expected = await cmux.inspect!(surface)
    await expect(cmux.continueInput!({ requestId, expected, text: "Continue the task." }, () => true)).rejects.toThrow(/unknown|receipt/i)
    expect(server.methods.filter(call => call.method === "surface.shepherd.continue")).toHaveLength(1)
  })
})
