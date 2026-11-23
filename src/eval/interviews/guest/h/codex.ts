/**
 * H's `codex` arm (pre-registration v2 product H): OpenAI Codex CLI at `227fa4e805d4`, its own agent loop unchanged,
 * pointed at the H wire on the container's loopback as a custom Responses provider. Every call it makes goes through
 * the wire to the host's runtime, so the host still rewrites, scans, gates and meters it.
 *
 * What stays the same as in every arm: the Butler's persona and the label line (here codex's developer instructions,
 * which it sends after its own), the case's conversation (put before the job by the wire), the bundle's skills
 * (installed as codex skills, each described by its own when-line), the books command line and the household.
 *
 * What the config changes, and why (each is a fidelity flag in the H kit):
 * - no retries, unbounded connection retries included: a retried call would be metered twice, and the wire answers
 *   every failure with a 400 anyway;
 * - no `view_image`: its output is an image, which the wire can't carry;
 * - no sub-agents: their tools are a namespace, not functions, which the wire can't carry;
 * - no web search, plugins, apps, bundled skills, analytics or telemetry: the container has no route out, and the
 *   bundled skills are about codex itself, not the household.
 * Codex doesn't know the model's name, so it runs as it does for any model it doesn't know: its generic prompt, no
 * `apply_patch` tool, and a 10,000-byte cut on tool output.
 *
 * Codex runs in a neutral home with the bundle linked at a neutral path, so no path it shows the model carries a
 * brand word, and a path the model writes back still resolves. The job is `codex exec`; each follow-up is
 * `codex exec resume` on the same thread, as the owner's next message.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../../../nerves/runtime"
import { whenLine } from "../../../../repertoire/skill-summaries"
import type { TraceCall, TraceReply } from "../../../domain/case"
import type { TelegramTurns } from "../../../transport/telegram-turn"
import { withoutThinking } from "../loop"
import { personaPrompt } from "../run"
import type { HArmRunner } from "./run"
import { createWire, serveWire } from "./wire"

/** Runs codex with these arguments and waits for it to end. */
export type CodexRun = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

/** The whole conversation's time, inside the host's 600-second guest deadline, so a stuck codex is this arm's failure. */
const CONVERSATION_MS = 540_000

/**
 * Codex's home: a path with no brand word, on the agent container's writable `/tmp` (the container is read-only
 * otherwise, and its own home's path carries a brand word).
 */
export const CODEX_HOME_DIR = "/tmp/agent"

/** The model name codex sends; the wire ignores it, and the host's runtime decides the model. */
const MODEL = "model"

/** A TOML basic string: JSON's escapes, plus the two TOML also forbids raw (DEL, and a lone surrogate's escape). */
const toml = (text: string): string => JSON.stringify(text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�"))
  .replace(/\u007f/g, "\\u007F")

/** Codex's config.toml for one conversation: the wire as its only provider, and nothing the wire can't carry. */
export function codexConfig(input: { baseUrl: string; developerInstructions: string }): string {
  return [
    `model = ${toml(MODEL)}`,
    "model_provider = \"eval\"",
    "approval_policy = \"never\"",
    "sandbox_mode = \"danger-full-access\"",
    "web_search = \"disabled\"",
    "check_for_update_on_startup = false",
    `developer_instructions = ${toml(input.developerInstructions)}`,
    "",
    "[model_providers.eval]",
    "name = \"eval\"",
    `base_url = ${toml(input.baseUrl)}`,
    "wire_api = \"responses\"",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "stream_idle_timeout_ms = 300000",
    "",
    "[features]",
    "view_image = false",
    "multi_agent = false",
    "unbounded_connection_retries = false",
    "plugins = false",
    "apps = false",
    "",
    "[skills.bundled]",
    "enabled = false",
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[otel]",
    "exporter = \"none\"",
    "trace_exporter = \"none\"",
    "metrics_exporter = \"none\"",
    "",
  ].join("\n")
}

/**
 * Installs each of the bundle's skills (`skills/<name>.md`) as a codex user skill (`.agents/skills/<name>/SKILL.md`),
 * named for its file and described by the when-line the harness shows beside it. Returns the names installed.
 */
export function installSkills(bundle: string, home: string): string[] {
  const dir = path.join(bundle, "skills")
  if (!fs.existsSync(dir)) return []
  const names = fs.readdirSync(dir).filter((file) => file.endsWith(".md")).sort().map((file) => path.basename(file, ".md"))
  for (const name of names) {
    const markdown = fs.readFileSync(path.join(dir, `${name}.md`), "utf8")
    const lines = markdown.split("\n")
    const end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1
    const body = end > 0 ? lines.slice(end + 1).join("\n") : markdown
    const description = whenLine(markdown) ?? `The ${name} skill.`
    fs.mkdirSync(path.join(home, ".agents", "skills", name), { recursive: true })
    fs.writeFileSync(path.join(home, ".agents", "skills", name, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`)
  }
  return names
}

/** The thread codex started, from its `--json` lines; null when it named none. */
export function threadIdOf(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown }
      if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id
    } catch {
      // Not an event line.
    }
  }
  return null
}

/* v8 ignore start -- process wiring: what the arm does with codex's exit and output is tested with an injected run @preserve */
const spawnCodex: CodexRun = (args, options) => new Promise((resolve) => {
  const child = spawn("codex", args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8") })
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
  const timer = setTimeout(() => child.kill("SIGKILL"), Math.max(options.timeoutMs, 0))
  child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: `${stderr}${error.message}\n` }) })
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 137, stdout, stderr }) })
})
/* v8 ignore stop */

const lastLine = (text: string): string => text.trim().split("\n").at(-1)!.trim()

export function codexArm(options: { run?: CodexRun; home?: string; workdir?: string } = {}): HArmRunner {
  const run = options.run ?? spawnCodex
  const home = options.home ?? CODEX_HOME_DIR
  const workdir = options.workdir ?? path.join(home, "AgentBundles", "sanctuary.agent")
  return async ({ turn, bundle, providerRuntime }) => {
    const deadline = Date.now() + CONVERSATION_MS
    fs.mkdirSync(path.dirname(workdir), { recursive: true })
    if (!fs.existsSync(workdir)) fs.symlinkSync(bundle, workdir)
    installSkills(bundle, home)
    const wire = createWire({ runtime: providerRuntime, prefix: turn.prefix })
    const served = await serveWire(wire)
    try {
      // Codex's state folder, with a neutral name: the model can see it in the shell's environment.
      const codexHome = path.join(home, ".state")
      fs.mkdirSync(codexHome, { recursive: true })
      fs.writeFileSync(path.join(codexHome, "config.toml"), codexConfig({ baseUrl: served.url, developerInstructions: `${personaPrompt(bundle)}\n\n${turn.labelLine}` }))
      const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH }
      // `-C` keeps the neutral path as codex's cwd; without it codex resolves the link to the bundle's real path. The
      // flags are `exec`'s, so they go before `resume`, which doesn't take `-C`.
      const flags = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", MODEL, "-C", workdir]
      const turns: TelegramTurns = []
      let thread: string | null = null
      for (const [index, text] of [turn.userText, ...turn.followUps].entries()) {
        const record = { start: wire.timeline().length, finalReply: "", outcome: "settled", calls: 0 }
        turns.push(record)
        if (index > 0 && thread === null) {
          record.outcome = "harness-error: codex named no thread to resume"
          break
        }
        emitNervesEvent({ component: "eval", event: "eval.h_codex_turn_start", message: "codex is taking a turn", meta: { index } })
        const callsBefore = wire.calls()
        const ran = await run(index === 0 ? ["exec", ...flags, "--", text] : ["exec", ...flags, "resume", thread!, "--", text], { cwd: workdir, env, timeoutMs: deadline - Date.now() })
        if (index === 0) thread = threadIdOf(ran.stdout)
        record.calls = wire.calls() - callsBefore
        const reply = wire.timeline().slice(record.start).filter((entry): entry is TraceReply => entry.kind === "reply").at(-1)
        if (reply) record.finalReply = withoutThinking(reply.text)
        // A failed call ends the conversation, so any failure the wire remembers is this turn's.
        const failure = wire.error()
        if (failure !== null) record.outcome = `provider-error: ${failure}`
        else if (ran.code !== 0) record.outcome = `harness-error: codex exited ${ran.code}${ran.stderr.trim() ? `: ${lastLine(ran.stderr)}` : ""}`
        else if (!reply) record.outcome = "harness-error: codex ended the turn with no reply"
        emitNervesEvent({ component: "eval", event: "eval.h_codex_turn_end", message: "codex ended a turn", meta: { index, outcome: record.outcome, calls: record.calls } })
        if (record.outcome !== "settled") break
      }
      const timeline: Array<TraceCall | TraceReply> = wire.timeline().map((entry) => entry.kind === "reply" ? { kind: "reply", text: withoutThinking(entry.text) } : entry)
      return { timeline, finalReply: turns[0]!.finalReply, outcome: turns[0]!.outcome, steps: wire.calls(), turns }
    } finally {
      await served.close()
    }
  }
}
