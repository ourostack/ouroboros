import * as fs from "fs";
import * as fg from "fast-glob";
import * as path from "path";
import { getRepoRoot } from "../heart/identity";
import { fileStateCache } from "../mind/file-state";
import { trackModifiedFile, getModifiedFileCount, getPostImplementationScrutiny } from "../mind/scrutiny";
import type { ToolDefinition } from "./tools-base";
import { editFileReadTracker } from "./tools-base";

function resolveLocalToolPath(targetPath: string): string {
  if (!path.isAbsolute(targetPath)) {
    return path.resolve(getRepoRoot(), targetPath)
  }
  return targetPath
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

export const fileToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read file contents. Results include line numbers. Use offset/limit for large files -- don't read the whole thing if you only need a section. Use this tool before editing any file. When reading code, read enough context to understand the surrounding logic, not just the target line.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "number", description: "1-based line number to start reading from" },
            limit: { type: "number", description: "maximum number of lines to return" },
          },
          required: ["path"],
        },
      },
    },
    handler: (a) => {
      const resolvedPath = resolveLocalToolPath(a.path)
      const content = fs.readFileSync(resolvedPath, "utf-8")
      editFileReadTracker.add(resolvedPath)
      const offset = a.offset ? parseInt(a.offset, 10) : undefined
      const limit = a.limit ? parseInt(a.limit, 10) : undefined

      // Record in file state cache for staleness detection
      try {
        const mtime = fs.statSync(resolvedPath).mtimeMs
        const readContent = (offset === undefined && limit === undefined)
          ? content
          : content.split("\n").slice(offset ? offset - 1 : 0, limit !== undefined ? (offset ? offset - 1 : 0) + limit : undefined).join("\n")
        fileStateCache.record(resolvedPath, readContent, mtime, offset, limit)
      } catch {
        // stat failed -- skip cache recording
      }

      if (offset === undefined && limit === undefined) return content
      const lines = content.split("\n")
      const start = offset ? offset - 1 : 0
      const end = limit !== undefined ? start + limit : lines.length
      return lines.slice(start, end).join("\n")
    },
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "write_file",
        description: "Prefer this tool for creating new files or fully replacing existing ones. You MUST read an existing file with read_file before overwriting it. Prefer edit_file for modifying existing files -- it only sends the diff. Do not create documentation files (*.md, README) by default; only do so when explicitly asked or when documentation is clearly part of the requested change.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
    handler: (a) => {
      const resolvedPath = resolveLocalToolPath(a.path)
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      fs.writeFileSync(resolvedPath, a.content, "utf-8")
      trackModifiedFile(resolvedPath)
      const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())
      /* v8 ignore next -- scrutiny appendix branch depends on session-level file count @preserve */
      return scrutiny ? `ok\n\n${scrutiny}` : "ok"
    },
    summaryKeys: ["path"],
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
    handler: (a) => {
      const resolvedPath = resolveLocalToolPath(a.path)
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

      // Track modified file and compute scrutiny appendix
      trackModifiedFile(resolvedPath)
      const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())

      // Append staleness warning if detected (do not block -- TTFA)
      /* v8 ignore start -- staleness+diff+scrutiny combo not exercised in integration tests @preserve */
      if (stalenessCheck.stale) {
        const base = `${diffResult}\n\n⚠️ warning: file changed externally since last read -- re-read recommended`
        return scrutiny ? `${base}\n\n${scrutiny}` : base
      }
      /* v8 ignore stop */
      /* v8 ignore next -- scrutiny appendix branch depends on session-level file count @preserve */
      return scrutiny ? `${diffResult}\n\n${scrutiny}` : diffResult
    },
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "glob",
        description: "Find files matching a glob pattern, sorted alphabetically. Use this instead of shell commands like `find` or `ls`. For broad exploratory searches that would require multiple rounds of globbing and grepping, consider using claude or coding_spawn.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "glob pattern (e.g. **/*.ts)" },
            cwd: { type: "string", description: "directory to search from (defaults to process.cwd())" },
          },
          required: ["pattern"],
        },
      },
    },
    handler: (a) => {
      const cwd = a.cwd ? resolveLocalToolPath(a.cwd) : process.cwd()
      const matches = fg.globSync(a.pattern, { cwd, dot: true })
      return matches.sort().join("\n")
    },
    summaryKeys: ["pattern", "cwd"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "grep",
        description:
          "Search file contents for lines matching a regex pattern. Searches recursively in directories. Use this instead of shell commands like `grep` or `rg`. Returns matching lines with file path and line numbers. Use context_lines for surrounding context. Use include to filter file types (e.g., '*.ts').",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "regex pattern to search for" },
            path: { type: "string", description: "file or directory to search" },
            context_lines: { type: "number", description: "number of surrounding context lines (default 0)" },
            include: { type: "string", description: "glob filter to limit searched files (e.g. *.ts)" },
          },
          required: ["pattern", "path"],
        },
      },
    },
    handler: (a) => {
      const targetPath = resolveLocalToolPath(a.path)
      const regex = new RegExp(a.pattern)
      const contextLines = parseInt(a.context_lines || "0", 10)
      const includeGlob = a.include || undefined

      function searchFile(filePath: string): string[] {
        let content: string
        try {
          content = fs.readFileSync(filePath, "utf-8")
        } catch {
          return []
        }
        const lines = content.split("\n")
        const matchIndices = new Set<number>()
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matchIndices.add(i)
          }
        }
        if (matchIndices.size === 0) return []

        const outputIndices = new Set<number>()
        for (const idx of matchIndices) {
          const start = Math.max(0, idx - contextLines)
          const end = Math.min(lines.length - 1, idx + contextLines)
          for (let i = start; i <= end; i++) {
            outputIndices.add(i)
          }
        }

        const sortedIndices = [...outputIndices].sort((a, b) => a - b)
        const results: string[] = []
        for (const idx of sortedIndices) {
          const lineNum = idx + 1
          if (matchIndices.has(idx)) {
            results.push(`${filePath}:${lineNum}: ${lines[idx]}`)
          } else {
            results.push(`-${filePath}:${lineNum}: ${lines[idx]}`)
          }
        }
        return results
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
              walk(fullPath)
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

      if (stat.isFile()) {
        return searchFile(targetPath).join("\n")
      }

      let files = collectFiles(targetPath)
      if (includeGlob) {
        files = files.filter((f) => matchesGlob(f, includeGlob))
      }

      const allResults: string[] = []
      for (const file of files) {
        allResults.push(...searchFile(file))
      }
      return allResults.join("\n")
    },
    summaryKeys: ["pattern", "path", "include"],
  },
]

