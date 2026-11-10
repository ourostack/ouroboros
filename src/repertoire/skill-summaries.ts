import * as fs from "fs"
import * as path from "path"
import { getAgentRoot, getRepoRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

const MAX_WHEN_LENGTH = 220

/**
 * The sentence a skill uses to say when it applies: a frontmatter `description:`, else the first line that starts
 * "i use this when", "use this when" or "use when". Shown beside the skill's name in the prompt, so a question that
 * a skill covers is answered with the skill rather than from whatever the prompt already holds.
 */
export function whenLine(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/)
  let body = lines
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1)
    if (end > 0) {
      const description = lines.slice(1, end).find((line) => /^description:\s*\S/i.test(line))
      if (description) return clip(description.replace(/^description:\s*/i, "").replace(/^["']|["']$/g, ""))
      body = lines.slice(end + 1)
    }
  }
  const line = body.map((l) => l.trim()).find((l) => /^(i |we )?use (this|it|me) when\b|^use when\b/i.test(l))
  return line ? clip(line) : null
}

function clip(text: string): string {
  const sentence = text.trim().match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text.trim()
  return sentence.length > MAX_WHEN_LENGTH ? `${sentence.slice(0, MAX_WHEN_LENGTH - 1)}…` : sentence
}

function skillPath(name: string): string | null {
  const roots: Array<() => string> = [
    () => path.join(getAgentRoot(), "skills"),
    () => path.join(getAgentRoot(), "skills", "protocols"),
    () => path.join(getRepoRoot(), "skills"),
  ]
  for (const root of roots) {
    try {
      const candidate = path.join(root(), `${name}.md`)
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // a root that cannot be resolved (no agent yet) has no skills
    }
  }
  return null
}

/** Each skill's "when" sentence, for the skills it can read; skills without one are left out. */
export function skillWhenLines(names: readonly string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const name of names) {
    const file = skillPath(name)
    if (!file) continue
    try {
      const when = whenLine(fs.readFileSync(file, "utf-8"))
      if (when) found.set(name, when)
    } catch {
      // an unreadable skill keeps just its name
    }
  }
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.skill_when_lines",
    message: "read when-lines for the prompt's skills list",
    meta: { skills: names.length, described: found.size },
  })
  return found
}
