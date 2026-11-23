import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { ready, didKeyIdentityFromEd25519, sealEnvelope, wrapInDataPart, type DidKeyIdentity, type Sodium } from "@ouro.bot/friends/a2a-client"
import { FileFriendStore, upsertAgentPeer } from "@ouro.bot/friends"
import { createTmpBundle, type TmpBundleHandle } from "../test-helpers/tmpdir-bundle"
import { startFakeRelay, type FakeRelay } from "../test-helpers/fake-relay"
import { startA2AServer, type A2AServerHandle, type A2ATurnRunner, type A2ATurnRunnerInput } from "../../a2a/server"
import { relaySend } from "../../a2a/relay-client"
import { sealChatMessage } from "../../a2a/sealed-chat"
import { FileA2ATaskStore } from "../../a2a/task-store"
import * as nervesRuntime from "../../nerves/runtime"
import type { RelayConfig, RelayConfigStore } from "../../a2a/relay-inbox"
import type { A2AIdentity } from "../../a2a/identity"
import type { A2AJsonRpcResponse, A2ATask } from "../../a2a/types"
import { openInboundJournal, readInboundOutcome } from "../../senses/inbound-journal"
import * as failureReports from "../../heart/failure-reports"
import * as relationshipAuthorization from "../../repertoire/relationship-authorization"
import * as net from "node:net"

// Every A2A inbound is written down before its turn runs and ends in exactly one recorded outcome: answered,
// a visible failure, or canceled. A process that dies mid-turn leaves it pending, and the next process replays
// a relayed message or records why a direct one can't be answered.

let sodium: Sodium
const bundles: TmpBundleHandle[] = []
const closers: Array<() => Promise<void>> = []

beforeAll(async () => {
  sodium = await ready()
})

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const bundle of bundles.splice(0)) bundle.cleanup()
})

function bundle(name: string): TmpBundleHandle {
  const created = createTmpBundle({ agentName: name })
  bundles.push(created)
  return created
}

async function start(options: Parameters<typeof startA2AServer>[0]): Promise<A2AServerHandle> {
  const server = await startA2AServer(options)
  closers.push(() => server.close())
  return server
}

async function postRpc(server: A2AServerHandle, method: string, params: unknown): Promise<A2AJsonRpcResponse> {
  const response = await fetch(server.endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", method, params }),
  })
  return await response.json() as A2AJsonRpcResponse
}

function textMessage(text: string, extra: Record<string, unknown> = {}): unknown {
  return { message: { role: "ROLE_USER", messageId: `m-${text}`, parts: [{ text }], ...extra } }
}

function taskOf(response: A2AJsonRpcResponse): A2ATask {
  if ("error" in response) throw new Error(response.error.message)
  return response.result as A2ATask
}

function tokenOf(task: A2ATask): string {
  return (task.metadata?.a2a as { accessToken: string }).accessToken
}

function pendingIds(agentRoot: string): string[] {
  return openInboundJournal(agentRoot, "a2a").pending().map((entry) => entry.id)
}

function outcomes(agentRoot: string): Array<{ outcome: string; attempts: number; detail?: string }> {
  const dir = path.join(agentRoot, "state", "senses", "a2a", "inbound-outcomes")
  return fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as { outcome: string; attempts: number; detail?: string })
}

/** Leave a relayed message pending in the journal, as a process that died mid-turn would. */
function journalRelayed(agentRoot: string, id: string, extra: Record<string, unknown> = {}): void {
  openInboundJournal(agentRoot, "a2a").record(id, {
    origin: "relay",
    responseStyle: "legacy",
    taskId: `task-${id}`,
    accessTokenHash: `hash-${id}`,
    contextId: "default",
    inbound: { role: "ROLE_USER", messageId: `m-${id}`, parts: [{ text: id }] },
    peerAgentId: "a2a-peer",
    peerName: "Peer",
    text: id,
    ...extra,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A turn runner that waits until the test lets it go or its signal aborts. */
function heldTurn(): { runner: A2ATurnRunner; started: Promise<A2ATurnRunnerInput>; release: (response: string) => void } {
  let onStart!: (input: A2ATurnRunnerInput) => void
  const started = new Promise<A2ATurnRunnerInput>((resolve) => { onStart = resolve })
  let release!: (response: string) => void
  const released = new Promise<string>((resolve) => { release = resolve })
  const runner: A2ATurnRunner = async (input) => {
    input.onTurnStart?.()
    onStart(input)
    const response = await new Promise<string>((resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(input.signal!.reason), { once: true })
      void released.then(resolve)
    })
    return { response }
  }
  return { runner, started, release }
}

describe("A2A inbound outcomes", () => {
  it("records a message before its turn runs and settles it as answered", async () => {
    const tmp = bundle("a2a-outcome-answered")
    let pendingDuringTurn: string[] = []
    const server = await start({
      agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0,
      turnRunner: async () => {
        pendingDuringTurn = pendingIds(tmp.agentRoot)
        return { response: "hi back" }
      },
    })

    const task = taskOf(await postRpc(server, "SendMessage", textMessage("hello")))
    expect(task.status.state).toBe("TASK_STATE_COMPLETED")
    expect(pendingDuringTurn).toHaveLength(1)
    expect(pendingIds(tmp.agentRoot)).toEqual([])
    expect(readInboundOutcome(tmp.agentRoot, "a2a", pendingDuringTurn[0]!)).toMatchObject({ outcome: "answered", attempts: 1 })
  })

  it("ends a turn that throws as a FAILED task carrying the error, not one left WORKING", async () => {
    const tmp = bundle("a2a-outcome-failed")
    const server = await start({
      agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0,
      turnRunner: async () => { throw new Error("provider down") },
    })

    const rpc = await postRpc(server, "SendMessage", textMessage("hello"))
    if (!("error" in rpc)) throw new Error("expected an error")
    expect(rpc.error.message).toBe("provider down")
    const data = rpc.error.data as { taskId: string; accessToken: string; state: string }
    expect(data.state).toBe("TASK_STATE_FAILED")

    const fetched = taskOf(await postRpc(server, "GetTask", { id: data.taskId, accessToken: data.accessToken }))
    expect(fetched.status.state).toBe("TASK_STATE_FAILED")
    expect(fetched.status.message?.parts[0]?.text).toContain("provider down")
    expect(pendingIds(tmp.agentRoot)).toEqual([])
  })

  it("stops a turn that runs past its deadline and records it as failed", async () => {
    const tmp = bundle("a2a-outcome-deadline")
    const held = heldTurn()
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: held.runner, turnTimeoutMs: 50 })

    const rpc = await postRpc(server, "SendMessage", textMessage("slow"))
    if (!("error" in rpc)) throw new Error("expected an error")
    expect(rpc.error.message).toContain("stopped after")
    expect((rpc.error.data as { state: string }).state).toBe("TASK_STATE_FAILED")
    expect((await held.started).signal?.aborted).toBe(true)
    expect(pendingIds(tmp.agentRoot)).toEqual([])
  })

  it("lets CancelTask stop the running turn, and the turn's end does not overwrite CANCELED", async () => {
    const tmp = bundle("a2a-outcome-cancel")
    let runner: A2ATurnRunner = async () => ({ response: "first answer" })
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: (input) => runner(input) })

    // An open task (one waiting for more input) the sender continues.
    const first = taskOf(await postRpc(server, "SendMessage", textMessage("start")))
    const token = tokenOf(first)
    const taskDir = path.join(tmp.agentRoot, "state", "a2a", "tasks")
    const [taskFile] = fs.readdirSync(taskDir).map((name) => path.join(taskDir, name))
    const stored = JSON.parse(fs.readFileSync(taskFile!, "utf-8")) as A2ATask
    fs.writeFileSync(taskFile!, JSON.stringify({ ...stored, status: { ...stored.status, state: "TASK_STATE_INPUT_REQUIRED" } }))

    const held = heldTurn()
    runner = held.runner
    const continued = postRpc(server, "SendMessage", { accessToken: token, ...(textMessage("more", { taskId: first.id }) as object) })
    const input = await held.started

    const canceled = taskOf(await postRpc(server, "CancelTask", { id: first.id, accessToken: token }))
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED")
    expect(input.signal?.aborted).toBe(true)

    const reply = taskOf(await continued)
    expect(reply.status.state).toBe("TASK_STATE_CANCELED")
    const fetched = taskOf(await postRpc(server, "GetTask", { id: first.id, accessToken: token }))
    expect(fetched.status.state).toBe("TASK_STATE_CANCELED")
    expect(pendingIds(tmp.agentRoot)).toEqual([])
  })

  it("keeps a canceled task CANCELED even when its turn ignores the cancel and answers", async () => {
    const tmp = bundle("a2a-outcome-cancel-ignored")
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let onStart!: () => void
    const started = new Promise<void>((resolve) => { onStart = resolve })
    let runner: A2ATurnRunner = async () => ({ response: "first answer" })
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: (input) => runner(input) })
    const first = taskOf(await postRpc(server, "SendMessage", textMessage("start")))
    const token = tokenOf(first)
    const taskDir = path.join(tmp.agentRoot, "state", "a2a", "tasks")
    const [taskFile] = fs.readdirSync(taskDir).map((name) => path.join(taskDir, name))
    const stored = JSON.parse(fs.readFileSync(taskFile!, "utf-8")) as A2ATask
    fs.writeFileSync(taskFile!, JSON.stringify({ ...stored, status: { ...stored.status, state: "TASK_STATE_INPUT_REQUIRED" } }))

    runner = async () => { onStart(); await released; return { response: "answered anyway" } }
    const continued = postRpc(server, "SendMessage", { accessToken: token, ...(textMessage("more", { taskId: first.id }) as object) })
    await started
    await postRpc(server, "CancelTask", { id: first.id, accessToken: token })
    release()
    expect(taskOf(await continued).status.state).toBe("TASK_STATE_CANCELED")
    expect(taskOf(await postRpc(server, "GetTask", { id: first.id, accessToken: token })).status.state).toBe("TASK_STATE_CANCELED")
  })

  it("answers an in-flight direct message with a failure on shutdown instead of leaving it hanging", async () => {
    const tmp = bundle("a2a-outcome-shutdown")
    const held = heldTurn()
    const server = await startA2AServer({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: held.runner })
    const sent = postRpc(server, "SendMessage", textMessage("hello"))
    await held.started
    const [inboundId] = pendingIds(tmp.agentRoot)

    await server.close()
    const rpc = await sent
    if (!("error" in rpc)) throw new Error("expected an error")
    expect(rpc.error.message).toContain("stopped before answering")
    expect(pendingIds(tmp.agentRoot)).toEqual([])
    expect(readInboundOutcome(tmp.agentRoot, "a2a", inboundId!)).toMatchObject({ outcome: "failed" })
  })

  it("answers with a JSON-RPC error when the task store cannot be written", async () => {
    const tmp = bundle("a2a-outcome-store-error")
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async () => ({ response: "unused" }) })
    const put = vi.spyOn(FileA2ATaskStore.prototype, "put").mockImplementation(() => { throw new Error("disk full") })
    try {
      const rpc = await postRpc(server, "SendMessage", textMessage("hello"))
      expect("error" in rpc ? rpc.error : null).toMatchObject({ code: -32000, message: "disk full" })
    } finally {
      put.mockRestore()
    }
    // The journal still records the failure, so nothing is left pending for the life of the process.
    expect(pendingIds(tmp.agentRoot)).toEqual([])
    expect(outcomes(tmp.agentRoot)).toEqual([expect.objectContaining({ outcome: "failed", detail: "disk full" })])
  })

  it("answers with a JSON-RPC error when a request fails outside any turn", async () => {
    const tmp = bundle("a2a-outcome-request-error")
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async () => ({ response: "unused" }) })
    const get = vi.spyOn(FileA2ATaskStore.prototype, "get").mockImplementation(() => { throw new Error("disk gone") })
    try {
      const rpc = await postRpc(server, "GetTask", { id: "task-1", accessToken: "token-1" })
      expect("error" in rpc ? rpc.error : null).toMatchObject({ code: -32000, message: "disk gone" })
    } finally {
      get.mockRestore()
    }
  })

  it("records a turn whose answer cannot be stored as a visible failure", async () => {
    const tmp = bundle("a2a-outcome-answer-store-error")
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async () => ({ response: "lost" }) })
    const realPut = FileA2ATaskStore.prototype.put
    const put = vi.spyOn(FileA2ATaskStore.prototype, "put").mockImplementation(function (this: FileA2ATaskStore, task, scope) {
      if (task.status.state === "TASK_STATE_COMPLETED") throw new Error("disk full")
      realPut.call(this, task, scope)
    })
    let rpc: A2AJsonRpcResponse
    try {
      rpc = await postRpc(server, "SendMessage", textMessage("hello"))
    } finally {
      put.mockRestore()
    }
    if (!("error" in rpc)) throw new Error("expected an error")
    const data = rpc.error.data as { taskId: string; accessToken: string; state: string }
    expect(data.state).toBe("TASK_STATE_FAILED")
    expect(taskOf(await postRpc(server, "GetTask", { id: data.taskId, accessToken: data.accessToken })).status.state).toBe("TASK_STATE_FAILED")
    expect(outcomes(tmp.agentRoot)).toEqual([expect.objectContaining({ outcome: "failed", detail: "disk full" })])
  })

  it("records a pending direct message as failed even when its FAILED task cannot be written", async () => {
    const tmp = bundle("a2a-outcome-replay-store-error")
    const crashed = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: () => new Promise(() => undefined) })
    const abandoned = postRpc(crashed, "SendMessage", textMessage("hello")).catch((error: unknown) => error)
    await vi.waitFor(() => expect(pendingIds(tmp.agentRoot)).toHaveLength(1))
    crashed.server.closeAllConnections()
    await abandoned

    const put = vi.spyOn(FileA2ATaskStore.prototype, "put").mockImplementation(() => { throw new Error("disk full") })
    try {
      const next = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async () => ({ response: "unused" }) })
      await next.replayed
    } finally {
      put.mockRestore()
    }
    expect(pendingIds(tmp.agentRoot)).toEqual([])
    expect(outcomes(tmp.agentRoot)).toEqual([expect.objectContaining({ outcome: "failed", detail: expect.stringContaining("stopped before answering") })])
  })

  it("keeps replaying the other pending messages when one of them throws, and counts the attempt", async () => {
    const tmp = bundle("a2a-outcome-replay-isolated")
    journalRelayed(tmp.agentRoot, "first")
    journalRelayed(tmp.agentRoot, "second")
    const get = vi.spyOn(FileA2ATaskStore.prototype, "get").mockImplementationOnce(() => { throw new Error("corrupt task file") })
    const nerves = vi.spyOn(nervesRuntime, "emitNervesEvent")
    const turns: string[] = []
    try {
      const next = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async (input) => { turns.push(input.message); return { response: "ok" } } })
      await next.replayed
      expect(nerves.mock.calls.map(([event]) => event.event)).toContain("channel.a2a_inbound_replay_error")
    } finally {
      get.mockRestore()
      nerves.mockRestore()
    }
    expect(turns).toEqual(["second"])
    expect(readInboundOutcome(tmp.agentRoot, "a2a", "second")).toMatchObject({ outcome: "answered" })
    // The one that threw stays pending with the attempt counted, so it cannot block every start for good.
    expect(openInboundJournal(tmp.agentRoot, "a2a").pending()).toEqual([expect.objectContaining({ id: "first", attempts: 1 })])
  })

  it("does not run a delegated command again after a restart, and records why", async () => {
    const tmp = bundle("a2a-outcome-replay-delegated")
    journalRelayed(tmp.agentRoot, "delegated", { verifiedChat: { did: "did:key:z6Mkpeer", friendId: "friend-1", onBehalfOf: "principal", issuedAt: "2026-11-22T00:00:00.000Z" } })
    const turns: A2ATurnRunnerInput[] = []
    const next = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async (input) => { turns.push(input); return { response: "unused" } } })
    await next.replayed
    expect(turns).toEqual([])
    expect(readInboundOutcome(tmp.agentRoot, "a2a", "delegated")).toMatchObject({ outcome: "failed", detail: expect.stringContaining("delegated command") })
  })

  it.each([
    ["TASK_STATE_COMPLETED", "answered"],
    ["TASK_STATE_CANCELED", "canceled"],
  ])("settles a pending message whose task already reached %s instead of running it again", async (state, outcome) => {
    const tmp = bundle(`a2a-outcome-replay-${outcome}`)
    journalRelayed(tmp.agentRoot, "finished")
    new FileA2ATaskStore(tmp.agentRoot).put({ id: "task-finished", contextId: "default", status: { state: state as A2ATask["status"]["state"], timestamp: new Date().toISOString() }, history: [] }, "a2a-task-token:hash-finished")
    const turns: A2ATurnRunnerInput[] = []
    const next = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async (input) => { turns.push(input); return { response: "again" } } })
    await next.replayed
    expect(turns).toEqual([])
    expect(readInboundOutcome(tmp.agentRoot, "a2a", "finished")).toMatchObject({ outcome })
  })

  it("stops replaying when the server shuts down, and spends no attempt on what it did not finish", async () => {
    const tmp = bundle("a2a-outcome-replay-shutdown")
    journalRelayed(tmp.agentRoot, "first")
    journalRelayed(tmp.agentRoot, "second")
    const held = heldTurn()
    const server = await startA2AServer({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: held.runner })
    expect((await held.started).message).toBe("first")
    await server.close()
    await server.replayed
    expect(openInboundJournal(tmp.agentRoot, "a2a").pending().map((entry) => [entry.id, entry.attempts])).toEqual([["first", 0], ["second", 0]])
  })

  it("skips a left-over message that was settled while the replay worked through the ones before it", async () => {
    const tmp = bundle("a2a-outcome-replay-settled-meanwhile")
    journalRelayed(tmp.agentRoot, "first")
    journalRelayed(tmp.agentRoot, "second")
    const held = heldTurn()
    const turns: string[] = []
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async (input) => { turns.push(input.message); return held.runner(input) } })
    await held.started
    openInboundJournal(tmp.agentRoot, "a2a").settle("second", "canceled")
    held.release("done")
    await server.replayed
    expect(turns).toEqual(["first"])
    expect(readInboundOutcome(tmp.agentRoot, "a2a", "second")).toMatchObject({ outcome: "canceled" })
  })

  it("does not take a message that arrives while the server is starting for one an earlier process left", async () => {
    const tmp = bundle("a2a-outcome-startup-window")
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as net.AddressInfo
        probe.close(() => resolve(free))
      })
    })
    // Startup waits on its failure reports after it starts listening; a message can arrive in that time.
    let releaseStartup!: () => void
    const startupGate = new Promise<void>((resolve) => { releaseStartup = resolve })
    const reports = vi.spyOn(failureReports, "dispatchPendingFailureReports").mockImplementation(async () => { await startupGate; return undefined as never })
    const held = heldTurn()
    try {
      const starting = startA2AServer({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, host: "127.0.0.1", port, turnRunner: held.runner })
      const sent = (async () => {
        const response = await fetch(`http://127.0.0.1:${port}/a2a`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", method: "SendMessage", params: textMessage("early") }) })
        return await response.json() as A2AJsonRpcResponse
      })()
      await held.started
      releaseStartup()
      const server = await starting
      closers.push(() => server.close())
      await server.replayed
      held.release("on time")
      expect(taskOf(await sent).status.state).toBe("TASK_STATE_COMPLETED")
    } finally {
      reports.mockRestore()
    }
    expect(outcomes(tmp.agentRoot)).toEqual([expect.objectContaining({ outcome: "answered" })])
  })

  it("does not start a new deadline for a turn that reports its start after it was stopped", async () => {
    const tmp = bundle("a2a-outcome-late-start")
    let lateStart: Promise<void> | undefined
    const server = await start({
      agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnTimeoutMs: 50,
      turnRunner: (input) => new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => {
          lateStart = sleep(20).then(() => input.onTurnStart?.())
          reject(input.signal!.reason)
        }, { once: true })
      }),
    })
    const rpc = await postRpc(server, "SendMessage", textMessage("late"))
    expect("error" in rpc).toBe(true)
    await lateStart
    expect(outcomes(tmp.agentRoot)).toEqual([expect.objectContaining({ outcome: "failed" })])
  })

  it("does not count time spent waiting for the turn ahead against the turn's own deadline", async () => {
    const tmp = bundle("a2a-outcome-deadline-queue")
    const server = await start({
      agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnTimeoutMs: 1_000,
      turnRunner: async (input) => {
        await sleep(600)
        input.onTurnStart?.()
        await sleep(600)
        return { response: "made it" }
      },
    })
    expect(taskOf(await postRpc(server, "SendMessage", textMessage("queued"))).status.state).toBe("TASK_STATE_COMPLETED")
  })

  it("records a turn that never got its place in the queue as failed once it has waited a full deadline", async () => {
    const tmp = bundle("a2a-outcome-deadline-never-started")
    const server = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnTimeoutMs: 50, turnRunner: () => new Promise(() => undefined) })
    const rpc = await postRpc(server, "SendMessage", textMessage("stuck in line"))
    if (!("error" in rpc)) throw new Error("expected an error")
    expect(rpc.error.message).toContain("waiting for the turn ahead")
    expect(outcomes(tmp.agentRoot)).toEqual([expect.objectContaining({ outcome: "failed" })])
  })

  it("records a direct message whose process died mid-turn as failed at the next start", async () => {
    const tmp = bundle("a2a-outcome-crash-direct")
    // The first process hangs in its turn and never answers.
    const crashed = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: () => new Promise(() => undefined) })
    const abandoned = postRpc(crashed, "SendMessage", textMessage("hello")).catch((error: unknown) => error)
    await vi.waitFor(() => expect(pendingIds(tmp.agentRoot)).toHaveLength(1))
    const [inboundId] = pendingIds(tmp.agentRoot)
    crashed.server.closeAllConnections()
    await abandoned

    const turns: A2ATurnRunnerInput[] = []
    const next = await start({ agentName: tmp.agentName, agentRoot: tmp.agentRoot, port: 0, turnRunner: async (input) => { turns.push(input); return { response: "late" } } })
    await next.replayed
    // The sender saw the connection drop and has no way to receive a late answer, so it is not run again.
    expect(turns).toEqual([])
    expect(readInboundOutcome(tmp.agentRoot, "a2a", inboundId!)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("stopped before answering") })
    const taskDir = path.join(tmp.agentRoot, "state", "a2a", "tasks")
    const states = fs.readdirSync(taskDir).map((name) => (JSON.parse(fs.readFileSync(path.join(taskDir, name), "utf-8")) as A2ATask).status.state)
    expect(states).toEqual(["TASK_STATE_FAILED"])
  })
})

describe("A2A relayed inbound outcomes", () => {
  function seededIdentity(): A2AIdentity & DidKeyIdentity {
    const seedBytes = sodium.randombytes_buf(32)
    const kp = sodium.crypto_sign_seed_keypair(seedBytes)
    return { ...didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey }), seed: Buffer.from(seedBytes).toString("base64url") }
  }

  function memoryRelayConfig(initial: RelayConfig): RelayConfigStore & { current: RelayConfig } {
    const holder = {
      current: { ...initial },
      async read() { return structuredClone(holder.current) },
      async write(patch: Partial<Record<keyof RelayConfig, unknown>>) {
        const next: Record<string, unknown> = { ...holder.current, ...patch }
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
        holder.current = next as RelayConfig
      },
    }
    return holder
  }

  async function relayedPeer(name: string) {
    const relay: FakeRelay = await startFakeRelay()
    closers.push(() => relay.close())
    const peerBundle = bundle(name)
    const sender = seededIdentity()
    const peer = seededIdentity()
    const peerFriends = new FileFriendStore(`${peerBundle.agentRoot}/friends`)
    await upsertAgentPeer(peerFriends, { name: "Sender", agentId: sender.did, trustLevel: "family", a2a: { did: sender.did, agentId: sender.did, endpointUrl: "https://sender.example/a2a" } })
    const senderOnPeer = (await peerFriends.findByExternalId("a2a-agent", sender.did))!
    await peerFriends.put(senderOnPeer.id, { ...senderOnPeer, admissionState: "active" })
    const relayConfig = memoryRelayConfig({ url: relay.url, inviteToken: "invite-1" })
    const startPeer = async (turnRunner: A2ATurnRunner): Promise<A2AServerHandle> => {
      const server = await startA2AServer({
        agentName: peerBundle.agentName, agentRoot: peerBundle.agentRoot, port: 0, identity: peer, turnRunner,
        relay: { config: relayConfig, intervalMs: 60 * 60_000 },
      })
      return server
    }
    const queue = async () => {
      const registration = relayConfig.current.registration!
      const sealed = sealEnvelope({ sodium, envelope: { subject: { missionKey: `dm:${sender.did}:${peer.did}`, title: "Direct message" }, fromAgentId: sender.did, intent: "offer", note: "hello", issuedAt: new Date().toISOString() }, friendsKind: "coordination", fromIdentity: sender, recipientDid: peer.did, recipientX25519Pub: peer.x25519Pub })
      await relaySend({ url: relay.url, handle: registration.handle, sendCredential: registration.sendCredential, message: wrapInDataPart({ sealedEnvelope: sealed, recipientDid: peer.did }) })
    }
    const queueChat = async (text: string) => {
      const registration = relayConfig.current.registration!
      const chat = sealChatMessage({ sodium, from: sender, recipientDid: peer.did, recipientEd25519Pub: peer.ed25519Pub, text, conversationId: "chat-1" })
      await relaySend({ url: relay.url, handle: registration.handle, sendCredential: registration.sendCredential, message: { messageId: `chat-${text}`, parts: chat.parts } })
    }
    /** Queue a chat while offline, then let a process verify it and die in its turn. */
    const crashMidChat = async (text: string): Promise<string> => {
      const registering = await startPeer(async () => ({ response: "unused" }))
      await registering.relay!.ready
      await registering.close()
      await queueChat(text)
      const crashed = await startPeer(() => new Promise(() => undefined))
      closers.push(() => crashed.close())
      await vi.waitFor(() => expect(pendingIds(peerBundle.agentRoot)).toHaveLength(1))
      crashed.relay!.stop()
      return pendingIds(peerBundle.agentRoot)[0]!
    }
    return { relay, peerBundle, peerFriends, relayConfig, startPeer, queue, queueChat, crashMidChat, sender, peer }
  }

  it("records a failure when a message fails before its turn could start", async () => {
    const setup = await relayedPeer("a2a-outcome-pre-turn-throw")
    const registering = await setup.startPeer(async () => ({ response: "unused" }))
    await registering.relay!.ready
    await registering.close()
    await setup.queueChat("hello")
    const registry = vi.spyOn(relationshipAuthorization, "loadRelationshipCapabilityRegistry").mockReturnValue({} as never)
    const evaluator = vi.spyOn(relationshipAuthorization, "createRelationshipAuthorizationEvaluator").mockImplementation(() => { throw new Error("registry unreadable") })
    const turns: A2ATurnRunnerInput[] = []
    try {
      const server = await setup.startPeer(async (input) => { turns.push(input); return { response: "unused" } })
      closers.push(() => server.close())
      await vi.waitFor(() => expect(outcomes(setup.peerBundle.agentRoot)).toEqual([expect.objectContaining({ outcome: "failed", detail: "registry unreadable" })]))
    } finally {
      registry.mockRestore()
      evaluator.mockRestore()
    }
    expect(turns).toEqual([])
    expect(pendingIds(setup.peerBundle.agentRoot)).toEqual([])
  }, 30_000)


  it("replays a relayed chat at the next start as the verified sender, and seals the reply to it", async () => {
    const setup = await relayedPeer("a2a-outcome-chat-replay")
    const inboundId = await setup.crashMidChat("are you there?")

    const turns: A2ATurnRunnerInput[] = []
    const next = await setup.startPeer(async (input) => { turns.push(input); return { response: "yes" } })
    closers.push(() => next.close())
    await next.replayed
    expect(turns.map((turn) => turn.message)).toEqual(["are you there?"])
    expect(turns[0]).toMatchObject({ peerAgentId: setup.sender.did, peerName: "Sender" })
    expect(readInboundOutcome(setup.peerBundle.agentRoot, "a2a", inboundId)).toMatchObject({ outcome: "answered", attempts: 2 })
    const taskDir = path.join(setup.peerBundle.agentRoot, "state", "a2a", "tasks")
    const [task] = fs.readdirSync(taskDir).map((name) => JSON.parse(fs.readFileSync(path.join(taskDir, name), "utf-8")) as A2ATask)
    expect(task?.status.state).toBe("TASK_STATE_COMPLETED")
    expect(JSON.stringify(task?.status.message)).not.toContain("yes")
  }, 30_000)

  it("records a pending relayed chat as failed when its sender's friend record is gone", async () => {
    const setup = await relayedPeer("a2a-outcome-chat-unfriended")
    const inboundId = await setup.crashMidChat("hello")
    const senderOnPeer = (await setup.peerFriends.findByExternalId("a2a-agent", setup.sender.did))!
    await setup.peerFriends.delete(senderOnPeer.id)

    const turns: A2ATurnRunnerInput[] = []
    const next = await setup.startPeer(async (input) => { turns.push(input); return { response: "unused" } })
    closers.push(() => next.close())
    await next.replayed
    expect(turns).toEqual([])
    expect(readInboundOutcome(setup.peerBundle.agentRoot, "a2a", inboundId)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("friend record") })
  }, 30_000)

  it("records a pending relayed chat as failed when the agent comes back without its A2A identity", async () => {
    const setup = await relayedPeer("a2a-outcome-chat-no-identity")
    const inboundId = await setup.crashMidChat("hello")

    const next = await start({ agentName: setup.peerBundle.agentName, agentRoot: setup.peerBundle.agentRoot, port: 0, turnRunner: async () => ({ response: "unused" }) })
    await next.replayed
    expect(readInboundOutcome(setup.peerBundle.agentRoot, "a2a", inboundId)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("A2A identity") })
  }, 30_000)

  it("replays a relayed message whose process died mid-turn at the next start, counting the attempt", async () => {
    const setup = await relayedPeer("a2a-outcome-crash-relay")
    // Register the inbox, then go offline so the message waits at the relay.
    const registering = await setup.startPeer(async () => ({ response: "unused" }))
    await registering.relay!.ready
    await registering.close()
    await setup.queue()

    // The next process verifies it and hangs in the turn: it dies before acking or answering.
    const crashed = await setup.startPeer(() => new Promise(() => undefined))
    closers.push(() => crashed.close())
    await vi.waitFor(() => expect(pendingIds(setup.peerBundle.agentRoot)).toHaveLength(1))
    const [inboundId] = pendingIds(setup.peerBundle.agentRoot)
    crashed.relay!.stop()

    const turns: A2ATurnRunnerInput[] = []
    const next = await setup.startPeer(async (input) => { turns.push(input); return { response: "got it" } })
    closers.push(() => next.close())
    await next.replayed
    await next.relay!.ready
    // Run once from the journal; the relay's copy is refused as a replay and acked, not run twice.
    expect(turns.map((turn) => turn.message)).toEqual([`[a2a] received coordination (seeded) from ${setup.sender.did}`])
    expect(readInboundOutcome(setup.peerBundle.agentRoot, "a2a", inboundId!)).toMatchObject({ outcome: "answered", attempts: 2 })
    expect(setup.relay.inbox.get(setup.relayConfig.current.registration!.handle)).toEqual([])
  }, 30_000)

  it("keeps a relayed message pending, without using up its attempts, when shutdown stops its turn", async () => {
    const setup = await relayedPeer("a2a-outcome-relay-shutdowns")
    const registering = await setup.startPeer(async () => ({ response: "unused" }))
    await registering.relay!.ready
    await registering.close()
    await setup.queue()

    // Four processes in a row are shut down cleanly mid-turn: restarts alone never use up a message.
    for (let restart = 1; restart <= 4; restart += 1) {
      const held = heldTurn()
      const server = await setup.startPeer(held.runner)
      await held.started
      await server.close()
      expect(openInboundJournal(setup.peerBundle.agentRoot, "a2a").pending().map((entry) => entry.attempts)).toEqual([0])
    }
    const [inboundId] = pendingIds(setup.peerBundle.agentRoot)

    const last = await setup.startPeer(async () => ({ response: "back now" }))
    closers.push(() => last.close())
    await last.replayed
    expect(readInboundOutcome(setup.peerBundle.agentRoot, "a2a", inboundId!)).toMatchObject({ outcome: "answered", attempts: 1 })
  }, 30_000)

  it("records a relayed message as failed once processes have died in its turn three times", async () => {
    const setup = await relayedPeer("a2a-outcome-relay-attempts")
    const registering = await setup.startPeer(async () => ({ response: "unused" }))
    await registering.relay!.ready
    await registering.close()
    await setup.queue()

    // Three processes in a row die mid-turn, without a clean shutdown.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const crashed = await setup.startPeer(() => new Promise(() => undefined))
      closers.push(() => crashed.close())
      await vi.waitFor(() => expect(openInboundJournal(setup.peerBundle.agentRoot, "a2a").pending().map((entry) => entry.attempts)).toEqual([attempt]))
      crashed.relay!.stop()
    }
    const [inboundId] = pendingIds(setup.peerBundle.agentRoot)

    const turns: A2ATurnRunnerInput[] = []
    const last = await setup.startPeer(async (input) => { turns.push(input); return { response: "too late" } })
    closers.push(() => last.close())
    await last.replayed
    expect(turns).toEqual([])
    expect(readInboundOutcome(setup.peerBundle.agentRoot, "a2a", inboundId!)).toMatchObject({ outcome: "failed", attempts: 3, detail: expect.stringContaining("3 attempts") })
  }, 30_000)

  it("leaves a relayed message pending, untried, when it arrives while the server is shutting down", async () => {
    const setup = await relayedPeer("a2a-outcome-relay-closing")
    const registering = await setup.startPeer(async () => ({ response: "unused" }))
    await registering.relay!.ready
    await registering.close()
    await setup.queue()
    await setup.queue()

    const held = heldTurn()
    const turns: A2ATurnRunnerInput[] = []
    const server = await setup.startPeer(async (input) => { turns.push(input); return held.runner(input) })
    await held.started
    await server.close()
    // The drain hands the second message over after close began: it is recorded but not run.
    await vi.waitFor(() => expect(openInboundJournal(setup.peerBundle.agentRoot, "a2a").pending().map((entry) => entry.attempts)).toEqual([0, 0]))
    expect(turns).toHaveLength(1)

    const answered: string[] = []
    const next = await setup.startPeer(async (input) => { answered.push(input.message); return { response: "ok" } })
    closers.push(() => next.close())
    await next.replayed
    expect(answered).toHaveLength(2)
    expect(pendingIds(setup.peerBundle.agentRoot)).toEqual([])
  }, 30_000)
})
