import * as fs from "fs"
import { emitNervesEvent } from "../nerves/runtime"
import { listSkills } from "./skills"
import { skillPath, whenLine } from "./skill-summaries"
import { words } from "./tool-catalog"

/**
 * Skill search for `find_tools`. A bundle often does a job with a command its skill documents (run through `shell`)
 * rather than with a door of its own, so a search of the held-back doors alone answers "nothing does that" when the
 * agent's own skill says how. This finds the skill section that covers the query, so `find_tools` can hand it back
 * in the same reply: one section per skill, at most two skills, clipped, and nothing when no skill fits.
 */
export interface SkillSection {
  readonly skill: string
  readonly path: string
  readonly heading: string
  readonly text: string
  /** The intro's first command block, when it has one: where the skill's bare commands run from. */
  readonly runs?: string
}

const MAX_SKILLS = 2
const MAX_SECTION_CHARS = 900
const MAX_RUNS_CHARS = 200

/** Words that name the same job, so "delete the book" finds a section that says "remove". */
const SAME_AS: Readonly<Record<string, string>> = { delete: "remove", erase: "remove", ebook: "book" }
const searchWords = (text: string): string[] => words(text).map((word) => SAME_AS[word] ?? word)

function firstCommandBlock(text: string): string | undefined {
  const block = /```[^\n]*\n([\s\S]*?)```/.exec(text)?.[1]?.trim()
  return block ? block : undefined
}

function withoutFrontmatter(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return lines.join("\n")
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  return end > 0 ? lines.slice(end + 1).join("\n") : lines.join("\n")
}

/** A skill's sections: the intro under its title, then one per `##` heading, each with its own lines only. */
export function skillSections(skill: string, file: string, markdown: string): SkillSection[] {
  const sections: Array<{ heading: string; lines: string[] }> = []
  let current: { heading: string; lines: string[] } = { heading: skill, lines: [] }
  sections.push(current)
  for (const line of withoutFrontmatter(markdown).split(/\r?\n/)) {
    const title = /^#\s+(.+)$/.exec(line)
    const heading = /^##\s+(.+)$/.exec(line)
    if (title && sections.length === 1 && current.lines.every((entry) => entry.trim() === "")) {
      current.heading = title[1]!.trim()
    } else if (heading) {
      current = { heading: heading[1]!.trim(), lines: [] }
      sections.push(current)
    } else {
      current.lines.push(line)
    }
  }
  const runs = firstCommandBlock(sections[0]!.lines.join("\n"))
  return sections
    .map((section) => ({ skill, path: file, heading: section.heading, text: section.lines.join("\n").trim(), ...(runs ? { runs } : {}) }))
    .filter((section, index) => index === 0 || section.text.length > 0)
}

interface Scored { readonly section: SkillSection; readonly covered: number; readonly score: number }

function scoreSection(terms: readonly string[], section: SkillSection, about: ReadonlySet<string>): Scored {
  const heading = new Set(searchWords(section.heading))
  const body = new Set(searchWords(section.text))
  let covered = 0
  let own = 0
  let score = 0
  for (const term of terms) {
    const inSection = (heading.has(term) ? 3 : 0) + (body.has(term) ? 1 : 0)
    const termScore = inSection + (about.has(term) ? 2 : 0)
    if (inSection > 0) own += 1
    if (termScore > 0) covered += 1
    score += termScore
  }
  // A section that matches nothing itself is only its skill's description; it can't be the answer.
  return { section, covered: own > 0 ? covered : 0, score }
}

/** The skill sections that cover a query, best first. `select:` queries name doors, so they find no skill. */
export function searchSkills(query: string): SkillSection[] {
  const trimmed = query.trim()
  const terms = trimmed.toLowerCase().startsWith("select:") ? [] : [...new Set(searchWords(trimmed))]
  const names = terms.length > 0 ? listSkills() ?? [] : []
  const needed = terms.length >= 2 ? 2 : 1
  let sectionCount = 0
  const best: Scored[] = []
  for (const name of names) {
    const file = skillPath(name)
    if (!file) continue
    let markdown: string
    try {
      markdown = fs.readFileSync(file, "utf-8")
    } catch {
      continue // an unreadable skill can't answer a search
    }
    const sections = skillSections(name, file, markdown)
    sectionCount += sections.length
    const about = new Set(searchWords(`${name} ${sections[0]!.heading} ${whenLine(markdown) ?? ""}`))
    const scored = sections.map((section) => scoreSection(terms, section, about)).filter((entry) => entry.covered >= needed)
    // Within a skill the heading carries the most weight, so "remove" in a heading beats it in a passing rule.
    const top = scored.sort((a, b) => b.score - a.score)[0]
    // Across skills, the skill that answers more of the query wins, whichever of its sections is shown.
    if (top) best.push({ ...top, covered: Math.max(...scored.map((entry) => entry.covered)) })
  }
  best.sort((a, b) => b.covered - a.covered || b.score - a.score)
  // A second skill comes back only when it answers as much of the query and nearly as strongly.
  const hits = best.filter((entry) => entry.covered === best[0]!.covered && entry.score * 2 >= best[0]!.score)
    .slice(0, MAX_SKILLS).map((entry) => entry.section)
  emitNervesEvent({
    component: "repertoire", event: "repertoire.skill_search", message: "find_tools searched the skills",
    meta: { skills: names.length, sections: sectionCount, hits: hits.length },
  })
  return hits
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The hits as `find_tools` shows them: the section's own words and how to open the whole skill. */
export function formatSkillHits(hits: readonly SkillSection[], offered: { loadSkill: boolean }): string {
  return hits.map((hit) => {
    const open = offered.loadSkill ? `load_skill ${hit.skill}` : `read_file ${hit.path}`
    const runs = hit.runs ? `\nits commands run as: ${clip(hit.runs, MAX_RUNS_CHARS)}` : ""
    return `skill ${hit.skill} documents this, in "${hit.heading}" (${open} for the whole skill):\n${clip(hit.text, MAX_SECTION_CHARS)}${runs}`
  }).join("\n\n")
}
