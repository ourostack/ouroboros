import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../../heart/core"
import { getAgentRoot } from "../../../heart/identity"
import { mountedAgentRoot, runGuest } from "../../../eval/sandbox/guest"
import { createStreamChannel, serveProxyRuntime, type ProxyMessage } from "../../../eval/transport/provider-proxy"
import type { runTelegramTurn } from "../../../eval/transport/telegram-turn"

const hostRuntime = (): ProviderRuntime => ({
  id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
  resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
  streamTurn: async () => ({ content: "hello from the host", toolCalls: [], outputItems: [] }),
})

describe("runGuest", () => {
  let root: string
  let turnFile: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-guest-"))
    turnFile = path.join(root, "turn.json")
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** A host serving one scripted runtime over a pair of streams, recording every message the guest sends. */
  function wire() {
    const hostToGuest = new PassThrough()
    const guestToHost = new PassThrough()
    const host = createStreamChannel(guestToHost, hostToGuest)
    const received: ProxyMessage[] = []
    host.onMessage((msg) => received.push(msg))
    serveProxyRuntime(host, hostRuntime(), { take: () => true })
    return { stdin: hostToGuest, stdout: guestToHost, received }
  }

  it("finds the one bundle mounted in the agent container", () => {
    const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "eval-bundles-"))
    fs.mkdirSync(path.join(bundles, "slugger.ouro"))
    fs.writeFileSync(path.join(bundles, "notes.txt"), "")
    expect(mountedAgentRoot(bundles)).toBe(path.join(bundles, "slugger.ouro"))
    expect(() => mountedAgentRoot(bundles, () => [])).toThrow(/found 0/)
    expect(() => mountedAgentRoot(bundles, () => ["a.ouro", "b.ouro"])).toThrow(/found 2/)
    fs.rmSync(bundles, { recursive: true, force: true })
  })

  it("runs the turn on the bundle of the agent it is given", async () => {
    fs.writeFileSync(turnFile, JSON.stringify({ prefix: [], userText: "now" }))
    const { stdin, stdout } = wire()
    const roots: string[] = []
    const runTurn: typeof runTelegramTurn = async (turn) => {
      roots.push(turn.agentRoot)
      return { timeline: [], finalReply: "", outcome: "settled", steps: 0 }
    }
    expect((await runGuest({ stdin, stdout, turnFile, runTurn, agentRoot: "/home/ouro/AgentBundles/slugger.ouro" })).ok).toBe(true)
    expect(roots).toEqual(["/home/ouro/AgentBundles/slugger.ouro"])
  })

  it("runs the turn from the turn file with the host's provider, on the sanctuary bundle, and ends with its result", async () => {
    fs.writeFileSync(turnFile, JSON.stringify({ prefix: [{ role: "user", content: "earlier" }], userText: "now" }))
    const { stdin, stdout, received } = wire()
    const seen: Array<Parameters<typeof runTelegramTurn>[0]> = []
    const runTurn: typeof runTelegramTurn = async (turn) => {
      seen.push(turn)
      const reply = await turn.providerRuntime.streamTurn({ messages: [], activeTools: [], callbacks: {} } as never)
      return { timeline: [{ kind: "reply", text: reply.content }], finalReply: reply.content, outcome: "settled", steps: 1 }
    }
    const outcome = await runGuest({ stdin, stdout, turnFile, runTurn })
    const result = { timeline: [{ kind: "reply", text: "hello from the host" }], finalReply: "hello from the host", outcome: "settled", steps: 1 }
    expect(outcome).toEqual({ ok: true, result })
    expect(seen[0]).toMatchObject({ agentRoot: getAgentRoot("sanctuary"), prefix: [{ role: "user", content: "earlier" }], userText: "now" })
    expect(seen[0]!.providerRuntime.model).toBe("eval-scripted")
    await new Promise((resolve) => setImmediate(resolve))
    expect(received.at(-1)).toEqual({ type: "done", outcome: { ok: true, result } })
  })

  it.each([
    ["a missing turn file", null, /ENOENT/],
    ["a turn file without a prefix", JSON.stringify({ userText: "now" }), /needs a prefix list/],
  ])("reports %s as its done message instead of running a turn", async (_why, text, error) => {
    if (text !== null) fs.writeFileSync(turnFile, text)
    const { stdin, stdout, received } = wire()
    const outcome = await runGuest({ stdin, stdout, turnFile, runTurn: async () => { throw new Error("never runs") } })
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(error) })
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toEqual([{ type: "done", outcome }])
  })

  it("reports a turn that throws, including a thrown value that is not an Error", async () => {
    fs.writeFileSync(turnFile, JSON.stringify({ prefix: [], userText: "now" }))
    const { stdin, stdout } = wire()
    expect(await runGuest({ stdin, stdout, turnFile, runTurn: async () => { throw "pipeline exploded" } })).toEqual({ ok: false, error: "pipeline exploded" })
  })
})
