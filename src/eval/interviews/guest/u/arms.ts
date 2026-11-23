/**
 * The three U arms (pre-registration section 2): the same project and the same five tools in every arm, with only the
 * component kit installed under `@kit/ui` changing. The image (deploy/eval/u) holds one project template per kit,
 * each under a neutral folder name, with the kit and its dependencies brand-rewritten in `node_modules`, and the
 * checking tools apart from all of them. At the start of a conversation the template's files are copied to the
 * project folder and its `node_modules` is linked in, so every path the model sees is the same in every arm.
 *
 * Tools (section 4): `read_file`, `write_file` and `list_files` work inside the project only (reading may follow the
 * `node_modules` link into the template's packages; writing never reaches `node_modules`); `run_checks` runs the
 * type-check and an axe scan of the rendered component; `finish` ends the job. The grade, once the conversation has
 * ended, runs the same checks and the hidden test, from the tools folder the model cannot reach.
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
export const U_PATHS: UPaths = { kits: "/opt/u-kits", tools: "/opt/u-tools", project: "/home/ouro/work" }

/** The component the job asks for, as the checks and the hidden test read it. */
export const COMPONENT = "src/RemoveCopy.tsx"

/** The longest answer a file read gives, in characters; a longer file is cut with a note saying how to read on. */
export const READ_LIMIT = 60_000
/** How long one check run may take. */
export const CHECK_TIMEOUT_MS = 120_000

export type Exec = (file: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

/** Runs a file with its arguments, never through a shell; a run that could not start answers code 1 with why. */
export const execNode: Exec =(file, args, options) => new Promise((resolve) => {
  execFile(file, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
    resolve({ code, stdout, stderr: error && !stderr ? error.message : stderr })
  })
})

export const U_TOOLS: ArmTool[] = [
  {
    name: "read_file",
    description: "Read a text file in the project. The path is relative to the project folder, for example src/RemoveCopy.tsx or node_modules/@kit/ui/package.json.",
    parameters: { type: "object", properties: { path: { type: "string", description: "The file's path, relative to the project folder." } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write a text file in the project, replacing it if it exists and making its folders. The path is relative to the project folder; node_modules can't be written.",
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

/** Copies the arm's template into the project, all but `node_modules`, which is linked. */
export function makeProject(slot: string, paths: UPaths): void {
  const template = path.join(paths.kits, slot)
  if (!fs.existsSync(template)) throw new Error(`no project template ${slot} in the image`)
  fs.rmSync(paths.project, { recursive: true, force: true })
  fs.mkdirSync(paths.project, { recursive: true })
  for (const name of fs.readdirSync(template)) {
    if (name === "node_modules") fs.symlinkSync(path.join(template, "node_modules"), path.join(paths.project, "node_modules"))
    else fs.cpSync(path.join(template, name), path.join(paths.project, name), { recursive: true })
  }
}

/**
 * A model-given path inside the project, or why it is refused. The path must stay inside the project as written;
 * after links are followed it must stay inside the project or the template's `node_modules`, and a write may not
 * reach `node_modules` at all.
 */
export function resolveInProject(paths: UPaths, slot: string, given: unknown, mode: "read" | "write"): { full: string; shown: string } | { refused: string } {
  if (typeof given !== "string" || given.trim() === "") return { refused: "path must be a non-empty string, relative to the project folder" }
  const full = path.resolve(paths.project, given)
  const shown = path.relative(paths.project, full)
  if (shown.startsWith("..") || path.isAbsolute(shown)) return { refused: `${given} is outside the project folder` }
  const top = shown.split(path.sep)[0]
  if (mode === "write" && top === "node_modules") return { refused: "node_modules can't be written" }
  if (mode === "read" && fs.existsSync(full)) {
    const real = fs.realpathSync(full)
    const inside = [fs.realpathSync(paths.project), fs.realpathSync(path.join(paths.kits, slot, "node_modules"))]
    if (!inside.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) return { refused: `${given} is outside the project folder` }
  }
  return { full, shown: shown === "" ? "." : shown }
}

/** run_checks' JSON (deploy/eval/u/tools/check.mjs) as text for the model. */
export function checksText(result: { code: number; stdout: string; stderr: string }): string {
  let parsed: { typecheck?: { ok: boolean; output: string }; axe?: { ok: boolean; output: string } }
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed
  } catch {
    return `The checks could not run: ${(result.stderr || result.stdout).trim().slice(0, 4000)}`
  }
  const part = (name: string, entry?: { ok: boolean; output: string }): string => !entry ? `${name}: not run` : `${name}: ${entry.ok ? "passed" : "failed"}${entry.output ? `\n${entry.output.trim()}` : ""}`
  return [part("Type-check", parsed.typecheck), part("Accessibility scan (axe)", parsed.axe)].join("\n\n")
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
      if (!fs.existsSync(at.full)) return fail(`no file ${at.shown}`)
      if (fs.statSync(at.full).isDirectory()) return fail(`${at.shown} is a folder; use list_files`)
      const text = fs.readFileSync(at.full, "utf8")
      return { text: text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n[cut at ${READ_LIMIT} of ${text.length} characters]` : text, isError: false }
    }
    if (name === "write_file") {
      const at = resolveInProject(paths, slot, input.path, "write")
      if ("refused" in at) return fail(at.refused)
      if (typeof input.content !== "string") return fail("content must be a string")
      if (fs.existsSync(at.full) && fs.statSync(at.full).isDirectory()) return fail(`${at.shown} is a folder`)
      fs.mkdirSync(path.dirname(at.full), { recursive: true })
      fs.writeFileSync(at.full, input.content)
      return { text: `Wrote ${at.shown} (${Buffer.byteLength(input.content)} bytes).`, isError: false }
    }
    if (name === "list_files") {
      const at = resolveInProject(paths, slot, input.path ?? ".", "read")
      if ("refused" in at) return fail(at.refused)
      if (!fs.existsSync(at.full) || !fs.statSync(at.full).isDirectory()) return fail(`no folder ${at.shown}`)
      const entries = fs.readdirSync(at.full, { withFileTypes: true })
        .map((entry) => entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(path.join(at.full, entry.name)).isDirectory()) ? `${entry.name}/` : entry.name)
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
