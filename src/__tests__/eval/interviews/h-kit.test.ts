import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ProviderTurnRequest } from "../../../heart/core"
import type { Case, Observation } from "../../../eval/domain/case"
import { H_ARMS_IMAGES, H_KIT, H_REPLACEMENTS } from "../../../eval/interviews/h/kit"
import { linkNeutralPaths, ouroArm } from "../../../eval/interviews/guest/h/run"
import { chatRequest, responsesRequest } from "../../../eval/interviews/guest/h/wire"
import { requestText } from "../../../eval/interviews/latch"
import { brandHits } from "../../../eval/interviews/protocol"
import { replace, rewriteRequest } from "../../../eval/interviews/rewrite"

const FIXTURES = path.join(__dirname, "fixtures")
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"))

/** Each arm's captured first request, as the host's latch sees it: through the H wire for codex and openhands. */
const FIRST: Record<string, () => ProviderTurnRequest> = {
  ouro: () => ({ ...(fixture("h-request-ouro.json") as ProviderTurnRequest) }),
  codex: () => responsesRequest(fixture("h-request-codex.json"), []) as ProviderTurnRequest,
  openhands: () => chatRequest(fixture("h-request-openhands.json"), []) as ProviderTurnRequest,
}

const listOf = (arm: string) => H_KIT.replacements!(arm)!

describe("the H kit's replacement lists", () => {
  it("leave no brand word in any arm's captured first request, and every arm's list is sentences, then paths, then words", () => {
    // The captures hold brand words before the lists run, so the test is not vacuous.
    expect(brandHits(requestText(FIRST.codex!())).length).toBeGreaterThan(0)
    expect(brandHits(requestText(FIRST.openhands!())).length).toBeGreaterThan(0)
    for (const arm of ["ouro", "codex", "openhands"]) {
      const { request } = rewriteRequest(FIRST[arm]!(), listOf(arm))
      expect({ arm, hits: brandHits(requestText(request)) }).toStrictEqual({ arm, hits: [] })
      const tiers = listOf(arm).map((entry) => entry.tier)
      expect(tiers).toStrictEqual([...tiers].sort((a, b) => ["sentence", "path", "word"].indexOf(a!) - ["sentence", "path", "word"].indexOf(b!)))
      for (const entry of listOf(arm)) expect(entry.pattern.global).toBe(true)
    }
  })

  it("counts each arm's rewrites in its first request, by tier", () => {
    const counts = Object.fromEntries(["ouro", "codex", "openhands"].map((arm) => [arm, rewriteRequest(FIRST[arm]!(), listOf(arm)).rewrites]))
    expect(counts).toStrictEqual({
      ouro: {},
      codex: { sentence: 2 },
      // Five in the prompt and the security_risk line in two tools; then the git identity line's four openhands and two all-hands.
      openhands: { sentence: 7, word: 6 },
    })
  })

  it("replace codex's own sentences, and remove the line that is only about codex", () => {
    const { request } = rewriteRequest(FIRST.codex!(), listOf("codex"))
    const system = request.messages[0]!.content as string
    expect(system.split("\n").slice(0, 4)).toStrictEqual(["You are a coding agent running in a terminal-based coding assistant. You are expected to be precise, safe, and helpful.", "", "Your capabilities:", ""])
    expect(system).not.toContain("Within this context")
  })

  it("replace openhands' own sentences, and remove what is only about openhands", () => {
    const { request } = rewriteRequest(FIRST.openhands!(), listOf("openhands"))
    const system = JSON.stringify(request.messages[0]!.content)
    expect(system).toContain("You are a helpful AI assistant that can interact with a computer to solve tasks.")
    for (const gone of ["SELF_DOCUMENTATION", "previous local", "see: https://docs.", "adapted for agent-sdk", "(OpenHands)"]) expect(system + JSON.stringify(request.activeTools)).not.toContain(gone)
    expect(system).toContain("created by an AI agent on behalf of [user]")
    // The git identity keeps its shape, with neutral names.
    expect(system).toContain("Co-authored-by: agent <agent@agent.dev>")
  })

  it("rewrite what the container shows in a tool result the same way in every arm", () => {
    const shown = "uid=10001(ouro) gid=10001(ouro)\n/home/ouro/AgentBundles/sanctuary.ouro\ndrwx------ ouro ouro /home/ouro/.cache"
    for (const arm of ["ouro", "codex", "openhands"]) {
      expect(replace(shown, listOf(arm))).toBe("uid=10001(agent) gid=10001(agent)\n/tmp/agent/AgentBundles/sanctuary.agent\ndrwx------ agent agent /tmp/agent/.cache")
    }
    expect(replace("CODEX_HOME=/tmp/agent/.state codex: error", listOf("codex"))).toBe("AGENT_HOME=/tmp/agent/.state agent: error")
    expect(replace("TMUX=/tmp/tmux-10001/openhands-1a2b,77,0 ~/.openhands all-hands", listOf("openhands"))).toBe("TMUX=/tmp/tmux-10001/agent-1a2b,77,0 ~/.agent agent")
    expect(replace("an Ouroboros harness", listOf("ouro"))).toBe("an agent harness")
    // The home path is rewritten only as a whole folder name.
    expect(replace("/home/ouro /home/ouro/x /home/ouro.bak", listOf("codex"))).toBe("/tmp/agent /tmp/agent/x /home/agent.bak")
    // Model names are in no list, so the scan still voids a session that shows one.
    for (const arm of ["ouro", "codex", "openhands"]) expect(brandHits(replace("claude gpt minimax openai anthropic", listOf(arm)))).toHaveLength(5)
  })

  it("has the same path tier in every arm", () => {
    const paths = (arm: string) => listOf(arm).filter((entry) => entry.tier === "path")
    expect(paths("codex")).toStrictEqual(paths("ouro"))
    expect(paths("openhands")).toStrictEqual(paths("ouro"))
    expect(H_REPLACEMENTS.ouro).toBe(listOf("ouro"))
    expect(H_KIT.replacements!("unknown")).toBeUndefined()
  })
})

describe("the H kit", () => {
  const c = { prefix: [{ role: "user", content: "earlier" }, { role: "user", content: "the job" }] } as unknown as Case
  const session = { product: "H" } as never

  it("runs every arm through the H guest, codex and openhands each in its own image", () => {
    for (const arm of ["ouro", "codex", "openhands"]) {
      const choice = H_KIT.guest({ session, arm: { label: "F", arm }, case: c, debrief: "Q1" })
      expect(choice).toMatchObject({ entry: "h-guest-entry.js", turn: { product: "H", arm, prefix: [{ role: "user", content: "earlier" }], userText: "the job", followUps: ["Q1"] } })
      expect(choice.image).toBe(arm === "ouro" ? undefined : arm)
    }
    expect(H_ARMS_IMAGES).toStrictEqual(["codex", "openhands"])
    expect(H_KIT.images).toBe(H_ARMS_IMAGES)
  })

  it("reads codex's and openhands' shell calls as the shell calls the case's assertions read", () => {
    const obs = (name: string, args: object): Observation => ({ timeline: [{ kind: "call", name, args: JSON.stringify(args), result: "r" }, { kind: "reply", text: "t" }] } as unknown as Observation)
    expect(H_KIT.canonical("codex", obs("exec_command", { cmd: "ls", workdir: "/w", yield_time_ms: 10 })).timeline[0]).toStrictEqual({ kind: "call", name: "shell", args: JSON.stringify({ command: "ls", cwd: "/w" }), result: "r" })
    expect(H_KIT.canonical("codex", obs("exec_command", { cmd: "ls" })).timeline[0]).toMatchObject({ name: "shell", args: JSON.stringify({ command: "ls" }) })
    expect(H_KIT.canonical("openhands", obs("terminal", { command: "ls", security_risk: "LOW" })).timeline[0]).toMatchObject({ name: "shell", args: JSON.stringify({ command: "ls" }) })
    // Anything else, and anything unreadable, is left as the arm called it.
    expect(H_KIT.canonical("codex", obs("write_stdin", { session_id: 1 })).timeline[0]).toMatchObject({ name: "write_stdin" })
    const bad = { timeline: [{ kind: "call", name: "exec_command", args: "{not json", result: "" }] } as unknown as Observation
    expect(H_KIT.canonical("codex", bad).timeline[0]).toMatchObject({ name: "exec_command", args: "{not json" })
    for (const args of ["null", "\"ls\""]) expect(H_KIT.canonical("openhands", { timeline: [{ kind: "call", name: "terminal", args, result: "" }] } as unknown as Observation).timeline[0]).toMatchObject({ name: "terminal", args })
    expect(H_KIT.canonical("codex", obs("exec_command", { workdir: "/w" })).timeline[0]).toMatchObject({ name: "exec_command" })
    expect(H_KIT.canonical("ouro", obs("shell", { command: "ls" })).timeline[0]).toMatchObject({ name: "shell", args: JSON.stringify({ command: "ls" }) })
  })

  it("gives each openhands terminal call the folder the terminal reported after the one before, since tmux keeps it", () => {
    const call = (command: string, result: string) => ({ kind: "call", name: "terminal", args: JSON.stringify({ command }), result })
    const timeline = [
      call("cd work", "\n[The command completed with exit code 0.]\n[Current working directory: /tmp/agent/AgentBundles/sanctuary.agent/work]"),
      { kind: "call", name: "file_editor", args: "{}", result: "[Current working directory: /elsewhere]" },
      call("books send x.epub", "sent\n[Current working directory: /a]\n[Current working directory: /tmp/agent/AgentBundles/sanctuary.agent/work]"),
      call("ls", "no folder line"),
      call("pwd", ""),
    ]
    const args = H_KIT.canonical("openhands", { timeline } as unknown as Observation).timeline.map((entry) => (entry as { args: string }).args)
    expect(args).toStrictEqual([
      JSON.stringify({ command: "cd work" }),
      "{}",
      JSON.stringify({ command: "books send x.epub", cwd: "/tmp/agent/AgentBundles/sanctuary.agent/work" }),
      JSON.stringify({ command: "ls", cwd: "/tmp/agent/AgentBundles/sanctuary.agent/work" }),
      // A result with no folder line keeps the folder known before it.
      JSON.stringify({ command: "pwd", cwd: "/tmp/agent/AgentBundles/sanctuary.agent/work" }),
    ])
  })

  it("carries the fidelity notes for every arm", () => {
    expect(Object.keys(H_KIT.fidelity!)).toStrictEqual(["H:ouro", "H:codex", "H:openhands"])
  })
})

describe("the neutral paths in the ouro arm", () => {
  const made: string[] = []
  afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

  it("makes the neutral home as the other arms have it, the bundle linked under it, and links the home's own entries, once", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "h-links-")))
    made.push(root)
    const home = path.join(root, "home")
    const bundle = path.join(home, "AgentBundles", "sanctuary.ouro")
    fs.mkdirSync(bundle, { recursive: true })
    fs.writeFileSync(path.join(bundle, "agent.json"), "{}")
    fs.mkdirSync(path.join(home, ".cache"))
    // The bundles folder is the mount point Docker made, which the container's user can't write.
    fs.chmodSync(path.join(home, "AgentBundles"), 0o555)
    const neutral = path.join(root, "tmp", "agent")
    fs.mkdirSync(path.dirname(neutral))
    try {
      linkNeutralPaths(bundle, neutral)
      linkNeutralPaths(bundle, neutral)
    } finally {
      fs.chmodSync(path.join(home, "AgentBundles"), 0o755)
    }
    const seen = path.join(neutral, "AgentBundles", "sanctuary.agent")
    expect(fs.readFileSync(path.join(seen, "agent.json"), "utf8")).toBe("{}")
    expect(fs.realpathSync(seen)).toBe(bundle)
    expect(fs.lstatSync(neutral).isDirectory()).toBe(true)
    expect(fs.readlinkSync(path.join(neutral, ".cache"))).toBe(path.join(home, ".cache"))
    expect(fs.readdirSync(neutral).sort()).toStrictEqual([".cache", "AgentBundles"])
    expect(fs.readdirSync(path.join(home, "AgentBundles"))).toStrictEqual(["sanctuary.ouro"])
  })

  it("makes the links before the ouro arm's turn runs, in the bundle it was given", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "h-links-")))
    made.push(root)
    const bundle = path.join(root, "home", "AgentBundles", "sanctuary.ouro")
    fs.mkdirSync(bundle, { recursive: true })
    const neutral = path.join(root, "agent")
    let linked = false
    const runTurn = (async (turn: { agentRoot: string }) => {
      linked = fs.realpathSync(path.join(neutral, "AgentBundles", "sanctuary.agent")) === bundle
      expect(turn.agentRoot).toBe(bundle)
      return { timeline: [], finalReply: "", outcome: "settled", steps: 0, turns: [] }
    }) as never
    await ouroArm(runTurn, neutral)({ turn: { product: "H", arm: "ouro", labelLine: "L", prefix: [], userText: "u", followUps: [] }, bundle, providerRuntime: {} as never })
    expect(linked).toBe(true)
  })
})
