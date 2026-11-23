import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../../heart/core"
import type { Case } from "../../../eval/domain/case"
import { remoteRunCase, serveRemoteJob, type RemoteJob } from "../../../eval/sandbox/remote"

const theCase = { id: "remove-bad-copy" } as unknown as Case
const observation = { timeline: [], finalReply: "ok", library: [], mail: [], created: [], outcome: "settled", steps: 1, oracle: {}, gaps: ["TACIT.md"] }

function hostRuntime(log: string[]): ProviderRuntime {
  return {
    id: "minimax", model: "MiniMax-M3", client: null, capabilities: new Set(),
    streamTurn: async () => { log.push("call"); return { content: "hi", toolCalls: [], outputItems: [] } },
    appendToolOutput: () => undefined, resetTurnState: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
  }
}

/** A remote host whose ssh process is a pair of in-memory pipes, served by `serveRemoteJob`. */
function loopback(run: (job: RemoteJob, host: ProviderRuntime) => Promise<typeof observation>) {
  const toRemote = new PassThrough()
  const fromRemote = new PassThrough()
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { exit = resolve })
  void serveRemoteJob({ stdin: toRemote, stdout: fromRemote, run }).then(() => exit(0))
  return { stdin: toRemote, stdout: fromRemote, exited, stderr: () => "remote stderr" }
}

describe("remote sandbox", () => {
  const paths = { bundleDir: "/tmp/ouro-eval-x/bundle", seedBundleDir: "/tmp/ouro-eval-x/seed", workRoot: "/tmp/ouro-eval-x/work", oracleBooks: "/tmp/ouro-eval-x/oracle" }

  it("sends the job, serves the model from this side, and returns the remote observation", async () => {
    const log: string[] = []
    let seen: RemoteJob | undefined
    const runCase = remoteRunCase({
      start: () => loopback(async (job, host) => {
        seen = job
        await host.streamTurn({ messages: [], activeTools: [], callbacks: {} } as never)
        return observation
      }),
      paths,
    })
    let taken = 0
    const obs = await runCase({ case: theCase, host: hostRuntime(log), budget: { take: () => { taken += 1; return true } } })
    expect(obs).toEqual(observation)
    expect(seen).toEqual({ case: theCase, ...paths })
    expect({ log, taken }).toEqual({ log: ["call"], taken: 1 })
  })

  it("sends another guest with the job, and returns the observation's follow-ups", async () => {
    let seen: RemoteJob | undefined
    const guest = { entry: "interview-guest-entry.js" as const, turn: { userText: "job", followUps: ["debrief"] } }
    const withFollowUps = { ...observation, followUps: [{ finalReply: "6", outcome: "settled", calls: 1, toolCalls: 0 }] }
    const runCase = remoteRunCase({ start: () => loopback(async (job) => { seen = job; return withFollowUps }), paths })
    expect(await runCase({ case: theCase, host: hostRuntime([]), budget: { take: () => true }, guest })).toEqual(withFollowUps)
    expect(seen).toEqual({ case: theCase, ...paths, guest })
  })

  it("fails when the remote run fails, returns something that is not an observation, exits early or runs too long", async () => {
    const host = hostRuntime([])
    const budget = { take: () => true }
    await expect(remoteRunCase({ start: () => loopback(async () => { throw new Error("docker is down") }), paths })({ case: theCase, host, budget }))
      .rejects.toThrow("remote sandbox failed: docker is down")
    await expect(remoteRunCase({ start: () => loopback(async () => { throw "plain" }), paths })({ case: theCase, host, budget }))
      .rejects.toThrow("remote sandbox failed: plain")
    await expect(remoteRunCase({ start: () => loopback(async () => ({ nope: true }) as never), paths })({ case: theCase, host, budget }))
      .rejects.toThrow(/not an observation/)
    const early = () => ({ stdin: new PassThrough(), stdout: new PassThrough(), exited: Promise.resolve(255), stderr: () => "Connection refused" })
    await expect(remoteRunCase({ start: early, paths })({ case: theCase, host, budget })).rejects.toThrow(/exited \(255\).*Connection refused/)
    let killed = false
    const hung = () => ({ stdin: new PassThrough(), stdout: new PassThrough(), exited: new Promise<number>(() => undefined), stderr: () => "", kill: () => { killed = true } })
    await expect(remoteRunCase({ start: hung, paths, timeoutMs: 20 })({ case: theCase, host, budget })).rejects.toThrow(/did not finish within 20 ms/)
    expect(killed).toBe(true)
  })

  it("refuses a job that names no case, before it starts a run", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: string[] = []
    output.setEncoding("utf8").on("data", (chunk: string) => lines.push(chunk))
    const done = serveRemoteJob({ stdin: input, stdout: output, run: async () => observation })
    input.write(`${JSON.stringify({ type: "job", job: { bundleDir: "/x" } })}\n`)
    expect(await done).toEqual({ ok: false, error: "the job names no case, bundle or seed bundle" })
    expect(lines.join("")).toContain("\"type\":\"done\"")
  })

  it("ends when the other side goes away before sending a job", async () => {
    const input = new PassThrough()
    const done = serveRemoteJob({ stdin: input, stdout: new PassThrough(), run: async () => observation })
    input.end()
    expect(await done).toEqual({ ok: false, error: "the channel closed before a job arrived" })
  })
})
