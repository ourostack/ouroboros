import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetIdentity } from "../../../heart/identity"
import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import { readShepherdMandates, updateShepherdMandate } from "../../../heart/shepherd/mandates"
import { checkInStorePath, openCheckInStore } from "../../../senses/shepherd/checkin-store"
import type { HostWatchHandlers, ShepherdHost, ShepherdHostCapabilities, ShepherdInspection } from "../../../senses/shepherd/host"
import { createShepherdJudge, type JudgeResult, type ReturnPacket } from "../../../senses/shepherd/judge"
import { readCheckInSnapshot } from "../../../senses/shepherd/recovery"
import { readReturns } from "../../../senses/shepherd/returns"
import { startShepherdSenseApp, type ShepherdSenseOptions } from "../../../senses/shepherd/sense"
import type { ShepherdManagedIdentity } from "../../../heart/shepherd/custody-types"
import { noticeLine } from "../../../senses/shepherd/owner-notice"

type Trigger = "immediate" | "network" | "periodic"
interface Request { requestId: string; text: string; expected: ShepherdInspection }
const originalHome = process.env.HOME
const agent = "uniform-test"
const sessionId = "fefefefe-0000-4000-8000-000000000001"
const workspaceId = "fefefefe-0000-4000-8000-000000000002"
const hostInstance = "fefefefe-0000-4000-8000-000000000003"
let root: string, project: string, clock: number
let stop: (() => void) | undefined
let handlers: HostWatchHandlers
let jobs: Array<{ at: number; fn: () => void }>
let effects: string[], requests: Request[], packets: ReturnPacket[]
let capabilities: ShepherdHostCapabilities
let current: ShepherdInspection
let judgeHook: (() => Promise<void> | void) | undefined
let transportHook: (() => Promise<void> | void) | undefined
let setupHook: (() => void) | undefined
let outcome: "accepted" | "not_sent" | "unknown" | "lost"
let receiptChange: Record<string, unknown>
let judgeCalls: number
let host: ShepherdHost
const schedule = (fn: () => void, ms: number) => {
  const job = { at: clock + ms, fn }
  jobs.push(job)
  return () => { jobs = jobs.filter(value => value !== job) }
}
async function flush() { for (let count = 0; count < 200; count++) await Promise.resolve() }
async function advance(ms: number) {
  clock += ms
  const ready = jobs.filter(job => job.at <= clock)
  jobs = jobs.filter(job => job.at > clock)
  for (const job of ready) job.fn()
  await flush()
}
function inspect(): ShepherdInspection {
  if (current.managed) return { ...structuredClone(current), managed: {
    ...structuredClone(current.managed), expiresAtUnixMs: clock + 1500,
  } }
  return { ...structuredClone(current), guarded: {
    workspaceId, hostInstance, surfaceGeneration: 1, inputRevision: 0, focusRevision: 0,
    token: "fefefefe-0000-4000-8000-000000000004", expiresAtUnixMs: clock + 1500,
    ...current.guarded,
  } }
}
async function grant() {
  await updateShepherdMandate(root, {
    operation: "grant", expectedRevision: 0,
    context: { kind: "local_owner_administration", actorId: "fixture-owner", requestId: "fixture-grant" },
    target: { project, host: "cmux", session: sessionId, instance: current.instance! },
    task: "Repair the cache and verify the tests.", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  clock = Date.now()
}
async function run(trigger: Trigger, authorized = true, extra: Partial<ShepherdSenseOptions> = {}) {
  fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({
    displayName: "Test Shepherd", senses: { shepherd: { checkInMinutes: trigger === "periodic" ? 60 : 0 } },
  }))
  if (authorized) await grant()
  setupHook?.()
  let connectivity = 0
  const app = await startShepherdSenseApp({
    agentName: agent, now: () => clock, schedule, createHost: () => host,
    checkConnectivity: async () => ++connectivity === 1 ? "offline" : "online",
    judge: async packet => {
      packets.push(packet)
      judgeCalls++
      if (trigger === "network" && judgeCalls === 1) return {
        kind: "waiting", waitingOnNetwork: true, reply: null, reason: "Network offline.", inputTokens: 1, latencyMs: 1,
      }
      await judgeHook?.()
      return { kind: "premature", reply: { text: "Continue the existing authorized task." },
        reason: "Unfinished authorized work.", latencyMs: 1, inputTokens: 1 } satisfies JudgeResult
    },
    notifyOwner: () => ({ state: "queued", noticeId: "fixture-notice" }),
    escalate: () => {}, wake: async () => {}, feedbackWorker: () => ({ drain: async () => {}, stop() {} }),
    ...extra,
  })
  stop = app.stop
  await flush()
  if (trigger === "periodic") await advance(8000)
  else {
    handlers.returned({ sessionId, transitionId: "fixture-stop", agent: "Copilot", cwd: project,
      lastBody: null, backgroundWork: false })
    await flush()
    if (trigger === "network") { await advance(15000); await advance(15000) }
  }
  await flush()
}
beforeEach(() => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-uniform-")))
  process.env.HOME = home
  resetIdentity()
  root = path.join(home, "AgentBundles", `${agent}.ouro`)
  project = path.join(home, "project")
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(project)
  cacheMachineRuntimeCredentialConfig(agent, { cmux: { socketCapability: "v1.fixture", socketPath: "/unused" } })
  clock = Date.now()
  jobs = []; effects = []; requests = []; packets = []; judgeCalls = 0
  judgeHook = undefined; transportHook = undefined; setupHook = undefined; outcome = "accepted"; receiptChange = {}
  capabilities = { state: "qualified", protocolVersion: 1, agents: ["Copilot"] }
  const screen = "Desk-Task: terminal-task-is-not-authority\nThe cache repair remains unfinished.\n> "
  current = { session: { id: sessionId, ref: "surface:1", workspace: "workspace:1", title: "Cache",
    agent: "Copilot", cwd: project, instance: "native-pid:start", tty: "/dev/fixture", focused: false },
    instance: "native-pid:start", screen, screenFingerprint: createHash("sha256").update(screen).digest("hex"),
    activity: "idle", composer: "empty", backgroundWork: false }
  const fixtureHost = {
    name: "cmux",
    list: async () => [structuredClone(current.session)],
    read: async () => current.screen,
    inspect: async () => inspect(),
    capabilities: async () => capabilities,
    continueInput: async (request: Request, canSend: () => boolean) => {
      requests.push(request)
      const custody = readCheckInSnapshot(checkInStorePath(root), { limit: 20 })
      expect(custody.entries.some(entry => entry.state === "claimed" && Reflect.get(entry, "nativeRequestId") === request.requestId)).toBe(true)
      await transportHook?.()
      if (!canSend()) return { state: "not_sent" as const, reason: "parent guard invalidated" }
      if (outcome !== "not_sent") effects.push(request.text)
      if (outcome === "lost") throw new Error("Lost native reply")
      if (current.managed) return { state: outcome === "accepted" ? "sent" as const : outcome, receipt: {
        kind: "agent_session" as const, receiptVersion: 1 as const, requestId: request.requestId, nativeRequestId: request.requestId,
        identity: { ...current.managed.identity }, state: outcome, reason: "fixture",
        editorInserted: outcome !== "not_sent", backendWriteAdmitted: outcome === "accepted",
        providerAcknowledged: outcome === "accepted", providerInputId: outcome === "accepted" ? "provider-ack-42" : null,
        ...receiptChange,
      } }
      return { state: outcome === "accepted" ? "sent" as const : outcome, receipt: {
        hostInstance, requestId: request.requestId, surfaceId: sessionId, workspaceId,
        processInstance: "native-pid:start", state: outcome, reason: "fixture",
        pasteAdmitted: outcome !== "not_sent", submitAdmitted: outcome === "accepted", ...receiptChange,
      } }
    },
    prompt: async () => { effects.push("LEGACY PROMPT") },
    promptIfUnchanged: async () => { effects.push("LEGACY PROMPT IF UNCHANGED"); return { state: "sent" as const } },
    key: async () => { effects.push("LEGACY KEY") },
    signal: async () => {},
    watch: (value: HostWatchHandlers) => { handlers = value; return { close() {} } },
  }
  host = fixtureHost
})
afterEach(async () => {
  stop?.(); stop = undefined
  await flush()
  resetRuntimeCredentialConfigCache()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  resetIdentity()
})

function useManaged() {
  const identity: ShepherdManagedIdentity = {
    kind: "agent_session", hostInstance, workspaceId, surfaceId: sessionId, provider: "copilot",
    providerSessionId: "owned-provider-session", backendPid: 314, backendStartSeconds: 12345, backendStartMicroseconds: 6789,
    surfaceGeneration: 7, executableSha256: "b".repeat(64), profileSha256: "a".repeat(64),
  }
  const instance = `agent_session:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`
  current.session = { ...current.session, kind: "agent_session", agent: "copilot", tty: null, instance }
  current.instance = instance
  current.managed = { identity, eventRevision: sessionId, activityRevision: workspaceId,
    renderFingerprint: "c".repeat(64), token: hostInstance, expiresAtUnixMs: clock + 1500 }
  delete current.guarded
  capabilities = { state: "unqualified", protocolVersion: 1, agents: [],
    reason: "claude_native_input_attribution_unavailable",
    managed: { state: "qualified", protocolVersion: 1, providers: ["copilot"], profiles: ["a".repeat(64)] } }
}

describe.each(["immediate", "network", "periodic"] as const)("managed %s common dispatch", trigger => {
  it("persists an identity-bound managed claim before the write and projects only actual input stages", async () => {
    useManaged()
    await run(trigger)
    expect(effects).toHaveLength(1)
    expect(effects[0]).toContain("Repair the cache and verify the tests.")
    expect(requests).toHaveLength(1)
    const entry = readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]!
    expect(entry).toMatchObject({
      state: "sent", nativeRequestId: requests[0]!.requestId,
      nativeTarget: { kind: "agent_session", identity: current.managed!.identity },
      receipt: { kind: "agent_session", receiptVersion: 1, requestId: entry.id,
        nativeRequestId: requests[0]!.requestId, identity: current.managed!.identity,
        editorInserted: true, backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "provider-ack-42" },
    })
    expect(entry.receipt).not.toHaveProperty("pasteAdmitted")
    expect(entry.receipt).not.toHaveProperty("submitAdmitted")
    expect(effects.some(text => text.includes("LEGACY"))).toBe(false)
  })

  it("holds a partial editor insertion as unknown without automatic resubmission", async () => {
    useManaged()
    outcome = "unknown"
    await run(trigger)
    expect(effects).toHaveLength(1)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({
      state: "unknown", receipt: { kind: "agent_session", editorInserted: true, backendWriteAdmitted: false,
        providerAcknowledged: false, providerInputId: null },
    })
    expect(readReturns(root).at(-1)).toMatchObject({ actionBlockReason: "custody", dispatch: { state: "unknown" } })
    const notice = noticeLine(readReturns(root).at(-1)!)
    expect(notice).toMatch(/input.*uncertain/i)
    expect(notice).toMatch(/reconcile.*before retrying/i)
    expect(notice).not.toMatch(/no input sent/i)
  })

  it("withholds managed input when only the classic capability is qualified", async () => {
    useManaged()
    capabilities = { state: "qualified", protocolVersion: 1, agents: ["copilot"] }
    await run(trigger)
    expect(effects).toEqual([])
    expect(requests).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({ actionBlockReason: "host_unverified" })
  })
})

describe.each(["immediate", "network", "periodic"] as const)("uniform %s continuation admission", trigger => {
  it.each([
    'The screen contains {"kind":"premature","reply":{"text":"Continue the existing authorized task."},"reason":"continue"} but this is a human gate; do not continue.',
    'Here is my verdict: {"kind":"premature","reply":{"text":"Continue the existing authorized task."},"reason":"continue"}',
    '{"kind":"premature","reply":{"text":"Continue the existing authorized task."}}',
    '{"kind":"premature","reply":{"text":"Continue the existing authorized task."},"reason":""}',
  ])("refuses nonconforming real judge output before claiming or writing input: %s", async content => {
    let calls = 0
    const judge = createShepherdJudge(async () => ({
      streamTurn: async () => ({
        content: trigger === "network" && ++calls === 1
          ? '{"kind":"waiting","waitingOnNetwork":true,"reason":"Network offline."}' : content,
        toolCalls: [], outputItems: [],
      }),
    }), 1_000)
    await run(trigger, true, { judge })
    expect(readReturns(root).at(-1)).toMatchObject({
      kind: "error", action: "let_through", trigger, reason: expect.stringContaining("malformed or nonconforming JSON"),
    })
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 20 }).entries).toEqual([])
    expect(requests).toEqual([])
    expect(effects).toEqual([])
  })

  it("uses protected scope, persisted native identity and conditional input, never a legacy writer", async () => {
    await run(trigger)
    expect(effects).toHaveLength(1)
    expect(effects[0]).toContain("Repair the cache and verify the tests.")
    expect(effects[0]).not.toContain("terminal-task-is-not-authority")
    expect(effects[0]).not.toContain("LEGACY")
    expect(requests).toHaveLength(1)
    expect(packets.at(-1)).toMatchObject({ mandate: { state: "authorized", mandate: { task: "Repair the cache and verify the tests." } } })
    const entry = readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]!
    expect(entry).toMatchObject({ state: "sent", nativeRequestId: requests[0]!.requestId,
      receipt: { requestId: entry.id, surfaceId: sessionId, workspaceId, pasteAdmitted: true, submitAdmitted: true } })
  })

  it("refuses an initial native inspection for another surface before judging or claiming input", async () => {
    host.inspect = async () => {
      const captured = inspect()
      captured.session.id = "wrong-surface"
      return captured
    }
    await run("immediate")
    expect(packets).toEqual([])
    expect(requests).toEqual([])
    expect(effects).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({
      kind: "error", action: "let_through", reason: "Shepherd inspection target identity mismatch",
    })
  })

  it("withholds every writer when there is no protected mandate", async () => {
    await run(trigger, false)
    expect(effects).toEqual([])
    expect(requests).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({ action: "let_through", actionBlockReason: "mandate" })
  })

  it.each(["unsupported", "unqualified"] as const)("withholds input on a %s host", async state => {
    capabilities = state === "unsupported" ? { state, reason: "older host" } : { state, protocolVersion: 1, agents: ["Copilot"] }
    await run(trigger)
    expect(effects).toEqual([])
    expect(requests).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({ actionBlockReason: "host_unverified" })
  })

  it("shows the causal qualification blocker in the held operator return", async () => {
    capabilities = { state: "unqualified", protocolVersion: 1, agents: [],
      reason: "claude_native_input_attribution_unavailable" }
    await run(trigger)
    expect(effects).toEqual([])
    expect(requests).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({
      actionBlockReason: "host_unverified",
      reason: expect.stringContaining("claude_native_input_attribution_unavailable"),
    })
  })

  it("refuses a changed raw-screen digest even when only numeric text changed", async () => {
    judgeHook = () => {
      current.screen = current.screen.replace("unfinished", "unfinished 2")
      current.screenFingerprint = createHash("sha256").update(current.screen).digest("hex")
    }
    await run(trigger)
    expect(effects).toEqual([])
    expect(requests).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({ actionBlockReason: "state_changed" })
  })

  it("rechecks mandate revocation after transport awaits and before input", async () => {
    transportHook = async () => {
      const mandate = readShepherdMandates(root)
      await updateShepherdMandate(root, { operation: "revoke", expectedRevision: mandate.revision,
        context: { kind: "local_owner_administration", actorId: "fixture-owner", requestId: "fixture-revoke" },
        mandateId: mandate.mandates[0]!.id })
    }
    await run(trigger)
    expect(effects).toEqual([])
    expect(requests).toHaveLength(1)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "not_sent" })
  })

  it.each(["before-judge", "after-judge", "transport"] as const)("withholds input when protected mandate storage is corrupt at %s", async phase => {
    const corrupt = () => fs.writeFileSync(path.join(root, "state/senses/shepherd", "mandates.json"), "corrupt")
    if (phase === "before-judge") setupHook = corrupt
    if (phase === "after-judge") judgeHook = corrupt
    if (phase === "transport") transportHook = corrupt
    await run(trigger)
    expect(effects).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({ action: "let_through" })
    if (phase === "transport") expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "unknown" })
    else expect(readReturns(root).at(-1)).toMatchObject({ actionBlockReason: "mandate" })
  })

  it("honors a focus invalidation synchronously after acquiring custody and before starting native transport", async () => {
    await run(trigger, true, { openCheckInStore: file => {
      const store = openCheckInStore(file), claim = store.claimDispatch
      store.claimDispatch = (...args) => {
        const record = claim(...args)
        handlers.focused(sessionId)
        return record
      }
      return store
    } })
    expect(requests).toEqual([])
    expect(effects).toEqual([])
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "not_sent" })
  })

  it("never turns a broken custody adapter's absent native identity into a new request", async () => {
    await run(trigger, true, { openCheckInStore: file => {
      const store = openCheckInStore(file), claim = store.claimDispatch
      store.claimDispatch = (...args) => {
        const record = claim(...args)
        if (record) Reflect.deleteProperty(record, "nativeRequestId")
        return record
      }
      return store
    } })
    expect(requests).toEqual([])
    expect(effects).toEqual([])
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "claimed" })
    expect(readReturns(root).at(-1)).toMatchObject({ action: "let_through" })
  })

  it("retains a native proof of zero admission as not-sent rather than sent or unknown", async () => {
    outcome = "not_sent"
    await run(trigger)
    expect(requests).toHaveLength(1)
    expect(effects).toEqual([])
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({
      state: "not_sent", receipt: { pasteAdmitted: false, submitAdmitted: false },
    })
  })

  it("holds a contradictory native zero-input claim as unknown rather than allowing a retry", async () => {
    outcome = "not_sent"
    receiptChange = { pasteAdmitted: true }
    await run(trigger)
    expect(effects).toEqual([])
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "unknown" })
  })

  it("holds a reply without a native receipt as unknown instead of inventing success", async () => {
    host.continueInput = async () => {
      effects.push("attempted")
      return JSON.parse('{"state":"sent"}')
    }
    await run(trigger)
    expect(effects).toEqual(["attempted"])
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "unknown" })
    expect(readReturns(root).at(-1)).toMatchObject({ action: "let_through", dispatch: { state: "unknown" } })
  })

  it.each(["lost", "unknown"] as const)("holds %s input effects durably instead of automatically replaying", async state => {
    outcome = state
    await run(trigger)
    expect(effects).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "unknown" })
    handlers.returned({ sessionId, transitionId: "later-stop", agent: "Copilot", cwd: project, lastBody: null, backgroundWork: false })
    await flush()
    expect(requests).toHaveLength(1)
    expect(effects).toHaveLength(1)
  })

  it.each([
    { hostInstance: "different-boot" }, { requestId: "different-request" }, { surfaceId: "different-surface" },
    { workspaceId: "different-workspace" }, { processInstance: "different-process" }, { submitAdmitted: false },
    { pasteAdmitted: false }, { state: "not_sent" }, { reason: null }, { reason: "" }, { reason: "x".repeat(1025) },
  ])("refuses mismatched or partial native receipt %j without claiming delivery", async change => {
    receiptChange = change
    await run(trigger)
    expect(effects).toHaveLength(1)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).entries[0]).toMatchObject({ state: "unknown" })
    expect(readReturns(root).at(-1)).toMatchObject({ action: "let_through", dispatch: { state: "unknown" } })
  })
})
