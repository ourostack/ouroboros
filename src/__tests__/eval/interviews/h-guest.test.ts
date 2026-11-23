import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../../heart/core"
import { H_ARMS, runHGuest, type HArmRunner } from "../../../eval/interviews/guest/h/run"
import { createStreamChannel, serveProxyRuntime, type ProxyMessage } from "../../../eval/transport/provider-proxy"
import type { runTelegramTurn } from "../../../eval/transport/telegram-turn"

const hostRuntime = (): ProviderRuntime => ({
  id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
  resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
  streamTurn: async () => ({ content: "hello from the host", toolCalls: [], outputItems: [] }),
})

const TURN = {
  product: "H", arm: "ouro", labelLine: "You are working in environment K.",
  prefix: [{ role: "user", content: "Morning." }], userText: "Remove the bad copy, please.", followUps: ["How did that go?"],
}

describe("the H guest", () => {
  let root: string
  let turnFile: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-h-guest-"))
    turnFile = path.join(root, "turn.json")
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function wire() {
    const hostToGuest = new PassThrough()
    const guestToHost = new PassThrough()
    const host = createStreamChannel(guestToHost, hostToGuest)
    const received: ProxyMessage[] = []
    host.onMessage((msg) => received.push(msg))
    serveProxyRuntime(host, hostRuntime(), { take: () => true })
    return { stdin: hostToGuest, stdout: guestToHost, received }
  }

  it("runs the ouro arm as the harness's own Telegram turn: the label line in its system prompt, the debrief as the next message", async () => {
    fs.writeFileSync(turnFile, JSON.stringify(TURN))
    const { stdin, stdout, received } = wire()
    const seen: Array<Parameters<typeof runTelegramTurn>[0]> = []
    const runTurn: typeof runTelegramTurn = async (turn) => {
      seen.push(turn)
      return { timeline: [], finalReply: "done", outcome: "settled", steps: 2, turns: [{ start: 0, finalReply: "done", outcome: "settled", calls: 1 }, { start: 0, finalReply: "6", outcome: "settled", calls: 1 }] }
    }
    const outcome = await runHGuest({ stdin, stdout, turnFile, bundle: "/home/ouro/AgentBundles/slugger.ouro", runTurn })
    expect(outcome).toEqual({ ok: true, result: expect.objectContaining({ finalReply: "done", turns: expect.any(Array) }) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ agentRoot: "/home/ouro/AgentBundles/slugger.ouro", prefix: TURN.prefix, userText: TURN.userText, systemLine: TURN.labelLine, followUps: TURN.followUps })
    // The guest's provider is the host's, over the channel.
    await expect(seen[0]!.providerRuntime.streamTurn({ messages: [], activeTools: [], callbacks: {} as never })).resolves.toMatchObject({ content: "hello from the host" })
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toContainEqual({ type: "done", outcome })
  })

  it("runs any other H arm with that arm's runner, and refuses an arm it has none for or a turn file that is not H's", async () => {
    const ran: string[] = []
    const arms: Record<string, HArmRunner> = {
      codex: async (input) => {
        ran.push(`${input.turn.arm} ${input.bundle}`)
        await input.providerRuntime.ping()
        return { timeline: [], finalReply: "ok", outcome: "settled", turns: [] }
      },
    }
    fs.writeFileSync(turnFile, JSON.stringify({ ...TURN, arm: "codex" }))
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b", arms })).toEqual({ ok: true, result: { timeline: [], finalReply: "ok", outcome: "settled", turns: [] } })
    expect(ran).toEqual(["codex /b"])

    fs.writeFileSync(turnFile, JSON.stringify({ ...TURN, arm: "openhands" }))
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b", arms })).toEqual({ ok: false, error: "no H arm openhands in the guest" })
    fs.writeFileSync(turnFile, JSON.stringify({ ...TURN, arm: "constructor" }))
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b", arms })).toEqual({ ok: false, error: "no H arm constructor in the guest" })
    fs.writeFileSync(turnFile, JSON.stringify({ ...TURN, product: "X" }))
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b", arms })).toEqual({ ok: false, error: `${turnFile} needs product H, arm, labelLine, prefix, userText and followUps` })
    fs.writeFileSync(turnFile, JSON.stringify({ ...TURN, followUps: "no" }))
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b", arms })).toMatchObject({ ok: false })
    // An arm that throws is the guest's error, not a crash.
    const throwing: Record<string, HArmRunner> = { codex: async () => { throw new Error("no binary") } }
    fs.writeFileSync(turnFile, JSON.stringify({ ...TURN, arm: "codex" }))
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b", arms: throwing })).toEqual({ ok: false, error: "no binary" })
    const odd: Record<string, HArmRunner> = { codex: async () => { throw "plain" } }
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b", arms: odd })).toEqual({ ok: false, error: "plain" })
  })

  it("has the ouro arm by default, and no other yet", async () => {
    expect(Object.keys(H_ARMS)).toEqual(["ouro"])
    fs.writeFileSync(turnFile, JSON.stringify({ ...TURN, arm: "codex" }))
    expect(await runHGuest({ ...wire(), turnFile, bundle: "/b" })).toEqual({ ok: false, error: "no H arm codex in the guest" })
  })
})
