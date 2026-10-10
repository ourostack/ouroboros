import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Judgment guidance for coding-agent prompts, written by the human. It is guidance only: it never
 * authorizes a reply. Live replies come from the code floor, the human's exact precedents and a
 * standing owner grant. The agent reads these when it judges an escalated prompt.
 *
 * The bundle may hold its own `cmux-principles.md` (synced, human-authored); otherwise the seed
 * below applies. The seed is drawn from the operator's standing desk instructions.
 */
export const CMUX_PRINCIPLES_FILE = "cmux-principles.md"

export const SEED_CMUX_PRINCIPLES: readonly string[] = [
  "Keep routine work moving: a reversible step inside the session's own repository is the kind of thing the human wants answered without being woken.",
  "Never act in the human's voice: anything that sends, posts, comments, merges or messages as them goes to them.",
  "Never cause loss that cannot be undone: deleting files, force-pushing, rewriting shared history or wiping data goes to the human.",
  "Credentials, sign-in, two-factor codes, payments and accepting terms always belong to the human.",
  "Stay in scope: actions outside the session's repository, or beyond the task the session was given, go to the human.",
  "Never widen permissions: no 'always', 'all' or bypass answers, and no edits to agent settings, hooks or CI.",
  "Production, publishing and shared infrastructure go to the human unless they granted that exact action.",
  "When unsure, ask: a blocked routine prompt costs the human a minute; a wrong approval can cost far more.",
]

export function readCmuxPrinciples(agentRoot: string): { source: "bundle" | "seed"; principles: string[] } {
  try {
    const text = fs.readFileSync(path.join(agentRoot, CMUX_PRINCIPLES_FILE), "utf-8")
    const principles = text.split("\n").map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter((line) => line && !line.startsWith("#"))
    if (principles.length > 0) return { source: "bundle", principles }
  } catch {
    // No bundle file: use the seed.
  }
  emitNervesEvent({ component: "senses", event: "senses.cmux_principles_seeded", message: "using the seed cmux principles", meta: { agentRoot } })
  return { source: "seed", principles: [...SEED_CMUX_PRINCIPLES] }
}
