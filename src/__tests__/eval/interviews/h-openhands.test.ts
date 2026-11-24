import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import type { TurnResult } from "../../../heart/streaming"
import { openhandsArm, type Supervisor } from "../../../eval/interviews/guest/h/openhands"
import { H_OPENHANDS_FIDELITY } from "../../../eval/interviews/guest/h/fidelity"
import type { HTurnFile } from "../../../eval/interviews/guest/h/run"

function runtime(answers: TurnResult[], seen: ProviderTurnRequest[] = []): ProviderRuntime {
  return {
    id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
    resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
    streamTurn: async (request) => {
      seen.push(request)
      const answer = answers.shift()
      if (!answer) throw new Error("the host refused the call")
      return answer
    },
  }
}

const TURN: HTurnFile = {
  product: "H", arm: "openhands", labelLine: "You are working in environment Z.",
  prefix: [{ role: "user", content: "Morning." }, { role: "assistant", content: "Morning." }],
  userText: "Remove the bad copy.", followUps: ["How did it go? Rate it 1 to 7."],
}

let root: string
let bundle: string
let home: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "h-openhands-"))
  bundle = path.join(root, "bundle")
  home = path.join(root, "home")
  fs.mkdirSync(path.join(bundle, "psyche"), { recursive: true })
  fs.mkdirSync(path.join(bundle, "skills"), { recursive: true })
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(bundle, "psyche", "IDENTITY.md"), "I am the Butler.\n")
  fs.writeFileSync(path.join(bundle, "skills", "books.md"), "Use this when a book is asked about.\n")
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** A stand-in supervisor: for each message, posts the given chat bodies to the wire, then reports a status line. */
function fakeSupervisor(script: Array<{ bodies: unknown[]; line: { status?: string; error?: string } | null }>, started: Array<{ spec: Record<string, unknown>; env: NodeJS.ProcessEnv; cwd: string }>, exit = { code: 0, stderr: "" }, sent: string[] = []) {
  return (specFile: string, options: { cwd: string; env: NodeJS.ProcessEnv }): Supervisor => {
    const spec = JSON.parse(fs.readFileSync(specFile, "utf8")) as Record<string, unknown>
    started.push({ spec, env: options.env, cwd: options.cwd })
    return {
      send: async (message) => {
        sent.push(message)
        const step = script.shift()
        // Past its script the stand-in has exited, as a supervisor that ended does.
        if (!step) return null
        for (const body of step.bodies) await (await fetch(`${String(spec.baseUrl)}/chat/completions`, { method: "POST", body: JSON.stringify(body) })).text()
        return step.line
      },
      close: async () => ({ ...exit, sent }),
    }
  }
}

describe("the openhands arm", () => {
  it("sends the job and then each follow-up to one conversation, every call through the wire, and answers as every H arm does", async () => {
    const seen: ProviderTurnRequest[] = []
    const providerRuntime = runtime([
      { content: "", toolCalls: [{ id: "c1", name: "terminal", arguments: "{\"command\":\"books library find x\"}" }], outputItems: [] },
      { content: "", toolCalls: [{ id: "c2", name: "finish", arguments: "{\"message\":\"<think>x</think>Removed it.\"}" }], outputItems: [] },
      { content: "6", toolCalls: [], outputItems: [] },
    ], seen)
    const started: Array<{ spec: Record<string, unknown>; env: NodeJS.ProcessEnv; cwd: string }> = []
    const job = [
      { messages: [{ role: "user", content: "Remove the bad copy." }] },
      { messages: [
        { role: "user", content: "Remove the bad copy." },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: "{\"command\":\"books library find x\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "187" },
      ] },
    ]
    const sent: string[] = []
    const start = fakeSupervisor([{ bodies: job, line: { status: "finished" } }, { bodies: [{ messages: [{ role: "user", content: "How did it go?" }] }], line: { status: "finished" } }], started, undefined, sent)
    const workdir = path.join(home, "AgentBundles", "sanctuary.agent")
    const result = await openhandsArm({ start, home, workdir })({ turn: TURN, bundle, providerRuntime })
    expect(result).toEqual({
      timeline: [
        { kind: "call", name: "terminal", args: "{\"command\":\"books library find x\"}", result: "187" },
        { kind: "reply", text: "Removed it." },
        { kind: "reply", text: "6" },
      ],
      finalReply: "Removed it.", outcome: "settled", steps: 3,
      turns: [{ start: 0, finalReply: "Removed it.", outcome: "settled", calls: 2 }, { start: 2, finalReply: "6", outcome: "settled", calls: 1 }],
    })
    expect(started).toHaveLength(1)
    // One supervisor got the job and then each follow-up, in order.
    expect(sent).toStrictEqual([TURN.userText, ...TURN.followUps])
    expect(started[0]!.cwd).toBe(workdir)
    expect(started[0]!.spec).toEqual({ baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/), workdir, systemSuffix: "I am the Butler.\n\nYou are working in environment Z." })
    // PWD keeps the neutral path if the SDK falls back to a plain shell; AI_AGENT keeps the SDK's brand out of the shell.
    // SHELL is bash because tmux runs its session through it, and the image's user has no login shell.
    expect(started[0]!.env).toStrictEqual({ HOME: home, PWD: workdir, PATH: process.env.PATH, SHELL: "/bin/bash", LITELLM_LOCAL_MODEL_COST_MAP: "True", AI_AGENT: "agent" })
    expect(fs.realpathSync(workdir)).toBe(fs.realpathSync(bundle))
    expect(fs.existsSync(path.join(home, ".agents", "skills", "books", "SKILL.md"))).toBe(true)
    expect(seen[0]!.messages).toEqual([...TURN.prefix, { role: "user", content: "Remove the bad copy." }])
  })

  it("ends the conversation at a turn the host refused, a failed or stopped conversation, a supervisor that died or a turn with no reply, and says which", async () => {
    const one = (bodies: unknown[], line: { status?: string; error?: string } | null, exit?: { code: number; stderr: string }) => fakeSupervisor([{ bodies, line }], [], exit)
    const go = [{ messages: [{ role: "user", content: "x" }] }]
    const at = (name: string): string => path.join(home, name)

    const refused = await openhandsArm({ start: one(go, { error: "BadRequestError: the host refused the call" }), home, workdir: at("w1") })({ turn: TURN, bundle, providerRuntime: runtime([]) })
    expect(refused).toMatchObject({ outcome: "provider-error: the host refused the call", steps: 1, turns: [{ start: 0, finalReply: "", outcome: "provider-error: the host refused the call", calls: 1 }] })

    const failed = await openhandsArm({ start: one([], { error: "ValueError: bad tool" }), home, workdir: at("w2") })({ turn: TURN, bundle, providerRuntime: runtime([]) })
    expect(failed).toMatchObject({ outcome: "harness-error: openhands failed: ValueError: bad tool", turns: [{ calls: 0 }] })

    // A workdir already linked is used as it is.
    const stuck = await openhandsArm({ start: one(go, { status: "stuck" }), home, workdir: at("w2") })({ turn: TURN, bundle, providerRuntime: runtime([{ content: "hm", toolCalls: [], outputItems: [] }]) })
    expect(stuck).toMatchObject({ outcome: "harness-error: openhands stopped the turn stuck", turns: [{ finalReply: "hm" }] })

    const died = await openhandsArm({ start: one([], null, { code: 1, stderr: "Traceback\nImportError: no tmux\n" }), home, workdir: at("w3") })({ turn: TURN, bundle, providerRuntime: runtime([]) })
    expect(died).toMatchObject({ outcome: "harness-error: openhands exited 1: ImportError: no tmux" })
    const silent = await openhandsArm({ start: one([], null, { code: 0, stderr: "" }), home, workdir: at("w4") })({ turn: TURN, bundle, providerRuntime: runtime([]) })
    expect(silent).toMatchObject({ outcome: "harness-error: openhands exited 0" })

    const quiet = await openhandsArm({ start: one([], { status: "finished" }), home, workdir: at("w5") })({ turn: TURN, bundle, providerRuntime: runtime([]) })
    expect(quiet).toMatchObject({ outcome: "harness-error: openhands ended the turn with no reply" })
    // A finish call whose arguments aren't JSON still ends the turn with its text as the reply.
    const odd = await openhandsArm({ start: one(go, { status: "finished" }), home, workdir: at("w6") })({ turn: TURN, bundle, providerRuntime: runtime([{ content: "", toolCalls: [{ id: "f", name: "finish", arguments: "done" }], outputItems: [] }]) })
    expect(odd).toMatchObject({ outcome: "settled", finalReply: "done", timeline: [{ kind: "reply", text: "done" }] })
  })

  it("has a fidelity note for every setting the supervisor changes from the SDK's defaults", () => {
    const supervisor = fs.readFileSync(path.join(__dirname, "../../../../deploy/eval/openhands/supervise.py"), "utf8")
    // The settings are the keyword arguments of the SDK's constructors, from the LLM to the conversation.
    // Every keyword argument, whatever its value, so a new one fails here until it is placed below.
    const setup = supervisor.slice(supervisor.indexOf("LLM("), supervisor.indexOf("for line in sys.stdin"))
    const settings = [...new Set([...setup.matchAll(/\b(\w+)=/g)].map((match) => match[1]!))]
    // Each setting's words in a fidelity note, or null for one the model can't notice: plumbing, naming, the console.
    const noted: Record<string, string | null> = {
      usage_id: null, base_url: null, api_key: null, llm: null, name: null, agent: null, workspace: null, visualizer: null, agent_context: null,
      model: "openai/model", api_mode: "api_mode", num_retries: "num_retries", stream: "stream",
      tools: "the terminal and the file editor", system_message_suffix: "system message's suffix", load_user_skills: "load_user_skills",
      system_prompt_kwargs: "cli_mode",
    }
    expect(settings.filter((setting) => !(setting in noted))).toEqual([])
    // And what the SDK's default preset gives that the arm leaves out.
    const words = [...Object.values(noted).filter((word): word is string => word !== null), "condenser", "task tracker", "browser"]
    for (const word of words) {
      if (!H_OPENHANDS_FIDELITY.some((note) => note.includes(word))) throw new Error(`no fidelity note names ${word}`)
    }
  })
})
