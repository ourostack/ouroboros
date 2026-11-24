import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import type { TurnResult } from "../../../heart/streaming"
import { codexArm, codexConfig, installSkills, threadIdOf, type CodexRun } from "../../../eval/interviews/guest/h/codex"
import { H_CODEX_FIDELITY } from "../../../eval/interviews/guest/h/fidelity"
import type { HTurnFile } from "../../../eval/interviews/guest/h/run"

function runtime(answers: TurnResult[], seen: ProviderTurnRequest[]): ProviderRuntime {
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
  product: "H", arm: "codex", labelLine: "You are working in environment T.",
  prefix: [{ role: "user", content: "Morning." }, { role: "assistant", content: "Morning." }],
  userText: "Remove the bad copy.", followUps: ["How did it go? Rate it 1 to 7."],
}

let root: string
let bundle: string
let home: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "h-codex-"))
  bundle = path.join(root, "bundle")
  home = path.join(root, "home")
  fs.mkdirSync(path.join(bundle, "psyche"), { recursive: true })
  fs.mkdirSync(path.join(bundle, "skills"), { recursive: true })
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(bundle, "psyche", "IDENTITY.md"), "I am the Butler.\n")
  fs.writeFileSync(path.join(bundle, "psyche", "SOUL.md"), "I keep the library.\n")
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("the codex arm's setup", () => {
  it("writes a config that sends every call to the wire once, with nothing the wire can't carry and nothing reaching out", () => {
    const toml = codexConfig({ baseUrl: "http://127.0.0.1:4000/v1", developerInstructions: "I am the Butler.\n\nSay \"hi\" \\ bye." })
    expect(toml).toContain("model_provider = \"eval\"")
    expect(toml).toContain("developer_instructions = \"I am the Butler.\\n\\nSay \\\"hi\\\" \\\\ bye.\"")
    expect(toml).toContain("[model_providers.eval]\nname = \"eval\"\nbase_url = \"http://127.0.0.1:4000/v1\"\nwire_api = \"responses\"\nrequest_max_retries = 0\nstream_max_retries = 0")
    expect(toml).toContain("[features]\nview_image = false\nmulti_agent = false\nunbounded_connection_retries = false\nplugins = false\napps = false")
    // multi_agent is deprecated at this commit; [agents] enabled is what turns sub-agent tools off.
    expect(toml).toContain("[agents]\nenabled = false")
    // TOML forbids a raw DEL and a lone surrogate's escape, both of which JSON allows.
    expect(codexConfig({ baseUrl: "u", developerInstructions: "a\u007fb\uD800c\uDC00d😀" })).toContain("developer_instructions = \"a\\u007Fb�c�d😀\"")
    expect(toml).toContain("web_search = \"disabled\"")
    // Every setting the config turns off is a fidelity note, named by its own key as a whole word (or its plural); a
    // section's `enabled` is named by the section's own name, so one note can't stand for a whole section.
    let section = ""
    const off: string[] = []
    const named = (word: string) => new RegExp(`(?<![\\w.])${word.replace(/\./g, "\\.")}s?(?![\\w])`)
    for (const line of toml.split("\n")) {
      const header = /^\[(.+)\]$/.exec(line)
      if (header) section = header[1]!
      const setting = /^(\w+) = (false|0|"disabled"|"none")$/.exec(line)
      if (setting) off.push(setting[1]!)
      const word = setting?.[1] === "enabled" ? section.split(".").at(-1)! : setting?.[1]
      if (setting && !H_CODEX_FIDELITY.some((note) => named(word!).test(note))) {
        throw new Error(`no fidelity note names ${section ? `[${section}] ` : ""}${setting[1]}`)
      }
    }
    expect(off.length).toBeGreaterThan(10)
    expect(toml).toContain("[skills.bundled]\nenabled = false")
    expect(toml).toContain("[analytics]\nenabled = false")
    expect(toml).toContain("[otel]\nexporter = \"none\"\ntrace_exporter = \"none\"\nmetrics_exporter = \"none\"")
    expect(toml).toContain("approval_policy = \"never\"")
    expect(toml).toContain("sandbox_mode = \"danger-full-access\"")
  })

  it("installs each of the bundle's skills as a codex skill, described by its own when-line", () => {
    fs.writeFileSync(path.join(bundle, "skills", "books.md"), "# Books\n\nUse this when the household asks about a book.\nRun `books`.\n")
    fs.writeFileSync(path.join(bundle, "skills", "media.md"), "---\ndescription: Use when a show is asked for.\ntools: [shell]\n---\n# Media\nAsk the media tools.\n")
    fs.writeFileSync(path.join(bundle, "skills", "notes.md"), "# Notes\nNothing says when.\n")
    fs.writeFileSync(path.join(bundle, "skills", "README.txt"), "not a skill")
    expect(installSkills(bundle, home)).toEqual(["books", "media", "notes"])
    const skill = (name: string): string => fs.readFileSync(path.join(home, ".agents", "skills", name, "SKILL.md"), "utf8")
    expect(skill("books")).toBe("---\nname: \"books\"\ndescription: \"Use this when the household asks about a book.\"\n---\n# Books\n\nUse this when the household asks about a book.\nRun `books`.\n")
    expect(skill("media")).toBe("---\nname: \"media\"\ndescription: \"Use when a show is asked for.\"\n---\n# Media\nAsk the media tools.\n")
    expect(skill("notes")).toBe("---\nname: \"notes\"\ndescription: \"The notes skill.\"\n---\n# Notes\nNothing says when.\n")
    // A bundle without skills installs none.
    expect(installSkills(path.join(root, "nowhere"), home)).toEqual([])
  })

  it("reads the thread's id from codex's JSON lines", () => {
    expect(threadIdOf("{\"type\":\"thread.started\",\"thread_id\":\"019a\"}\n{\"type\":\"turn.started\"}\n")).toBe("019a")
    expect(threadIdOf("not json\n{\"type\":\"turn.started\"}\n")).toBeNull()
  })
})

describe("the codex arm", () => {
  it("runs the job and then each follow-up in the same codex thread, every call through the wire, and answers as every H arm does", async () => {
    fs.writeFileSync(path.join(bundle, "skills", "books.md"), "Use this when a book is asked about.\n")
    const seen: ProviderTurnRequest[] = []
    const providerRuntime = runtime([
      { content: "", toolCalls: [{ id: "c1", name: "exec_command", arguments: "{\"cmd\":\"books library find x\"}" }], outputItems: [] },
      { content: "<think>hm</think>Removed it.", toolCalls: [], outputItems: [] },
      { content: "6", toolCalls: [], outputItems: [] },
    ], seen)
    const runs: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv; config: string; timeoutMs: number }> = []
    // A stand-in codex: each run posts what the real one would to the wire it was configured with.
    const run: CodexRun = async (args, options) => {
      const config = fs.readFileSync(path.join(options.env.CODEX_HOME!, "config.toml"), "utf8")
      runs.push({ args, cwd: options.cwd, env: options.env, config, timeoutMs: options.timeoutMs })
      const url = /base_url = "([^"]+)"/.exec(config)![1]!
      const post = async (input: unknown[]): Promise<void> => {
        const response = await fetch(`${url}/responses`, { method: "POST", body: JSON.stringify({ input, stream: true, tools: [{ type: "function", name: "exec_command" }] }) })
        await response.text()
      }
      if (args.includes("resume")) {
        await post([{ type: "message", role: "user", content: "How did it go? Rate it 1 to 7." }])
        return { code: 0, stdout: "", stderr: "" }
      }
      await post([{ type: "message", role: "user", content: "Remove the bad copy." }])
      await post([
        { type: "message", role: "user", content: "Remove the bad copy." },
        { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{\"cmd\":\"books library find x\"}" },
        { type: "function_call_output", call_id: "c1", output: "187" },
      ])
      return { code: 0, stdout: "{\"type\":\"thread.started\",\"thread_id\":\"t-1\"}\n", stderr: "" }
    }
    const workdir = path.join(home, "AgentBundles", "sanctuary.agent")
    const result = await codexArm({ run, home, workdir })({ turn: TURN, bundle, providerRuntime })
    expect(result).toEqual({
      timeline: [
        { kind: "call", name: "exec_command", args: "{\"cmd\":\"books library find x\"}", result: "187" },
        { kind: "reply", text: "Removed it." },
        { kind: "reply", text: "6" },
      ],
      finalReply: "Removed it.", outcome: "settled", steps: 3,
      turns: [{ start: 0, finalReply: "Removed it.", outcome: "settled", calls: 2 }, { start: 2, finalReply: "6", outcome: "settled", calls: 1 }],
    })
    expect(runs.map((entry) => entry.args)).toEqual([
      ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "model", "-C", workdir, "--", "Remove the bad copy."],
      // `-C` isn't an argument of `resume` at the pinned commit, so the flags go before it.
      ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "model", "-C", workdir, "resume", "t-1", "--", "How did it go? Rate it 1 to 7."],
    ])
    // One deadline for the whole conversation, inside the host's 600 seconds: each run gets what's left of it.
    expect(runs[0]!.timeoutMs).toBeLessThanOrEqual(540_000)
    expect(runs[0]!.timeoutMs).toBeGreaterThan(530_000)
    expect(runs[1]!.timeoutMs).toBeLessThanOrEqual(runs[0]!.timeoutMs)
    expect(runs[0]!.cwd).toBe(workdir)
    expect(fs.realpathSync(workdir)).toBe(fs.realpathSync(bundle))
    // Codex's state folder has a neutral name too.
    expect(runs[0]!.env).toEqual({ HOME: home, CODEX_HOME: path.join(home, ".state"), PATH: process.env.PATH })
    // The persona and the label line are codex's developer instructions; the case's conversation is before the job.
    expect(runs[0]!.config).toContain("developer_instructions = \"I am the Butler.\\n\\nI keep the library.\\n\\nYou are working in environment T.\"")
    expect(seen[0]!.messages).toEqual([...TURN.prefix, { role: "user", content: "Remove the bad copy." }])
    expect(fs.existsSync(path.join(home, ".agents", "skills", "books", "SKILL.md"))).toBe(true)
  })

  it("ends the conversation at a turn the host refused, a codex that failed or a turn with no reply, and says which", async () => {
    // The host refuses the first call: the wire answers an error codex stops on, and the turn is a provider error.
    const refusing: CodexRun = async (_args, options) => {
      const url = /base_url = "([^"]+)"/.exec(fs.readFileSync(path.join(options.env.CODEX_HOME!, "config.toml"), "utf8"))![1]!
      await (await fetch(`${url}/responses`, { method: "POST", body: JSON.stringify({ input: [{ type: "message", role: "user", content: "x" }], stream: true }) })).text()
      return { code: 1, stdout: "{\"type\":\"thread.started\",\"thread_id\":\"t\"}\n", stderr: "stream error" }
    }
    const refused = await codexArm({ run: refusing, home, workdir: path.join(home, "w1") })({ turn: TURN, bundle, providerRuntime: runtime([], []) })
    expect(refused).toMatchObject({ outcome: "provider-error: the host refused the call", steps: 1, turns: [{ start: 0, finalReply: "", outcome: "provider-error: the host refused the call", calls: 1 }] })

    // Codex fails on its own: its exit and what it printed last.
    const crashing: CodexRun = async () => ({ code: 2, stdout: "", stderr: "first\nconfig error: bad key\n" })
    const crashed = await codexArm({ run: crashing, home, workdir: path.join(home, "w2") })({ turn: TURN, bundle, providerRuntime: runtime([], []) })
    expect(crashed).toMatchObject({ outcome: "harness-error: codex exited 2: config error: bad key", steps: 0, turns: [{ calls: 0 }] })
    const silent: CodexRun = async () => ({ code: 3, stdout: "", stderr: "" })
    // A workdir already linked is used as it is.
    expect(await codexArm({ run: silent, home, workdir: path.join(home, "w2") })({ turn: TURN, bundle, providerRuntime: runtime([], []) })).toMatchObject({ outcome: "harness-error: codex exited 3" })

    // Codex exits cleanly with no reply, or with no thread to resume.
    const quiet: CodexRun = async () => ({ code: 0, stdout: "{\"type\":\"thread.started\",\"thread_id\":\"t\"}\n", stderr: "" })
    expect(await codexArm({ run: quiet, home, workdir: path.join(home, "w4") })({ turn: TURN, bundle, providerRuntime: runtime([], []) })).toMatchObject({ outcome: "harness-error: codex ended the turn with no reply" })
    const threadless: CodexRun = async (_args, options) => {
      const url = /base_url = "([^"]+)"/.exec(fs.readFileSync(path.join(options.env.CODEX_HOME!, "config.toml"), "utf8"))![1]!
      await (await fetch(`${url}/responses`, { method: "POST", body: JSON.stringify({ input: [{ type: "message", role: "user", content: "x" }], stream: true }) })).text()
      return { code: 0, stdout: "", stderr: "" }
    }
    const lost = await codexArm({ run: threadless, home, workdir: path.join(home, "w5") })({ turn: TURN, bundle, providerRuntime: runtime([{ content: "done", toolCalls: [], outputItems: [] }], []) })
    expect(lost).toMatchObject({ outcome: "settled", turns: [{ outcome: "settled" }, { start: 1, outcome: "harness-error: codex named no thread to resume", calls: 0 }] })
  })
})
