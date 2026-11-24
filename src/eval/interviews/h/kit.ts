/**
 * Product H, whole harnesses (pre-registration v2 section 2), as the runner's `ProductKit`. Every arm runs in the H
 * guest (`h-guest-entry.js`) on the books cases: the ouro arm in the default agent image, codex and openhands each in
 * its own image, which `--images` must name.
 *
 * Each arm's replacement list (section 3) runs in three tiers, in order:
 * - sentences and sections: what the arm's own prompt and tools say about the product, replaced with a neutral
 *   sentence or removed where it is only about the product;
 * - paths: the container's real home and bundle, shown to the model as the neutral ones every arm has
 *   (/tmp/agent/AgentBundles/sanctuary.agent), which are linked to the real ones, so a path the model copies works;
 * - words: the user's name and the arm's own name, wherever a tool result shows them.
 * Model names are in no list, so the host's scan still voids a session where one appears.
 */
import { emitNervesEvent } from "../../../nerves/runtime"
import type { Observation, TraceCall } from "../../domain/case"
import { H_CODEX_FIDELITY, H_OPENHANDS_FIDELITY, H_OURO_FIDELITY } from "../guest/h/fidelity"
import { labelLine } from "../protocol"
import type { Replacement } from "../rewrite"
import type { ProductKit } from "../runner"

/** The named agent images H needs, besides the default one the ouro arm runs in. */
export const H_ARMS_IMAGES: readonly string[] = ["codex", "openhands"]

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const sentence = (text: string, by: string): Replacement => ({ pattern: new RegExp(escape(text), "g"), with: by, tier: "sentence" })

/** The container's real home and bundle, as every arm shows them; the H guest links both. */
const PATHS: readonly Replacement[] = [
  { pattern: /\/home\/ouro(?![\w.-])/g, with: "/tmp/agent", tier: "path" },
  { pattern: /\bsanctuary\.ouro\b/g, with: "sanctuary.agent", tier: "path" },
]

/** The container's user, `ouro`, and the harness's own name, wherever a tool result shows them. */
const OURO_WORDS: readonly Replacement[] = [
  { pattern: /ouroboros/gi, with: "agent", tier: "word" },
  { pattern: /ouro/gi, with: "agent", tier: "word" },
]

const CODEX: readonly Replacement[] = [
  sentence("You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.", "You are a coding agent running in a terminal-based coding assistant."),
  sentence("Within this context, Codex refers to the open-source agentic coding interface (not the old Codex language model built by OpenAI).\n\n", ""),
  ...PATHS,
  // The variables codex puts in the shell (CODEX_HOME, CODEX_THREAD_ID, CODEX_SESSION_ID, CODEX_CI).
  { pattern: /CODEX_/g, with: "AGENT_", tier: "word" },
  { pattern: /codex/gi, with: "agent", tier: "word" },
  ...OURO_WORDS,
]

const OPENHANDS: readonly Replacement[] = [
  sentence("You are OpenHands agent, a helpful AI assistant", "You are a helpful AI assistant"),
  sentence("* When asked to find a previous local OpenHands conversation, search the workspace's `workspace/conversations/` directory for its event history.\n", ""),
  sentence("* For more information about skills, see: https://docs.openhands.dev/overview/skills\n", ""),
  { pattern: /<SELF_DOCUMENTATION>[\s\S]*?<\/SELF_DOCUMENTATION>\n\n/g, with: "", tier: "sentence" },
  sentence("an AI agent (OpenHands) on behalf of", "an AI agent on behalf of"),
  sentence("Based on OpenHands security risk levels but adapted for agent-sdk.\n", ""),
  ...PATHS,
  { pattern: /openhands/gi, with: "agent", tier: "word" },
  { pattern: /open hands/gi, with: "agent", tier: "word" },
  { pattern: /all-hands/gi, with: "agent", tier: "word" },
  ...OURO_WORDS,
]

export const H_REPLACEMENTS: Readonly<Record<string, readonly Replacement[]>> = {
  ouro: [...PATHS, ...OURO_WORDS],
  codex: CODEX,
  openhands: OPENHANDS,
}

/** The folder openhands' terminal reports after a command, the last such line in its result. */
const REPORTED_FOLDER = /\[Current working directory: ([^\]\n]+)\]/g
const reportedFolder = (result: string): string | undefined => [...result.matchAll(REPORTED_FOLDER)].at(-1)?.[1]

/** A shell call's command and folder, from the arm's own arguments; null when they aren't readable. */
function shellArgs(arm: string, name: string, args: string, folder: string | undefined): { command: string; cwd?: string } | null {
  const tool = arm === "codex" ? "exec_command" : arm === "openhands" ? "terminal" : null
  if (name !== tool) return null
  let value: unknown
  try {
    value = JSON.parse(args)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const fields = value as Record<string, unknown>
  const command = arm === "codex" ? fields.cmd : fields.command
  if (typeof command !== "string") return null
  // codex names the call's folder. openhands' tmux keeps the folder between calls, so a call starts where the terminal
  // reported it was after the call before; the first starts in the workdir, the bundle.
  const cwd = arm === "codex" ? (typeof fields.workdir === "string" ? fields.workdir : undefined) : folder
  return cwd === undefined ? { command } : { command, cwd }
}

/** codex's exec_command and openhands' terminal as the `shell` calls the books cases' assertions read. */
export function canonicalH(arm: string, obs: Observation): Observation {
  let mapped = 0
  let folder: string | undefined
  const timeline = obs.timeline.map((entry): TraceCall | typeof entry => {
    if (entry.kind !== "call") return entry
    const shell = shellArgs(arm, entry.name, entry.args, folder)
    if (!shell) return entry
    if (arm === "openhands") folder = reportedFolder(entry.result) ?? folder
    mapped += 1
    return { ...entry, name: "shell", args: JSON.stringify(shell) }
  })
  emitNervesEvent({ component: "eval", event: "eval.h_canonical", message: "read an H arm's calls as shell calls", meta: { arm, mapped } })
  return { ...obs, timeline }
}

export const H_KIT: ProductKit & { images: readonly string[] } = {
  guest: ({ session, arm, case: c, debrief }) => {
    const last = c.prefix[c.prefix.length - 1]!
    return {
      entry: "h-guest-entry.js",
      turn: { product: session.product, arm: arm.arm, labelLine: labelLine(session.product, arm.label), prefix: c.prefix.slice(0, -1), userText: last.content, followUps: [debrief] },
      ...(arm.arm === "ouro" ? {} : { image: arm.arm }),
    }
  },
  canonical: canonicalH,
  fidelity: { "H:ouro": [...H_OURO_FIDELITY], "H:codex": [...H_CODEX_FIDELITY], "H:openhands": [...H_OPENHANDS_FIDELITY] },
  replacements: (arm) => Object.hasOwn(H_REPLACEMENTS, arm) ? H_REPLACEMENTS[arm] : undefined,
  images: H_ARMS_IMAGES,
}
