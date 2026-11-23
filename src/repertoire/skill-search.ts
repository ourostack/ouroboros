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
/** The skill text one reply may carry, shared across its hits, so two hits cost no more than one. */
const MAX_NOTE_CHARS = 900
const MAX_RUNS_CHARS = 200

/** Stems that name the same job, so "delete the book" finds a section that says "removing". */
const SAME_AS: Readonly<Record<string, string>> = { delet: "remov", eras: "remov", ebook: "book" }
/**
 * The catalog's words with a final "e" dropped too, so "remove", "removed" and "removing" are one word, as are
 * "replace" and "replacing"; then the synonyms.
 */
const searchWords = (text: string): string[] => words(text)
  .map((word) => (word.length > 4 && word.endsWith("e") ? word.slice(0, -1) : word))
  .map((word) => SAME_AS[word] ?? word)

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
  let own = 0
  let anchored = false
  let score = 0
  for (const term of terms) {
    const inSection = (heading.has(term) ? 3 : 0) + (body.has(term) ? 1 : 0)
    if (inSection > 0) own += 1
    if (heading.has(term) || about.has(term)) anchored = true
    score += inSection + (about.has(term) ? 2 : 0)
  }
  // Only the section's own words count toward a match, so a skill's name or description alone can't make one. And
  // the match needs an anchor in the section's heading or the skill's description: common words that a body happens
  // to use ("check", "server") are not what the section is about.
  return { section, covered: anchored ? own : 0, score }
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
    // Within a skill, the section that answers most of the query, then the heading's weight: "remove" in a heading
    // beats it in a passing rule.
    const top = scored.sort((a, b) => b.covered - a.covered || b.score - a.score)[0]
    // Across skills, the skill that answers more of the query wins.
    if (top) best.push(top)
  }
  best.sort((a, b) => b.covered - a.covered || b.score - a.score)
  // A second skill comes back only when it answers as much of the query and nearly as strongly (80%).
  const hits = best.filter((entry) => entry.covered === best[0]!.covered && entry.score * 5 >= best[0]!.score * 4)
    .slice(0, MAX_SKILLS).map((entry) => entry.section)
  emitNervesEvent({
    component: "repertoire", event: "repertoire.skill_search", message: "find_tools searched the skills",
    meta: { skills: names.length, sections: sectionCount, hits: hits.length },
  })
  return hits
}

/**
 * The skill note for a `find_tools` reply on a turn that offers `tools`. Skill text goes only to a turn that could
 * read the skill anyway (through `load_skill` or `read_file`), so a friend's or guest's turn gets none.
 */
export function findToolsSkillNote(query: string, tools: ReadonlySet<string>): { hits: number; note: string } {
  if (!tools.has("load_skill") && !tools.has("read_file")) return { hits: 0, note: "" }
  const hits = searchSkills(query)
  return { hits: hits.length, note: formatSkillHits(hits, { loadSkill: tools.has("load_skill") }) }
}

/** A clipped section that cut a code block open gets it closed again. */
function closeFence(text: string): string {
  return (text.match(/```/g)?.length ?? 0) % 2 === 1 ? `${text}\n\`\`\`` : text
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The hits as `find_tools` shows them: the section's own words and how to open the whole skill. */
export function formatSkillHits(hits: readonly SkillSection[], offered: { loadSkill: boolean }): string {
  const each = Math.floor(MAX_NOTE_CHARS / Math.max(hits.length, 1))
  return hits.map((hit) => {
    const open = offered.loadSkill ? `load_skill ${hit.skill}` : `read_file ${hit.path}`
    const runs = hit.runs ? `\nits commands run as: ${clip(hit.runs, MAX_RUNS_CHARS)}` : ""
    return `skill ${hit.skill} documents this, in "${hit.heading}" (${open} for the whole skill):\n${closeFence(clip(hit.text, each))}${runs}`
  }).join("\n\n")
}
