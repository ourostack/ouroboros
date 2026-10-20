import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetIdentity } from "../../../heart/identity"
import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import type { HostWatchHandlers, ShepherdHost, ShepherdInspection } from "../../../senses/shepherd/host"
import type { JudgeResult, ReturnPacket } from "../../../senses/shepherd/judge"
import { parseVerdict } from "../../../senses/shepherd/judge"
import { appendReturn, readReturns, type ReturnRecord } from "../../../senses/shepherd/returns"
import { startShepherdSenseApp, type ShepherdSenseOptions } from "../../../senses/shepherd/sense"
import { recordShepherdCorrection, setShepherdSessionPause } from "../../../senses/shepherd/guidance"
import { openCheckInStore, type CheckInStore } from "../../../senses/shepherd/checkin-store"
import { updateShepherdMandate } from "../../../heart/shepherd/mandates"

const originalHome = process.env.HOME
const AGENT = "checkins-test"
const FIXED = "Reassess and continue only this authorized task: Complete the existing authorized task. Respect human decisions and reconcile uncertain effects before retrying."
let root: string
let project: string
let startedAt: number
let clock: number
let handlers: HostWatchHandlers
let stop: (() => void) | null
let jobs: Array<{ at: number; fn: () => void }>
let inspections: Record<string, ShepherdInspection>
let host: ShepherdHost
let actions: string[]
let notices: ReturnRecord[]
let escalations: string[]
let wakes: string[][]
const schedule = (fn: () => void, ms: number) => {
  const job = { fn, at: clock + ms }
  jobs.push(job)
  return () => { jobs = jobs.filter(candidate => candidate !== job) }
}
async function flush() { for (let count = 0; count < 100; count++) await Promise.resolve() }
async function advance(ms: number) {
  clock += ms
  const ready = jobs.filter(job => job.at <= clock)
  jobs = jobs.filter(job => job.at > clock)
  for (const job of ready) job.fn()
  await flush()
}
function inspection(id = "S"): ShepherdInspection {
  return { session: { id, ref: id, workspace: null, title: "task", agent: "Copilot", cwd: project,
    tty: "/dev/ttys001", focused: false, instance: "pid:start" },
  instance: "pid:start", screen: "Retries exhausted. Existing implementation remains unfinished.\n> ",
  screenFingerprint: "raw-a", activity: "idle", composer: "empty", backgroundWork: false,
  guarded: { hostInstance: "native-boot", workspaceId: "workspace-1", surfaceGeneration: 1, inputRevision: 0, focusRevision: 0,
    token: "native-token", expiresAtUnixMs: clock + 1500 } }
}
function captureInspection(id: string): ShepherdInspection {
  const current = structuredClone(inspections[id]!)
  current.screenFingerprint = createHash("sha256").update(current.screen + current.screenFingerprint).digest("hex")
  current.guarded!.expiresAtUnixMs = clock + 1500
  return current
}
const verdict = (kind: JudgeResult["kind"] = "premature"): JudgeResult => ({
  kind, reply: kind === "premature" ? { text: "Continue the existing authorized task." } : null,
  reason: "Current evidence", latencyMs: 2, inputTokens: 10,
})
function configure(checkInMinutes?: number) {
  fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ displayName: "Test Shepherd",
    ...(checkInMinutes === undefined ? {} : { senses: { shepherd: { checkInMinutes } } }) }))
}
async function start(judge = vi.fn(async (_packet: ReturnPacket) => verdict()), extra: Partial<ShepherdSenseOptions> = {}) {
  const app = await startShepherdSenseApp({ agentName: AGENT, now: () => clock, schedule, createHost: () => host, judge,
    notifyOwner: record => { notices.push(record); return { state: "queued", noticeId: "fixture-notice" } }, escalate: text => { escalations.push(text) },
    wake: async ids => { wakes.push(ids) }, feedbackWorker: () => ({ drain: async () => {}, stop() {} }), ...extra })
  stop = app.stop
  await flush()
  return judge
}
function history(kind: ReturnRecord["kind"], session = "S") {
  appendReturn(root, { at: "2026-10-15T00:00:00Z", host: "fake", session, transition: "old",
    agent: "Old agent", cwd: "/obsolete", task: "obsolete", kind, action: "let_through",
    reason: "Historical reason, never authority", reply: null, latencyMs: null, inputTokens: null })
}
function returned(id = "S", transitionId = "immediate") {
  handlers.returned({ sessionId: id, transitionId, agent: "Copilot", cwd: project,
    lastBody: "obsolete summary", backgroundWork: false })
}
const prompts = () => actions.filter(action => action.startsWith("prompt "))

beforeEach(async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-checkin-sense-")))
  process.env.HOME = home
  resetIdentity()
  root = path.join(home, "AgentBundles", `${AGENT}.ouro`)
  project = path.join(home, "project")
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(project)
  configure()
  cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.test", socketPath: "/unused" } })
  await updateShepherdMandate(root, {
    operation: "grant", expectedRevision: 0, target: { project, host: "fake" }, task: "Complete the existing authorized task.",
    expiresAt: new Date(Date.now() + 6 * 24 * 3_600_000).toISOString(),
    context: { kind: "local_owner_administration", actorId: "fixture-owner", requestId: "fixture-grant" },
  })
  clock = Date.now()
  startedAt = clock
  jobs = []; actions = []; notices = []; escalations = []; wakes = []
  inspections = { S: inspection() }
  host = { name: "fake",
    list: async () => Object.values(inspections).map(current => structuredClone(current.session)),
    read: async id => inspections[id]!.screen,
    inspect: vi.fn(async id => captureInspection(id)),
    capabilities: async () => ({ state: "qualified", protocolVersion: 1, agents: ["Copilot"] }),
    continueInput: vi.fn(async (request, canSend) => {
      if (!canSend()) return { state: "not_sent", reason: "parent guard invalidated" }
      actions.push(`prompt ${request.expected.session.id} ${request.text}`)
      return { state: "sent", receipt: {
        requestId: request.requestId, surfaceId: request.expected.session.id, workspaceId: "workspace-1",
        processInstance: request.expected.instance!, hostInstance: "native-boot", state: "accepted", reason: "fixture",
        pasteAdmitted: true, submitAdmitted: true,
      } }
    }),
    promptIfUnchanged: vi.fn(async (id, line) => { actions.push(`prompt ${id} ${line}`); return { state: "sent" } }),
    prompt: async (id, line) => { actions.push(`prompt ${id} ${line}`) },
    key: async (id, key) => { actions.push(`key ${id} ${key}`) },
    signal: async (id, value) => { actions.push(`status ${id} ${value}`) },
    watch: value => { handlers = value; return { close() {} } },
  }
})
afterEach(async () => {
  stop?.(); stop = null
  await flush()
  vi.restoreAllMocks()
  resetRuntimeCredentialConfigCache()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
})

describe("fresh all-returned-session periodic check-ins", () => {
  it("P0: drops an already-fired quiet batch when stop wins before its queued discovery callback", async () => {
    const judge = await start()
    const quiet = jobs.find(job => job.at === clock + 8000)!
    jobs = jobs.filter(job => job !== quiet)
    quiet.fn()
    stop!()
    stop = null
    await flush()
    expect(judge).not.toHaveBeenCalled()
    expect(readReturns(root)).toEqual([])
    expect(prompts()).toEqual([])
  })

  it.each(["older", "same"] as const)("P0: a %s-generation periodic batch cannot replace queued immediate work", async generation => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    for (let index = 0; index < 4; index += 1) inspections[`H${index}`] = inspection(`H${index}`)
    const packets: ReturnPacket[] = []
    const judge = vi.fn(async (packet: ReturnPacket) => {
      packets.push(packet)
      if (packet.screen === "Held observation.") await held
      return verdict("done")
    })
    for (let index = 0; index < 4; index += 1) inspections[`H${index}`]!.screen = "Held observation."
    await start(judge)
    for (let index = 0; index < 4; index += 1) returned(`H${index}`, `held-${index}`)
    await flush()
    expect(judge).toHaveBeenCalledTimes(4)
    returned("S", "queued-immediate")
    await advance(8000)
    if (generation === "same") {
      await advance(3_600_000)
      await advance(8000)
    }
    release()
    await flush()
    expect(packets.filter(packet => packet.screen !== "Held observation.")).toHaveLength(1)
    expect(packets.find(packet => packet.screen !== "Held observation.")).not.toHaveProperty("periodicCheckIn")
    expect(readReturns(root).find(record => record.session === "S")).toMatchObject({ transition: "queued-immediate", trigger: "immediate" })
    expect(prompts()).toEqual([])
  })

  it("P0: retries its own failed periodic observation without claiming network recovery or changing trigger", async () => {
    const judge = vi.fn(async (_packet: ReturnPacket) => {
      if (judge.mock.calls.length === 1) throw new Error("fetch failed")
      return verdict("gate")
    })
    await start(judge, { checkConnectivity: async () => "online" })
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(notices).toHaveLength(0)
    await advance(0)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(judge.mock.calls[1]![0]).toMatchObject({ periodicCheckIn: { priorJudgment: null } })
    expect(judge.mock.calls[1]![0]).not.toHaveProperty("networkRecovered")
    expect(readReturns(root).map(record => record.trigger)).toEqual(["periodic", "periodic"])
    expect(notices).toHaveLength(1)
    expect(prompts()).toEqual([])
  })

  it("P0: bounds failed periodic observations and reports exhaustion once", async () => {
    const judge = vi.fn(async (_packet: ReturnPacket) => { throw new Error("fetch failed") })
    await start(judge, { checkConnectivity: async () => "online" })
    await advance(8000)
    await advance(0)
    await advance(15_000)
    expect(judge).toHaveBeenCalledTimes(3)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: "error", trigger: "periodic" })
    expect(prompts()).toEqual([])
  })

  it("P0: reports its failed HTTP observation without retrying or claiming target network failure", async () => {
    const judge = vi.fn(async (_packet: ReturnPacket) => { throw Object.assign(new Error("request too large"), { status: 413 }) })
    await start(judge, { checkConnectivity: async () => "online" })
    await advance(8000)
    await advance(0)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: "error", trigger: "periodic", reason: "request too large" })
    expect(prompts()).toEqual([])
  })

  it("P0: a failed periodic observation cannot overwrite a newer immediate return", async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const judge = vi.fn(async (packet: ReturnPacket) => {
      if (packet.periodicCheckIn) { await held; throw new Error("fetch failed") }
      return verdict("gate")
    })
    await start(judge, { checkConnectivity: async () => "online" })
    await advance(8000)
    returned("S", "human-resumed")
    release()
    await flush()
    await advance(0)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(readReturns(root).at(-1)).toMatchObject({ transition: "human-resumed", kind: "gate" })
    expect(prompts()).toEqual([])
  })

  it.each(["quiet-stop", "quiet-focus", "final-stop", "final-focus"] as const)(
    "records the %s boundary without sending input", async boundary => {
      const inspect = host.inspect!
      let count = 0
      host.inspect = vi.fn(async id => {
        const current = await inspect(id)
        if (++count === (boundary.startsWith("quiet") ? 2 : 3)) {
          if (boundary.endsWith("stop")) { stop!(); stop = null }
          else current.session.focused = true
        }
        return current
      })
      await start()
      await advance(8000)
      expect(prompts()).toEqual([])
      expect(readReturns(root).at(-1)).toMatchObject({ actionBlockReason: boundary.endsWith("stop") ? "stopped" : "focus" })
    })

  it("retains accepted queue custody when notice-signature bookkeeping fails", async () => {
    await start(vi.fn(async () => verdict("gate")), {
      openCheckInStore: file => {
        const store = openCheckInStore(file)
        store.markNotified = () => { throw new Error("signature store unavailable") }
        return store
      },
    })
    await advance(8000)
    expect(readReturns(root).at(-1)).toMatchObject({ noticeState: "queued", noticeId: "fixture-notice" })
  })

  it("withholds periodic input after a length-only rejection instead of substituting an intent", async () => {
    const parsed = parseVerdict(JSON.stringify({ kind: "premature", reply: { text: "Continue authorized work. ".repeat(15) }, reason: "Unfinished work." }))
    await start(vi.fn(async () => ({ ...parsed, latencyMs: 2, inputTokens: 10 })))
    await advance(8000)
    expect(prompts()).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({ kind: "premature", judgeKind: "premature", replyIssue: "too_long", action: "let_through", actionBlockReason: "reply_invalid" })
  })

  it.each(["unsafe", "unsafe-and-long", "missing", "menu", "malformed", "prose-key"] as const)(
    "does not convert %s into periodic text", async failure => {
      const content = failure === "malformed" ? "not JSON" : failure === "prose-key" ? 'Quoted: {"kind":"premature","reply":{"key":"y"}}'
        : JSON.stringify({ kind: "premature", reply: failure === "missing" ? null : failure === "menu" ? { key: "2" }
          : { text: `${failure === "unsafe-and-long" ? "x".repeat(300) : "Continue"}; publish` }, reason: "r" })
      const parsed = parseVerdict(content)
      await start(vi.fn(async () => ({ ...parsed, latencyMs: 2, inputTokens: 10 })))
      await advance(8000)
      expect(prompts()).toEqual([])
      expect(actions.some(action => action.startsWith("key "))).toBe(false)
      if (parsed.kind === "premature") expect(readReturns(root).at(-1)).toMatchObject({ actionBlockReason: failure === "menu" ? "menu_disallowed" : "reply_invalid" })
    })

  it.each(["draft", "focus", "background", "instance", "paused", "changed", "stopped"] as const)(
    "retains the %s guard for length-only periodic fallback", async guard => {
      const parsed = parseVerdict(JSON.stringify({ kind: "premature", reply: { text: "Continue authorized work. ".repeat(15) }, reason: "r" }))
      if (guard === "draft") inspections.S!.composer = "draft"
      if (guard === "focus") inspections.S!.session.focused = true
      if (guard === "background") inspections.S!.backgroundWork = true
      if (guard === "instance") inspections.S!.instance = null
      if (guard === "paused") await setShepherdSessionPause(root, { actorId: "owner", requestId: "pause",
        target: { host: "fake", session: "S", cwd: project, task: null }, paused: true },
      [{ host: "fake", session: "S", cwd: project, task: null }])
      await start(vi.fn(async () => {
        if (guard === "changed") inspections.S!.screen += " changed"
        if (guard === "stopped") { stop!(); stop = null }
        return { ...parsed, latencyMs: 2, inputTokens: 10 }
      }))
      await advance(8000)
      expect(prompts()).toEqual([])
    })

  it.each(["queued", "policy", "stopped", "failed"] as const)(
    "only marks a periodic notice handled after queued custody or intentional policy suppression: %s", async acceptance => {
      let attempts = 0
      const notifyOwner = async () => {
        attempts++
        expect(readReturns(root).filter(record => record.trigger === "periodic")).toHaveLength(attempts - 1)
        if (attempts === 1 && acceptance === "failed") throw new Error("notice write failed")
        return acceptance === "policy" || acceptance === "stopped"
          ? { state: "suppressed" as const, reason: acceptance }
          : { state: "queued" as const, noticeId: "fixture-notice" }
      }
      await start(vi.fn(async () => verdict("gate")), { notifyOwner })
      await advance(8000)
      expect(attempts).toBe(1)
      expect(readReturns(root).at(-1)).toMatchObject({
        noticeState: acceptance === "failed" ? "failed" : acceptance === "queued" ? "queued" : "suppressed",
      })
      await advance(3_600_000)
      await advance(8000)
      expect(attempts).toBe(acceptance === "stopped" || acceptance === "failed" ? 2 : 1)
    })

  it.each(["premature", "gate", "done", "waiting", "working", "unclear", "error", "loop_guard", null] as const)(
    "freshly rejudges prior %s and uses a fixed plain-text continuation", async kind => {
      if (kind) history(kind)
      const judge = await start()
      expect(judge).not.toHaveBeenCalled()
      expect(jobs.some(job => job.at === clock + 8000)).toBe(true)
      await advance(8000)
      expect(judge).toHaveBeenCalledTimes(1)
      const packet = judge.mock.calls[0]![0]
      expect(packet).toMatchObject({ agent: "Copilot", cwd: project, lastBody: null, backgroundWork: false,
        periodicCheckIn: { priorJudgment: kind ? { kind, reason: "Historical reason, never authority" } : null } })
      expect(packet).not.toHaveProperty("networkRecovered")
      expect(prompts()).toEqual([`prompt S [Test Shepherd for the human] ${FIXED}`])
      expect(actions.some(action => action.startsWith("key "))).toBe(false)
    })

  it.each(["gate", "done", "waiting", "working", "unclear"] as const)(
    "leaves a fresh %s untouched and suppresses unchanged notices, status and wakes across cadence/reopen", async kind => {
      const judge = await start(vi.fn(async () => verdict(kind)))
      await advance(8000)
      const counts = [actions.length, notices.length, escalations.length]
      await advance(3_600_000)
      await advance(8000)
      expect(judge).toHaveBeenCalledTimes(2)
      expect([actions.length, notices.length, escalations.length]).toEqual(counts)
      await advance(2000)
      const wakeCount = wakes.length
      stop!(); stop = null
      await flush()
      await start(vi.fn(async () => verdict(kind)))
      await advance(8000)
      expect([actions.length, notices.length, escalations.length, wakes.length]).toEqual([...counts, wakeCount])
      expect(prompts()).toEqual([])
    })

  it.each(["draft", "composer", "activity", "background", "instance", "focused", "agent"] as const)(
    "never sends with unsafe/unknown %s evidence", async change => {
      const current = inspections.S!
      if (change === "draft") current.composer = "draft"
      if (change === "composer") current.composer = "unknown"
      if (change === "activity") current.activity = "unknown"
      if (change === "background") current.backgroundWork = true
      if (change === "instance") current.instance = null
      if (change === "focused") current.session.focused = true
      if (change === "agent") current.session.agent = null
      await start()
      await advance(8000)
      expect(prompts()).toEqual([])
    })

  it.each(["screen", "instance", "cwd", "draft"] as const)("refuses %s changing during the quiet interval", async change => {
    const judge = await start()
    if (change === "screen") inspections.S!.screen += "new output"
    if (change === "instance") inspections.S!.instance = "replacement"
    if (change === "cwd") inspections.S!.session.cwd = "/new"
    if (change === "draft") inspections.S!.composer = "draft"
    await advance(8000)
    expect(judge).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it.each(["focus", "return", "screen", "instance", "cwd", "draft", "pause", "stop"] as const)(
    "invalidates %s while the periodic judge is awaited", async change => {
      let release!: (value: JudgeResult) => void
      const judge = vi.fn((packet: ReturnPacket) => packet.periodicCheckIn
        ? new Promise<JudgeResult>(resolve => { release = resolve })
        : Promise.resolve(verdict("working")))
      await start(judge)
      await advance(8000)
      expect(release).toBeDefined()
      if (change === "focus") handlers.focused("S")
      if (change === "return") returned()
      if (change === "screen") inspections.S!.screen += "changed"
      if (change === "instance") inspections.S!.instance = "new"
      if (change === "cwd") inspections.S!.session.cwd = "/changed"
      if (change === "draft") inspections.S!.composer = "draft"
      if (change === "pause") await setShepherdSessionPause(root, { actorId: "owner", requestId: "pause",
        target: { host: "fake", session: "S", cwd: project, task: null }, paused: true }, [
        { host: "fake", session: "S", cwd: project, task: null },
      ])
      if (change === "stop") { stop!(); stop = null }
      release(verdict())
      await flush()
      expect(prompts()).toEqual([])
    })

  it("does not block an immediate return behind the outside-chain quiet timer", async () => {
    inspections.T = inspection("T")
    const judge = await start(vi.fn(async packet => verdict(packet.periodicCheckIn ? "done" : "gate")))
    returned("T")
    await flush()
    expect(judge).toHaveBeenCalledTimes(1)
    expect(judge.mock.calls[0]![0]).not.toHaveProperty("periodicCheckIn")
    await advance(8000)
    expect(judge.mock.calls.some(([packet]) => packet.periodicCheckIn)).toBe(true)
  })

  it.each([0, 30, 60, 1440])("uses actual-dequeue %s-minute cadence without catch-up bursts", async minutes => {
    configure(minutes)
    const judge = await start(vi.fn(async () => verdict("gate")))
    if (minutes === 0) {
      expect(jobs).toEqual([])
      await advance(24 * 3_600_000)
      expect(judge).not.toHaveBeenCalled()
      return
    }
    await advance(8000)
    expect(jobs.some(job => job.at === startedAt + minutes * 60_000)).toBe(true)
    await advance(minutes * 60_000 * 10)
    expect(judge).toHaveBeenCalledTimes(1)
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(jobs.filter(job => job.at > clock + 8000)).toHaveLength(1)
  })

  it("does not schedule an unsupported host and continues after one terminal inspection fails", async () => {
    inspections.T = inspection("T")
    vi.mocked(host.inspect!).mockImplementation(async id => {
      if (id === "S") throw new Error("one terminal unavailable")
      return captureInspection(id)
    })
    const judge = await start()
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(prompts()[0]).toContain("prompt T ")
    stop!(); stop = null
    await flush()
    delete host.inspect
    const unsupported = await start()
    await advance(3_600_000)
    expect(unsupported).not.toHaveBeenCalled()
  })

  it("never turns a model-selected menu key into a scheduled approval", async () => {
    await start(vi.fn(async () => ({ ...verdict(), reply: { key: "enter" } })))
    await advance(8000)
    expect(prompts()).toEqual([])
    expect(actions.some(action => action.startsWith("key "))).toBe(false)
    const record = readReturns(root).at(-1)!
    expect(record).toMatchObject({ action: "let_through", actionBlockReason: "menu_disallowed", reply: null })
    expect(record).not.toHaveProperty("dispatch")
  })

  it("keeps an uncertain immediate send blocked after restart, changed screen and periodic trigger", async () => {
    host.continueInput = async () => { actions.push("prompt attempted"); throw new Error("acceptance uncertain") }
    await start()
    returned()
    await flush()
    expect(prompts()).toHaveLength(1)
    stop!(); stop = null
    await flush()
    inspections.S!.screen += " Different evidence after lost connection"
    await start()
    await advance(8000)
    expect(prompts()).toHaveLength(1)
    expect(readReturns(root).at(-1)?.action).toBe("let_through")
  })

  it("never claims guarded not-sent as success and never retries it within the same pass", async () => {
    host.continueInput = vi.fn(async () => ({ state: "not_sent", reason: "draft appeared" }))
    await start()
    await advance(8000)
    expect(host.continueInput).toHaveBeenCalledTimes(1)
    expect(readReturns(root).at(-1)).toMatchObject({ action: "let_through", reply: null })
    await advance(3_600_000)
    await advance(8000)
    expect(host.continueInput).toHaveBeenCalledTimes(2)
  })

  it.each(["focus", "return", "stop", "revision", "corrupt"] as const)(
    "revokes dispatch on %s during the guarded adapter's awaited lookup", async change => {
      host.continueInput = vi.fn(async (request, canSend) => {
        const id = request.expected.session.id
        await Promise.resolve()
        if (change === "focus") handlers.focused(id)
        if (change === "return") returned(id)
        if (change === "stop") { stop!(); stop = null }
        if (change === "revision") await recordShepherdCorrection(root, { actorId: "owner", requestId: "learn",
          target: { host: "fake", session: id, cwd: project, task: null }, feedback: "Wait.",
          principle: "Wait for review." }, [{ host: "fake", session: id, cwd: project, task: null }])
        if (change === "corrupt") fs.writeFileSync(path.join(root, "state/senses/shepherd/guidance.json"), "corrupt")
        if (!canSend()) return { state: "not_sent", reason: "parent guard invalidated" }
        throw new Error("test input guard unexpectedly admitted")
      })
      await start(vi.fn(async packet => verdict(packet.periodicCheckIn ? "premature" : "working")))
      await advance(8000)
      expect(prompts()).toEqual([])
    })

  it.each(["focus", "return", "cwd", "missing", "stop"] as const)(
    "revalidates %s after awaited native capability discovery", async change => {
      const original = host.capabilities!
      host.capabilities = async () => {
        const capabilities = await original()
        if (change === "focus") handlers.focused("S")
        if (change === "return") returned()
        if (change === "cwd") inspections.S!.session.cwd = "/different"
        if (change === "missing") delete inspections.S
        if (change === "stop") { stop!(); stop = null }
        return capabilities
      }
      await start(vi.fn(async packet => verdict(packet.periodicCheckIn ? "premature" : "working")))
      await advance(8000)
      expect(prompts()).toEqual([])
    })

  it.each(["focus", "return", "screen", "instance", "cwd", "draft", "background", "stop"] as const)(
    "revalidates %s after the final awaited inspection", async change => {
      let reads = 0
      vi.mocked(host.inspect!).mockImplementation(async id => {
        if (++reads === 3) {
          if (change === "focus") handlers.focused(id)
          if (change === "return") returned(id)
          if (change === "screen") inspections[id]!.screen += "different"
          if (change === "instance") inspections[id]!.instance = "different"
          if (change === "cwd") inspections[id]!.session.cwd = "/different"
          if (change === "draft") inspections[id]!.composer = "draft"
          if (change === "background") inspections[id]!.backgroundWork = true
          if (change === "stop") { stop!(); stop = null }
        }
        return captureInspection(id)
      })
      await start(vi.fn(async packet => verdict(packet.periodicCheckIn ? "premature" : "working")))
      await advance(8000)
      expect(prompts()).toEqual([])
    })

  it("keeps the shared streak through long periodic intervals and suppresses repeated tripped-guard notices", async () => {
    const judge = await start()
    await advance(8000)
    for (let index = 1; index <= 3; index++) {
      inspections.S!.screen += `\nFresh progress ${index}`
      await advance(3_600_000)
      await advance(8000)
    }
    expect(prompts()).toHaveLength(3)
    expect(readReturns(root).at(-1)?.kind).toBe("loop_guard")
    const count = notices.length
    await advance(3_600_000)
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(4)
    expect(notices).toHaveLength(count)
  })

  it("retains a scheduled-count badge as evidence without treating it as active background work", async () => {
    inspections.S!.screen += "\n1 scheduled prompt"
    const judge = await start()
    await advance(8000)
    expect(judge.mock.calls[0]![0]).toMatchObject({ backgroundWork: false })
    expect(prompts()).toHaveLength(1)
  })

  it("does not duplicate a notice just because the judge phrases the same blocker differently", async () => {
    const judge = vi.fn(async () => ({ ...verdict("gate"), reason: `Same blocker, phrasing ${clock}` }))
    await start(judge)
    await advance(8000)
    await advance(3_600_000)
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(notices).toHaveLength(1)
    expect(escalations).toHaveLength(1)
    expect(actions.filter(action => action.startsWith("status "))).toHaveLength(1)
    inspections.S!.screen += "\nMeaningful new evidence"
    await advance(3_600_000)
    await advance(8000)
    expect(notices).toHaveLength(2)
  })

  it("starts without rotated history and does not confuse an absent agent with an eligible session", async () => {
    history("done", "absent")
    fs.renameSync(path.join(root, "state/senses/shepherd/returns.jsonl"), path.join(root, "state/senses/shepherd/returns.jsonl.1"))
    const judge = await start()
    await advance(8000)
    expect(judge.mock.calls[0]![0].periodicCheckIn?.priorJudgment).toBeNull()
    expect(prompts()).toHaveLength(1)
  })

  it("does not turn a durable capacity failure into input or success", async () => {
    let store: CheckInStore | undefined
    await start(undefined, { openCheckInStore: file => {
      store = openCheckInStore(file)
      vi.spyOn(store, "claimDispatch").mockImplementation(() => { throw new Error("database capacity") })
      return store
    } })
    await advance(8000)
    expect(prompts()).toEqual([])
    expect(readReturns(root).at(-1)).toMatchObject({ action: "let_through", reply: null })
    expect(readReturns(root).at(-1)?.reason).toContain("capacity")
    expect(store!.claimDispatch).toHaveBeenCalledTimes(1)
  })

  it("keeps an uncertain guarded send blocked even if its completion record also fails", async () => {
    host.continueInput = async () => { actions.push("prompt attempted"); throw new Error("input uncertain") }
    await start(undefined, { openCheckInStore: file => {
      const store = openCheckInStore(file)
      vi.spyOn(store, "completeDispatch").mockImplementation(() => { throw new Error("disk unavailable") })
      return store
    } })
    await advance(8000)
    expect(prompts()).toHaveLength(1)
    stop!(); stop = null
    await flush()
    inspections.S!.screen += "changed"
    await start()
    await advance(8000)
    expect(prompts()).toHaveLength(1)
  })

  it("cancels pending quiet work and recurring checks on shutdown", async () => {
    const judge = await start()
    stop!(); stop = null
    await flush()
    expect(jobs).toEqual([])
    await advance(3_600_000)
    expect(judge).not.toHaveBeenCalled()
  })

  it("retries read-only discovery on the next cadence after a failed host list", async () => {
    const listing = host.list
    host.list = vi.fn().mockRejectedValueOnce(new Error("list unavailable")).mockImplementation(listing)
    const judge = await start()
    expect(prompts()).toEqual([])
    await advance(3_600_000)
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it("keeps at most one pending quiet batch even when an overdue sweep arrives before its quiet callback", async () => {
    const judge = await start()
    const recurring = jobs.find(job => job.at === clock + 3_600_000)!
    jobs = jobs.filter(job => job !== recurring)
    clock += 3_600_000
    recurring.fn()
    await flush()
    expect(host.inspect).toHaveBeenCalledTimes(1)
    await advance(0)
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it.each(["stop", "identity", "focused", "agent", "working", "generation"] as const)(
    "rejects %s changing during the first inspection without scheduling stale input", async change => {
      inspections.T = inspection("T")
      vi.mocked(host.inspect!).mockImplementation(async id => {
        const current = captureInspection(id)
        if (id === "S") {
          if (change === "stop") { stop!(); stop = null }
          if (change === "identity") current.session.id = "wrong-target"
          if (change === "focused") current.session.focused = true
          if (change === "agent") current.session.agent = null
          if (change === "working") current.activity = "working"
          if (change === "generation") handlers.focused(id)
        }
        return current
      })
      const judge = await start()
      await advance(8000)
      expect(actions.some(action => action.startsWith("prompt S "))).toBe(false)
      if (change === "stop") expect(judge).not.toHaveBeenCalled()
      else expect(prompts()).toHaveLength(1)
    })

  it("does not process queued events or late focus callbacks after shutdown", async () => {
    const judge = await start()
    returned()
    stop!()
    handlers.focused("S")
    stop!(); stop = null
    await flush()
    expect(judge).not.toHaveBeenCalled()
  })

  it("stops a dequeued periodic discovery before any reads when shutdown won the race", async () => {
    const judge = await start()
    const recurring = jobs.find(job => job.at === clock + 3_600_000)!
    recurring.fn()
    stop!(); stop = null
    await flush()
    expect(host.inspect).toHaveBeenCalledTimes(1)
    expect(judge).not.toHaveBeenCalled()
  })

  it("drops absent live-return correlations without making another terminal's history authoritative", async () => {
    const judge = await start(vi.fn(async () => verdict("gate")))
    returned("absent")
    await flush()
    await advance(8000)
    await advance(3_600_000)
    await advance(8000)
    expect(prompts()).toEqual([])
    expect(judge.mock.calls.filter(([packet]) => packet.periodicCheckIn)).toHaveLength(2)
  })

  it("uses current null cwd and still diagnoses an unsupported guarded-input adapter", async () => {
    inspections.S!.session.cwd = null
    delete host.continueInput
    const judge = await start()
    await advance(8000)
    expect(judge.mock.calls[0]![0].cwd).toBeNull()
    expect(prompts()).toEqual([])
    expect(readReturns(root).at(-1)?.reason).toContain("native continuation boundary")
  })

  it("reports the changed outcome when a previously refused attempt is safely sent at a future cadence", async () => {
    const continuation = host.continueInput!
    host.continueInput = vi.fn()
      .mockResolvedValueOnce({ state: "not_sent", reason: "pre-input guard" })
      .mockImplementation(continuation)
    await start()
    await advance(8000)
    const statuses = actions.filter(action => action.startsWith("status ")).length
    await advance(3_600_000)
    await advance(8000)
    expect(prompts()).toHaveLength(1)
    expect(actions.filter(action => action.startsWith("status "))).toHaveLength(statuses + 1)
    expect(notices).toHaveLength(2)
  })

  it("ignores ISO observation timestamps only for notice suppression, not meaningful counters", async () => {
    inspections.S!.screen = "Build 42 awaits review. Observed 2026-10-16T04:00:00Z"
    await start(vi.fn(async () => verdict("gate")))
    await advance(8000)
    expect(notices).toHaveLength(1)
    inspections.S!.screen = "Build 42 awaits review. Observed 2026-10-16T05:00:00Z"
    await advance(3_600_000)
    await advance(8000)
    expect(notices).toHaveLength(1)
    inspections.S!.screen = "Build 43 awaits review. Observed 2026-10-16T06:00:00Z"
    await advance(3_600_000)
    await advance(8000)
    expect(notices).toHaveLength(2)
  })

  it("still closes custody when an unexpected synchronous callback rejects the serial chain", async () => {
    let rejectClock = false
    let closed = false
    await start(undefined, { now: () => {
      if (rejectClock) throw new Error("clock failed")
      return clock
    }, openCheckInStore: file => {
      const store = openCheckInStore(file)
      const close = store.close
      store.close = () => { closed = true; close() }
      return store
    } })
    rejectClock = true
    returned()
    await flush()
    stop!(); stop = null
    await flush()
    expect(closed).toBe(true)
    expect(prompts()).toEqual([])
  })

  it.each(["quiet", "judge"] as const)("detects raw changes hidden by redaction during %s", async phase => {
    const judge = await start(vi.fn(async () => {
      if (phase === "judge") inspections.S!.screenFingerprint = "raw-b"
      return verdict()
    }))
    if (phase === "quiet") inspections.S!.screenFingerprint = "raw-b"
    await advance(8000)
    expect(prompts()).toEqual([])
    expect(judge).toHaveBeenCalledTimes(phase === "quiet" ? 0 : 1)
  })

  it("keeps present immediate correlations and does not repeat an unchanged blocker at periodic rejudgment", async () => {
    const judge = await start(vi.fn(async () => verdict("gate")))
    returned()
    await flush()
    await advance(8000)
    await advance(3_600_000)
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(2)
    expect(prompts()).toEqual([])
    expect(notices).toHaveLength(1)
  })

  it("does not proceed to another candidate after shutdown during the first periodic judgment", async () => {
    inspections.T = inspection("T")
    const judge = await start(vi.fn(async () => { stop!(); stop = null; return verdict() }))
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(prompts()).toEqual([])
  })

  it("isolates a failed second observation without delaying another terminal's check-in", async () => {
    inspections.T = inspection("T")
    let observedS = false
    const original = host.inspect!
    host.inspect = async id => {
      if (id === "S" && observedS) throw new Error("second observation failed")
      if (id === "S") observedS = true
      return original(id)
    }
    const judge = await start()
    await advance(8000)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(prompts()).toHaveLength(1)
    expect(prompts()[0]).toContain("prompt T ")
  })

  it.each([5, 29, 1441, -1, 30.5])("refuses invalid %s-minute config before starting a watch", async minutes => {
    configure(minutes)
    host.watch = vi.fn(host.watch)
    await expect(start()).rejects.toThrow("checkInMinutes")
    expect(host.watch).not.toHaveBeenCalled()
    expect(jobs).toEqual([])
  })
})
