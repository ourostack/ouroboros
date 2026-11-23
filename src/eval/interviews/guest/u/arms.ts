/**
 * The three U arms (pre-registration section 2): the same project and the same five tools in every arm, with only the
 * component kit installed under `@kit/ui` changing. The image (deploy/eval/u) holds one project template per kit,
 * each under a neutral folder name, with the kit and its dependencies brand-rewritten in `node_modules`, and the
 * checking tools apart from all of them. At the start of a conversation the template's files are copied to the
 * project folder and its `node_modules` is linked in, so every path the model sees is the same in every arm.
 *
 * Tools (section 4): `read_file`, `write_file` and `list_files` work inside the project only (reading may follow the
 * `node_modules` link into the template's packages; nothing can be written into any `node_modules`, or through a
 * link out of the project); `run_checks` runs the type-check and an axe scan of the rendered component; `finish`
 * ends the job. The grade, once the conversation has ended, runs the same checks and the hidden test.
 *
 * The trust boundary: the checking tools run as the guest's user, from a folder the file tools refuse. The type-check
 * never runs the model's code. The axe scan and the hidden test bundle the component for the browser and run it in
 * jsdom in a separate process under Node's permission model, which can read neither the tools' own files nor any
 * project and can write nothing; its result counts only when signed with a key the page never sees
 * (deploy/eval/u/tools).
 */
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { emitNervesEvent } from "../../../../nerves/runtime"
import type { Arm, ArmTool, ToolAnswer } from "../arms"

export const U_ARMS = ["ouro", "shadcn", "mui"] as const
export type UArm = (typeof U_ARMS)[number]

/** Each arm's template folder name in the image: neutral, so no path names a kit. */
export const KIT_SLOTS: Readonly<Record<UArm, string>> = { ouro: "k1", shadcn: "k2", mui: "k3" }

/** Where the image keeps the templates and the tools, and where the project is made; tests give their own. */
export type UPaths = { kits: string; tools: string; project: string }
export const U_PATHS: UPaths = { kits: "/opt/u-kits", tools: "/opt/u-tools", project: "/tmp/work" }

/** The component the job asks for, as the checks and the hidden test read it. */
export const COMPONENT = "src/RemoveCopy.tsx"

/** The longest answer one file read gives, in characters; a longer file is cut with a note saying where to read on. */
export const READ_LIMIT = 60_000
/** How long one check run may take. */
export const CHECK_TIMEOUT_MS = 120_000

export type Exec = (file: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

/** Runs a file with its arguments, never through a shell; a run that could not start answers code 1 with why. */
export const execNode: Exec = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
    resolve({ code, stdout, stderr: error && !stderr ? error.message : stderr })
  })
})

export const U_TOOLS: ArmTool[] = [
  {
    name: "read_file",
    description: `Read a text file in the project. The path is relative to the project folder, for example src/RemoveCopy.tsx or node_modules/@kit/ui/package.json. Gives at most ${READ_LIMIT} characters; give offset to read on.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file's path, relative to the project folder." },
        offset: { type: "integer", description: "The character to start from; leave it out to start at the beginning." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write a text file in the project, replacing it if it exists and making its folders. The path is relative to the project folder; nothing in node_modules can be written.",
    parameters: { type: "object", properties: { path: { type: "string", description: "The file's path, relative to the project folder." }, content: { type: "string", description: "The whole new content of the file." } }, required: ["path", "content"] },
  },
  {
    name: "list_files",
    description: "List one folder in the project: its files, and its folders with a trailing /. The path is relative to the project folder; leave it out for the project folder itself.",
    parameters: { type: "object", properties: { path: { type: "string", description: "The folder's path, relative to the project folder." } } },
  },
  {
    name: "run_checks",
    description: `Run the project's checks: a TypeScript type-check of the project, then an accessibility scan (axe) of ${COMPONENT} rendered with a test onRemove. Returns what each found.`,
    parameters: { type: "object", properties: {} },
  },
  {
    name: "finish",
    description: "Finish the job. Call it once the component is written and the checks have been run, with a short summary for the user.",
    parameters: { type: "object", properties: { summary: { type: "string", description: "A short summary for the user of what was built." } }, required: ["summary"] },
  },
]

const parse = (args: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(args || "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

const fail = (text: string): ToolAnswer => ({ text, isError: true })

/**
 * Copies the arm's template into the project, all but `node_modules`, which is linked. Each conversation runs in a
 * fresh container, so the project folder is new; one that already holds anything is refused, never cleared.
 */
export function makeProject(slot: string, paths: UPaths): void {
  const template = path.join(paths.kits, slot)
  if (!fs.existsSync(template)) throw new Error(`no project template ${slot} in the image`)
  if (fs.existsSync(paths.project) && fs.readdirSync(paths.project).length > 0) throw new Error("the project folder is not empty")
  fs.mkdirSync(paths.project, { recursive: true })
  for (const name of fs.readdirSync(template)) {
    if (name === "node_modules") fs.symlinkSync(path.join(template, "node_modules"), path.join(paths.project, "node_modules"))
    else fs.cpSync(path.join(template, name), path.join(paths.project, name), { recursive: true, verbatimSymlinks: true })
  }
}

const within = (real: string, root: string): boolean => real === root || real.startsWith(`${root}${path.sep}`)

const present = (full: string): boolean => {
  try {
    fs.lstatSync(full)
    return true
  } catch {
    return false
  }
}

/** The deepest part of `full` that is there (a broken link counts), with links followed; null when a link is broken. */
function realExisting(full: string): string | null {
  let at = full
  while (!present(at)) at = path.dirname(at)
  try {
    return fs.realpathSync(at)
  } catch {
    return null
  }
}

/**
 * A model-given path inside the project, or why it is refused. The path must stay inside the project as written.
 * A read, after links are followed, must stay inside the project or the template's `node_modules`. A write may not
 * name any `node_modules` folder, may not replace a link, and its deepest existing folder must be inside the project
 * once links are followed.
 */
export function resolveInProject(paths: UPaths, slot: string, given: unknown, mode: "read" | "write"): { full: string; shown: string } | { refused: string } {
  if (typeof given !== "string" || given.trim() === "") return { refused: "path must be a non-empty string, relative to the project folder" }
  const full = path.resolve(paths.project, given)
  const shown = path.relative(paths.project, full)
  if (shown === ".." || shown.startsWith(`..${path.sep}`) || path.isAbsolute(shown)) return { refused: `${given} is outside the project folder` }
  const project = fs.realpathSync(paths.project)
  if (mode === "write") {
    if (shown.split(path.sep).includes("node_modules")) return { refused: "nothing in node_modules can be written" }
    if (present(full) && fs.lstatSync(full).isSymbolicLink()) return { refused: `${shown} is a link, which can't be written` }
    const real = realExisting(full)
    if (real === null || !within(real, project)) return { refused: `${given} is outside the project folder` }
  } else if (fs.existsSync(full)) {
    const real = fs.realpathSync(full)
    if (!within(real, project) && !within(real, fs.realpathSync(path.join(paths.kits, slot, "node_modules")))) return { refused: `${given} is outside the project folder` }
  }
  return { full, shown: shown === "" ? "." : shown }
}

/** run_checks' JSON (deploy/eval/u/tools/check.mjs) as text for the model. */
export function checksText(result: { code: number; stdout: string; stderr: string }): string {
  let parsed: { typecheck?: { ok: boolean; output: unknown }; axe?: { ok: boolean; output: unknown } }
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed
  } catch {
    return `The checks could not run: ${(result.stderr || result.stdout).trim().slice(0, 4000)}`
  }
  const part = (name: string, entry?: { ok: boolean; output: unknown }): string => {
    if (!entry) return `${name}: not run`
    const output = typeof entry.output === "string" ? entry.output.trim() : ""
    return `${name}: ${entry.ok === true ? "passed" : "failed"}${output ? `\n${output}` : ""}`
  }
  return [part("Type-check", parsed.typecheck), part("Accessibility scan (axe)", parsed.axe)].join("\n\n")
}

function isFolder(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory()
  } catch {
    return false
  }
}

export function buildUArm(arm: string, options: { paths?: UPaths; exec?: Exec } = {}): Arm {
  if (!(U_ARMS as readonly string[]).includes(arm)) throw new Error(`no U arm ${arm}`)
  const paths = options.paths ?? U_PATHS
  const exec = options.exec ?? execNode
  const slot = KIT_SLOTS[arm as UArm]
  makeProject(slot, paths)
  emitNervesEvent({ component: "eval", event: "eval.u_arm_ready", message: "made the U project for an arm", meta: { slot } })
  const tool = (script: string) => exec(process.execPath, [path.join(paths.tools, script), paths.project], { cwd: paths.tools, timeoutMs: CHECK_TIMEOUT_MS })

  const call = async (name: string, args: string): Promise<ToolAnswer> => {
    const input = parse(args)
    if (!input) return fail("arguments must be a JSON object")
    if (name === "read_file") {
      const at = resolveInProject(paths, slot, input.path, "read")
      if ("refused" in at) return fail(at.refused)
      const offset = input.offset ?? 0
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return fail("offset must be a whole number, 0 or more")
      if (!fs.existsSync(at.full)) return fail(`no file ${at.shown}`)
      if (isFolder(at.full)) return fail(`${at.shown} is a folder; use list_files`)
      const text = fs.readFileSync(at.full, "utf8")
      const end = offset + READ_LIMIT
      const part = text.slice(offset, end)
      return { text: end < text.length ? `${part}\n[characters ${offset} to ${end} of ${text.length}; read on with offset ${end}]` : part, isError: false }
    }
    if (name === "write_file") {
      const at = resolveInProject(paths, slot, input.path, "write")
      if ("refused" in at) return fail(at.refused)
      if (typeof input.content !== "string") return fail("content must be a string")
      if (isFolder(at.full)) return fail(`${at.shown} is a folder`)
      fs.mkdirSync(path.dirname(at.full), { recursive: true })
      fs.writeFileSync(at.full, input.content)
      return { text: `Wrote ${at.shown} (${Buffer.byteLength(input.content)} bytes).`, isError: false }
    }
    if (name === "list_files") {
      const at = resolveInProject(paths, slot, input.path ?? ".", "read")
      if ("refused" in at) return fail(at.refused)
      if (!isFolder(at.full)) return fail(`no folder ${at.shown}`)
      const entries = fs.readdirSync(at.full, { withFileTypes: true })
        .map((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isFolder(path.join(at.full, entry.name))) ? `${entry.name}/` : entry.name)
        .sort()
      return { text: entries.length > 0 ? entries.join("\n") : "(empty)", isError: false }
    }
    if (name === "run_checks") return { text: checksText(await tool("check.mjs")), isError: false }
    if (name === "finish") {
      if (typeof input.summary !== "string" || input.summary.trim() === "") return fail("summary must be a non-empty string")
      return { text: input.summary, isError: false, ends: true }
    }
    return fail(`no tool ${name}`)
  }

  return {
    key: arm,
    tools: U_TOOLS,
    call,
    operationOf: () => null,
    grade: async () => {
      const result = await tool("grade.mjs")
      try {
        return JSON.parse(result.stdout) as unknown
      } catch {
        return { error: `the grader gave no result (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 2000)}` }
      }
    },
  }
}
