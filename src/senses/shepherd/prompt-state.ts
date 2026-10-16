import { stripVTControlCharacters } from "node:util"
import { emitNervesEvent } from "../../nerves/runtime"

/** Rendered-shape allowlist, not a shell/prompt heuristic. Unknown variants never authorize input. */
export function inspectCodingPrompt(agent: string, screen: string): {
  activity: "idle" | "working" | "unknown"
  composer: "empty" | "draft" | "unknown"
} {
  emitNervesEvent({ component: "senses", event: "senses.shepherd_prompt_inspected", message: "classified a coding composer" })
  const unknown = { activity: "unknown", composer: "unknown" } as const
  const lines = stripVTControlCharacters(screen).split("\n").map(line => line.trimEnd())
  const name = agent.toLowerCase()
  if (!["copilot", "claude", "claude code", "codex"].includes(name)) return unknown
  if (/press enter to confirm|esc to cancel|allow this|approve this|❯\s*\d|›\s*\d[.)]/i.test(lines.join("\n"))) return unknown
  let input: string[]
  let footer: string
  if (name === "copilot") {
    const top = lines.findLastIndex(line => /^\s*╭▄{8,}$/.test(line))
    const bottom = lines.findIndex((line, i) => i > top && /^\s*╹▀{8,}$/.test(line))
    if (top < 0 || bottom <= top + 1) return unknown
    if (lines[top]!.length !== lines[bottom]!.length) return unknown
    const body = lines.slice(top + 1, bottom)
    if (!body.every(line => /^\s*┃/.test(line))) return unknown
    input = body.map(line => line.replace(/^\s*┃ ?/, ""))
    footer = lines.slice(bottom + 1).join("\n")
    if (!/(?:Interactive|Autopilot).*\/\s*commands|esc interrupt/i.test(footer)) return unknown
  } else if (name === "claude" || name === "claude code") {
    const top = lines.findLastIndex(line => /^\s*╭─{8,}╮$/.test(line))
    const bottom = lines.findIndex((line, i) => i > top && /^\s*╰─{8,}╯$/.test(line))
    if (top < 0 || bottom <= top + 1) return unknown
    if (lines[top]!.length !== lines[bottom]!.length) return unknown
    const body = lines.slice(top + 1, bottom)
    if (!/^\s*│ >/.test(body[0]!) || !body.every(line => /^\s*│.*│$/.test(line))) return unknown
    input = body.map((line, i) => line.replace(/^\s*│ ?/, "").replace(/│$/, "").replace(i === 0 ? /^> ?/ : /^/, ""))
    footer = lines.slice(bottom + 1).join("\n")
    if (!/bypass permissions on|shift\+tab to cycle|esc to interrupt/i.test(footer)) return unknown
  } else {
    const prompt = lines.findLastIndex(line => /^›(?: |$)/.test(line))
    const foot = lines.findIndex((line, i) => i > prompt && /\? for shortcuts/.test(line))
    if (prompt < 0 || foot < 0 || lines.slice(foot + 1).some(line => line.trim())) return unknown
    input = [lines[prompt]!.slice(1), ...lines.slice(prompt + 1, foot)]
    footer = lines[foot]!
  }
  if (input.some(line => /\[.*\]|enter a prompt|ask anything|type a message|implement \{/i.test(line))) return unknown
  const working = /esc(?: to)? interrupt|\b[1-9]\d* (?:running|background (?:tasks?|agents?|terminals?))\b|background terminal running/i.test(footer)
  return { activity: working ? "working" : "idle", composer: input.some(line => line.trim().length > 0) ? "draft" : "empty" }
}
