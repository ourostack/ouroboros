/**
 * The one books implementation under every X arm: the bundle's `books` command (in the eval, the books stub, run
 * against the fake household), started with an argv and no shell, in its own folder. Paths in its answers are made
 * relative to that folder, so no arm shows the production path (whose folder names carry brand words), and a relative
 * path an arm passes back resolves to the same file.
 */
import { execFile } from "node:child_process"
import { emitNervesEvent } from "../../../nerves/runtime"

export type CoreResult = {
  /** The books command's exit code: 0 done, 1 failed, 2 bad arguments. */
  code: number
  /** Its JSON answer, or null when it printed none. */
  json: Record<string, unknown> | null
  /** What it printed, with paths made relative. */
  output: string
}

export type BooksCore = (argv: string[]) => Promise<CoreResult>

export type ExecFile = (file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }) => Promise<{ code: number; stdout: string; stderr: string }>

/* v8 ignore start -- process wiring: the core's handling of what the process printed is tested with an injected exec @preserve */
const nodeExecFile: ExecFile = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0
    resolve({ code, stdout, stderr: stderr || (error && typeof (error as { code?: unknown }).code !== "number" ? error.message : "") })
  })
})
/* v8 ignore stop */

/** `text` with every path under `home` made relative to it, and `home` itself as `.`. */
export function relativize(text: string, home: string): string {
  const bare = home.replace(/\/+$/, "")
  return text.split(`${bare}/`).join("").split(bare).join(".")
}

export function booksCore(input: { home: string; command?: string; exec?: ExecFile; timeoutMs?: number }): BooksCore {
  const exec = input.exec ?? nodeExecFile
  const command = input.command ?? `${input.home}/books`
  return async (argv) => {
    emitNervesEvent({ component: "eval", event: "eval.interview_books_start", message: "running a books operation", meta: { words: argv.slice(0, 2).join(" ") } })
    const run = await exec(command, argv, { cwd: input.home, timeout: input.timeoutMs ?? 180_000, maxBuffer: 8 * 1024 * 1024 })
    const output = relativize(run.stdout.trim(), input.home)
    let json: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(output)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
    } catch {
      // Not JSON: the arm shows the command's output as it is.
    }
    if (json === null) {
      emitNervesEvent({ component: "eval", level: "warn", event: "eval.interview_books_unparsed", message: "a books operation printed no JSON answer", meta: { code: run.code } })
      return { code: run.code === 0 ? 1 : run.code, json: { ok: false, error: relativize(run.stderr.trim() || output || `the books command exited ${run.code} with no answer`, input.home) }, output }
    }
    return { code: run.code, json, output }
  }
}

/** The core's error message when the operation failed outright (not a verdict such as a failed check). */
export function coreError(result: CoreResult): string | null {
  const error = result.json?.error
  return result.json?.ok === false && typeof error === "string" ? error : null
}
