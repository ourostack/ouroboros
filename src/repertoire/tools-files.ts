import * as fs from "fs";
import * as fg from "fast-glob";
import * as path from "path";
import { getAgentRoot } from "../heart/identity";
import { fileStateCache } from "../mind/file-state";
import { trackModifiedFile, getModifiedFileCount, getPostImplementationScrutiny } from "../mind/scrutiny";
import type { ToolDefinition } from "./tools-base";
import { editFileReadTracker, type ToolContext } from "./tools-base";
import { psycheEditNote, psycheFileClass } from "./guardrails";
import { SKIP_DIRS, TOOL_MAX_CHARS, TOOL_MAX_LINES, cutNotice, looksBinary } from "./tool-limits";

const LIST_CAP = 500
const GREP_MAX_MATCHES = 100
const GREP_MAX_LINE_CHARS = 500

/** The psyche edit note for a write that landed on one of the agent's identity files, or "" for any other file. */
function psycheNoteFor(resolvedPath: string, ctx: ToolContext | undefined): string {
  try {
    const agentRoot = ctx?.agentRoot ?? getAgentRoot()
    if (psycheFileClass(resolvedPath, agentRoot) !== "identity") return ""
    // The note names the file that actually changed, even when the write went through a link.
    const relative = path.relative(fs.realpathSync.native(path.resolve(agentRoot, "psyche")), fs.realpathSync.native(resolvedPath))
    return `\n\n${psycheEditNote(relative.split(path.sep).join("/"))}`
  } catch {
    /* v8 ignore next -- defensive: the write already succeeded, so a failed lookup only drops the note @preserve */
    return ""
  }
}

/** Relative paths start in the agent's home (its bundle); absolute paths are used as given. */
function resolveLocalToolPath(targetPath: string, ctx?: ToolContext): string {
  if (!path.isAbsolute(targetPath)) {
    return path.resolve(ctx?.agentRoot ?? getAgentRoot(), targetPath)
  }
  return targetPath
}

function homeOf(ctx?: ToolContext): string {
  return ctx?.agentRoot ?? getAgentRoot()
}

/** state/ holds the runtime's own data (mail, sessions, logs, saved tool output): a search of the whole home leaves it out and says so. */
const RUNTIME_DATA_DIR = "state"

function searchesWholeHome(target: string, home: string): boolean {
  return path.resolve(target) === path.resolve(home) && fs.statSync(path.join(home, RUNTIME_DATA_DIR), { throwIfNoEntry: false })?.isDirectory() === true
}

function skippedStateNote(param: "path" | "cwd"): string {
  return `[skipped state/, the runtime's own data; pass ${param} "state" to search it]`
}

/** Keep the whole lines that fit the line and character caps. A first line over the character cap is cut to it. */
function fitLines(lines: string[]): string[] {
  const kept: string[] = []
  let chars = 0
  for (const line of lines.slice(0, TOOL_MAX_LINES)) {
    if (chars + line.length + 1 > TOOL_MAX_CHARS) break
    kept.push(line)
    chars += line.length + 1
  }
  return kept.length > 0 || lines.length === 0 ? kept : [lines[0].slice(0, TOOL_MAX_CHARS)]
}

function buildContextDiff(lines: string[], changeStart: number, changeEnd: number, contextSize = 3): string {
  const start = Math.max(0, changeStart - contextSize)
  const end = Math.min(lines.length, changeEnd + contextSize)
  const result: string[] = []
  for (let i = start; i < end; i++) {
    const lineNum = i + 1
    const prefix = (i >= changeStart && i < changeEnd) ? ">" : " "
    result.push(`${prefix} ${lineNum} | ${lines[i]}`)
  }
  return result.join("\n")
}

/** A file's bytes, whatever readFileSync handed back (a stubbed reader may return a string). */
function asBuffer(raw: Buffer | string): Buffer {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
}

export const fileToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file in your home, with a relative path or an absolute one. Shows up to 2000 lines or 30,000 characters and tells you the offset to read on from; binary files are not shown.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "number", description: "1-based line number to start reading from" },
            limit: { type: "number", description: "maximum number of lines to return" },
            char_offset: { type: "number", description: "1-based character to start from within the first line shown, to read on through a line over 30,000 characters" },
          },
          required: ["path"],
        },
      },
    },
    handler: (a, ctx) => {
      const resolvedPath = resolveLocalToolPath(a.path, ctx)
      const raw = asBuffer(fs.readFileSync(resolvedPath))
      if (looksBinary(raw)) return `[binary file, ${raw.length} bytes; not shown]`
      const full = raw.toString("utf-8")
      // A final newline ends the last line; it is not another, empty line.
      const endsWithNewline = full.endsWith("\n")
      const lines = (endsWithNewline ? full.slice(0, -1) : full).split("\n")
      editFileReadTracker.add(resolvedPath)
      const offset = a.offset ? parseInt(a.offset, 10) : undefined
      const limit = a.limit ? parseInt(a.limit, 10) : undefined
      const charStart = a.char_offset ? Math.max(0, parseInt(a.char_offset, 10) - 1) : 0
      const start = offset ? offset - 1 : 0
      const wanted = lines.slice(start, limit !== undefined ? start + limit : undefined)
      const firstLine = wanted.length > 0 ? wanted[0].slice(charStart) : ""
      const kept = fitLines(wanted.length > 0 ? [firstLine, ...wanted.slice(1)] : wanted)
      // The first line alone is over the character cap: show its next stretch and say where to continue.
      const firstLineCut = kept.length === 1 && wanted.length > 0 && kept[0].length < firstLine.length
      const text = kept.join("\n") + (!firstLineCut && start + kept.length >= lines.length && endsWithNewline && kept.length > 0 ? "\n" : "")
      const whole = offset === undefined && limit === undefined && charStart === 0 && !firstLineCut && kept.length === wanted.length

      // Record in file state cache for staleness detection
      try {
        const mtime = fs.statSync(resolvedPath).mtimeMs
        if (whole) fileStateCache.record(resolvedPath, text, mtime)
        else fileStateCache.record(resolvedPath, text, mtime, start + 1, kept.length)
      } catch {
        // stat failed -- skip cache recording
      }

      if (firstLineCut) {
        const shownTo = charStart + kept[0].length
        return `${text}\n${cutNotice("read_file", `[line ${start + 1} is ${wanted[0].length} characters; characters ${charStart + 1}-${shownTo} shown; read on with offset=${start + 1} and char_offset=${shownTo + 1}]`, { path: resolvedPath })}`
      }
      if (kept.length === wanted.length) return text
      const last = start + kept.length
      return `${text}\n${cutNotice("read_file", `[lines ${start + 1}-${last} of ${lines.length} shown; read on with offset=${last + 1}]`, { path: resolvedPath })}`
    },
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "write_file",
        description: "Prefer this tool for creating new files or fully replacing existing ones. You MUST read an existing file with read_file before overwriting it. Prefer edit_file for modifying existing files -- it only sends the diff.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
    handler: (a, ctx) => {
      const resolvedPath = resolveLocalToolPath(a.path, ctx)
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      fs.writeFileSync(resolvedPath, a.content, "utf-8")
      trackModifiedFile(resolvedPath)
      const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())
      const note = psycheNoteFor(resolvedPath, ctx)
      /* v8 ignore next -- scrutiny appendix branch depends on session-level file count @preserve */
      return (scrutiny ? `ok\n\n${scrutiny}` : "ok") + note
    },
    summaryKeys: ["path"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "writes file contents" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Surgically edit a file by replacing an exact string. The file MUST have been read via read_file first -- this tool will reject the call otherwise. old_string must match EXACTLY ONE location in the file -- if it matches zero or multiple, the edit fails. To fix: provide more surrounding context to make the match unique. Preserve exact indentation (tabs/spaces) from the file. Prefer this over write_file for modifications -- it only sends the diff.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    handler: (a, ctx) => {
      const resolvedPath = resolveLocalToolPath(a.path, ctx)
      if (!editFileReadTracker.has(resolvedPath)) {
        return `error: you must read the file with read_file before editing it. call read_file on ${a.path} first.`
      }

      // Check staleness before editing
      const stalenessCheck = fileStateCache.isStale(resolvedPath)

      let content: string
      try {
        content = fs.readFileSync(resolvedPath, "utf-8")
      } catch (e) {
        return `error: could not read file: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(e)}`
      }

      // Count occurrences
      const occurrences: number[] = []
      let searchFrom = 0
      while (true) {
        const idx = content.indexOf(a.old_string, searchFrom)
        if (idx === -1) break
        occurrences.push(idx)
        searchFrom = idx + 1
      }

      if (occurrences.length === 0) {
        return `error: old_string not found in ${a.path}`
      }

      if (occurrences.length > 1) {
        return `error: old_string is ambiguous -- found ${occurrences.length} matches in ${a.path}. provide more context to make the match unique.`
      }

      // Single unique match -- replace
      const idx = occurrences[0]
      const updated = content.slice(0, idx) + a.new_string + content.slice(idx + a.old_string.length)
      fs.writeFileSync(resolvedPath, updated, "utf-8")

      // Update file state cache with new content
      try {
        const newMtime = fs.statSync(resolvedPath).mtimeMs
        fileStateCache.record(resolvedPath, updated, newMtime)
      } catch {
        // stat failed -- skip cache update
      }

      // Build contextual diff
      const lines = updated.split("\n")
      const prefixLines = content.slice(0, idx).split("\n")
      const changeStartLine = prefixLines.length - 1
      const newStringLines = a.new_string.split("\n")
      const changeEndLine = changeStartLine + newStringLines.length

      const diffResult = buildContextDiff(lines, changeStartLine, changeEndLine)
      const note = psycheNoteFor(resolvedPath, ctx)

      // Track modified file and compute scrutiny appendix
      trackModifiedFile(resolvedPath)
      const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())

      // Append staleness warning if detected (do not block -- TTFA)
      /* v8 ignore start -- staleness+diff+scrutiny combo not exercised in integration tests @preserve */
      if (stalenessCheck.stale) {
        const base = `${diffResult}\n\n⚠️ warning: file changed externally since last read -- re-read recommended`
        return (scrutiny ? `${base}\n\n${scrutiny}` : base) + note
      }
      /* v8 ignore stop */
      /* v8 ignore next -- scrutiny appendix branch depends on session-level file count @preserve */
      return (scrutiny ? `${diffResult}\n\n${scrutiny}` : diffResult) + note
    },
    summaryKeys: ["path"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "edits file contents" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "ls",
        description: "List a directory in your home (default: home itself), one entry per line; directories end in /, files show their size. Shows at most 500 entries.",
        parameters: { type: "object", properties: { path: { type: "string", description: "directory to list (defaults to your home)" } } },
      },
    },
    handler: (a, ctx) => {
      const dir = a.path ? resolveLocalToolPath(a.path, ctx) : homeOf(ctx)
      const names = fs.readdirSync(dir).sort()
      const lines = names.slice(0, LIST_CAP).map((name) => {
        const info = fs.statSync(path.join(dir, name), { throwIfNoEntry: false })
        return info?.isDirectory() ? `${name}/` : `${name}  ${info?.size ?? 0}`
      })
      if (names.length > LIST_CAP) lines.push(cutNotice("ls", `[${LIST_CAP} of ${names.length} entries shown; pass a subdirectory path to see the rest]`, { path: dir }))
      return lines.length > 0 ? lines.join("\n") : "(empty)"
    },
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "glob",
        description: "Find files in your home matching a glob pattern, sorted. Skips .git, node_modules and, from the top of your home, state/, and shows at most 500 matches.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "glob pattern (e.g. **/*.md)" },
            cwd: { type: "string", description: "directory to search from (defaults to your home)" },
          },
          required: ["pattern"],
        },
      },
    },
    handler: (a, ctx) => {
      const cwd = a.cwd ? resolveLocalToolPath(a.cwd, ctx) : homeOf(ctx)
      // A cwd the caller chose is searched as asked; only the default (the whole home) leaves state/ out.
      const skipsState = !a.cwd && searchesWholeHome(cwd, cwd)
      const ignore = [...SKIP_DIRS.map((d) => `**/${d}/**`), ...(skipsState ? [`${RUNTIME_DATA_DIR}/**`] : [])]
      const matches = fg.globSync(a.pattern, { cwd, dot: true, ignore }).sort()
      const note = skipsState ? [skippedStateNote("cwd")] : []
      if (matches.length <= LIST_CAP) return [...matches, ...note].join("\n")
      return [...matches.slice(0, LIST_CAP), cutNotice("glob", `[${LIST_CAP} of ${matches.length} matches shown; narrow the pattern or cwd]`, { pattern: a.pattern }), ...note].join("\n")
    },
    summaryKeys: ["pattern", "cwd"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "grep",
        description: "Search file contents in your home for a regex, with file path and line numbers; skips .git, node_modules, binary files and, from the top of your home, state/. Shows at most 100 matches and says how many there were in all.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "regex pattern to search for" },
            path: { type: "string", description: "file or directory to search (defaults to your home)" },
            context_lines: { type: "number", description: "number of surrounding context lines (default 0)" },
            include: { type: "string", description: "glob filter to limit searched files (e.g. *.md)" },
            ignore_case: { type: "boolean", description: "match without regard to case" },
            files_only: { type: "boolean", description: "list only the names of files that match" },
          },
          required: ["pattern"],
        },
      },
    },
    handler: (a, ctx) => {
      const targetPath = a.path ? resolveLocalToolPath(a.path, ctx) : homeOf(ctx)
      const regex = new RegExp(a.pattern, a.ignore_case ? "i" : "")
      const contextLines = parseInt(a.context_lines || "0", 10)
      const includeGlob = a.include || undefined
      const filesOnly = Boolean(a.files_only)
      let matchCount = 0
      let stopped = false
      let totalMatches = 0

      const clipLine = (line: string) => line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS - 3)}...` : line

      const home = homeOf(ctx)
      const skipsState = searchesWholeHome(targetPath, home)
      const stateDir = path.join(home, RUNTIME_DATA_DIR)
      // Paths inside the home are shown relative to it.
      const shown = (filePath: string): string => {
        const relative = path.relative(home, filePath)
        return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath
      }

      function searchFile(filePath: string): string[] {
        let buffer: Buffer
        try {
          buffer = asBuffer(fs.readFileSync(filePath))
        } catch {
          return []
        }
        if (looksBinary(buffer)) return []
        const lines = buffer.toString("utf-8").split("\n")
        const matchIndices = new Set<number>()
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i])) continue
          // Past the cap, matches are still counted so the notice can say how much was left unseen.
          totalMatches++
          if (matchCount >= GREP_MAX_MATCHES) {
            stopped = true
            if (filesOnly) break
            continue
          }
          matchCount++
          matchIndices.add(i)
          if (filesOnly) break
        }
        if (matchIndices.size === 0) return []
        if (filesOnly) return [shown(filePath)]

        const outputIndices = new Set<number>()
        for (const idx of matchIndices) {
          const start = Math.max(0, idx - contextLines)
          const end = Math.min(lines.length - 1, idx + contextLines)
          for (let i = start; i <= end; i++) {
            outputIndices.add(i)
          }
        }

        return [...outputIndices].sort((x, y) => x - y).map((idx) =>
          `${matchIndices.has(idx) ? "" : "-"}${shown(filePath)}:${idx + 1}: ${clipLine(lines[idx])}`)
      }

      function collectFiles(dirPath: string): string[] {
        const files: string[] = []
        function walk(dir: string) {
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.includes(entry.name) && !(skipsState && fullPath === stateDir)) walk(fullPath)
            } else if (entry.isFile()) {
              files.push(fullPath)
            }
          }
        }
        walk(dirPath)
        return files.sort()
      }

      function matchesGlob(filePath: string, glob: string): boolean {
        const escaped = glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")
        return new RegExp(`(^|/)${escaped}$`).test(filePath)
      }

      const stat = fs.statSync(targetPath, { throwIfNoEntry: false })
      if (!stat) return ""

      let files = [targetPath]
      if (!stat.isFile()) {
        files = collectFiles(targetPath)
        if (includeGlob) files = files.filter((f) => matchesGlob(f, includeGlob))
      }

      const results: string[] = []
      for (const file of files) {
        results.push(...searchFile(file))
      }
      if (stopped) results.push(cutNotice("grep", `[${GREP_MAX_MATCHES} of ${totalMatches} ${filesOnly ? "files" : "matches"} shown; narrow the pattern or path]`, { pattern: a.pattern }))
      if (skipsState) results.push(skippedStateNote("path"))
      return results.join("\n")
    },
    summaryKeys: ["pattern", "path", "include"],
  },
]
