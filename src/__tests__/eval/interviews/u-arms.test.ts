import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildUArm, checksText, execNode, KIT_SLOTS, makeProject, resolveInProject, U_ARMS, U_PATHS, U_TOOLS, READ_LIMIT, type Exec, type UPaths } from "../../../eval/interviews/guest/u/arms"
import { ARM_BUILDERS, runInterviewGuest } from "../../../eval/interviews/guest/run"
import type { ProviderRuntime } from "../../../heart/core"
import { createStreamChannel, serveProxyRuntime } from "../../../eval/transport/provider-proxy"
import { PassThrough } from "node:stream"

type Step = { content?: string; calls?: Array<{ name: string; arguments: string }> }

/** A model that answers each call with the next scripted step. */
function scripted(steps: Step[]): ProviderRuntime {
  const queue = [...steps]
  let n = 0
  return {
    id: "minimax", model: "m", client: null, capabilities: new Set(),
    streamTurn: async () => {
      n += 1
      const step = queue.shift() ?? { content: "done" }
      return { content: step.content ?? "", toolCalls: (step.calls ?? []).map((call, i) => ({ id: `c${n}-${i}`, ...call })), outputItems: [] }
    },
    appendToolOutput: () => undefined, resetTurnState: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
  } as unknown as ProviderRuntime
}

function wire(model: ProviderRuntime) {
  const hostToGuest = new PassThrough()
  const guestToHost = new PassThrough()
  serveProxyRuntime(createStreamChannel(guestToHost, hostToGuest), model, { take: () => true })
  return { stdin: hostToGuest, stdout: guestToHost }
}

let root: string
let paths: UPaths
const runs: Array<{ file: string; args: string[]; cwd: string }> = []
let answer: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "{}", stderr: "" }
const exec: Exec = async (file, args, options) => {
  runs.push({ file, args, cwd: options.cwd })
  return answer
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "u-arms-")))
  paths = { kits: path.join(root, "kits"), tools: path.join(root, "tools"), project: path.join(root, "home", "work") }
  for (const slot of Object.values(KIT_SLOTS)) {
    const template = path.join(paths.kits, slot)
    fs.mkdirSync(path.join(template, "src"), { recursive: true })
    fs.mkdirSync(path.join(template, "node_modules", "@kit", "ui"), { recursive: true })
    fs.writeFileSync(path.join(template, "package.json"), `{"name":"app-${slot}"}`)
    fs.writeFileSync(path.join(template, "node_modules", "@kit", "ui", "index.d.ts"), `export declare const kit: "${slot}"`)
  }
  fs.mkdirSync(paths.tools)
  fs.writeFileSync(path.join(root, "secret.txt"), "hidden")
  runs.length = 0
  answer = { code: 0, stdout: "{}", stderr: "" }
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const call = (arm: ReturnType<typeof buildUArm>, name: string, args: unknown) => arm.call(name, typeof args === "string" ? args : JSON.stringify(args))

describe("the U arms", () => {
  it("offers the same five tools in every arm, under neutral template names, and refuses an unknown arm", () => {
    expect(U_ARMS).toEqual(["ouro", "shadcn", "mui"])
    expect(U_TOOLS.map((tool) => tool.name)).toEqual(["read_file", "write_file", "list_files", "run_checks", "finish"])
    for (const arm of U_ARMS) expect(buildUArm(arm, { paths, exec }).tools).toBe(U_TOOLS)
    expect(Object.values(KIT_SLOTS).join(" ")).not.toMatch(/ouro|shadcn|mui/i)
    expect(() => buildUArm("codex", { paths, exec })).toThrow("no U arm codex")
    expect(U_PATHS).toEqual({ kits: "/opt/u-kits", tools: "/opt/u-tools", project: "/tmp/work" })
    expect(JSON.stringify(U_PATHS)).not.toMatch(/ouro/i)
    expect(typeof ARM_BUILDERS.U).toBe("function")
  })

  it("copies the arm's template into the project and links its node_modules, replacing an earlier project", async () => {
    fs.mkdirSync(path.join(paths.project, "old"), { recursive: true })
    const arm = buildUArm("shadcn", { paths, exec })
    expect(fs.existsSync(path.join(paths.project, "old"))).toBe(false)
    expect(fs.lstatSync(path.join(paths.project, "node_modules")).isSymbolicLink()).toBe(true)
    expect((await call(arm, "read_file", { path: "package.json" })).text).toBe(`{"name":"app-${KIT_SLOTS.shadcn}"}`)
    expect((await call(arm, "read_file", { path: "node_modules/@kit/ui/index.d.ts" })).text).toContain(KIT_SLOTS.shadcn)
    expect(() => makeProject("k9", paths)).toThrow("no project template k9")
  })

  it("reads, writes and lists inside the project only", async () => {
    const arm = buildUArm("ouro", { paths, exec })
    expect(await call(arm, "write_file", { path: "src/RemoveCopy.tsx", content: "export default 1" })).toEqual({ text: "Wrote src/RemoveCopy.tsx (16 bytes).", isError: false })
    expect(await call(arm, "write_file", { path: "src/deep/a.ts", content: "" })).toMatchObject({ isError: false })
    expect((await call(arm, "read_file", { path: "./src/RemoveCopy.tsx" })).text).toBe("export default 1")
    expect(await call(arm, "list_files", {})).toEqual({ text: "node_modules/\npackage.json\nsrc/", isError: false })
    expect(await call(arm, "list_files", { path: "src" })).toEqual({ text: "RemoveCopy.tsx\ndeep/", isError: false })
    expect(await call(arm, "list_files", { path: "node_modules/@kit" })).toEqual({ text: "ui/", isError: false })
    fs.mkdirSync(path.join(paths.project, "empty"))
    expect(await call(arm, "list_files", { path: "empty" })).toEqual({ text: "(empty)", isError: false })
    const refusals: Array<[string, unknown, string]> = [
      ["read_file", { path: "../../secret.txt" }, "../../secret.txt is outside the project folder"],
      ["read_file", { path: "/etc/passwd" }, "/etc/passwd is outside the project folder"],
      ["read_file", { path: "" }, "path must be a non-empty string, relative to the project folder"],
      ["read_file", { path: 3 }, "path must be a non-empty string, relative to the project folder"],
      ["read_file", { path: "missing.ts" }, "no file missing.ts"],
      ["read_file", { path: "src" }, "src is a folder; use list_files"],
      ["write_file", { path: "node_modules/@kit/ui/index.d.ts", content: "x" }, "nothing in node_modules can be written"],
      ["write_file", { path: "src/../node_modules/x", content: "x" }, "nothing in node_modules can be written"],
      ["write_file", { path: "src/node_modules/@kit/ui/index.d.ts", content: "x" }, "nothing in node_modules can be written"],
      ["read_file", { path: "src/RemoveCopy.tsx", offset: -1 }, "offset must be a whole number, 0 or more"],
      ["read_file", { path: "src/RemoveCopy.tsx", offset: "2" }, "offset must be a whole number, 0 or more"],
      ["read_file", { path: "src/RemoveCopy.tsx", offset: 1.5 }, "offset must be a whole number, 0 or more"],
      ["write_file", { path: "../escape.ts", content: "x" }, "../escape.ts is outside the project folder"],
      ["write_file", { path: "src/a.ts" }, "content must be a string"],
      ["write_file", { path: "src", content: "x" }, "src is a folder"],
      ["list_files", { path: "nowhere" }, "no folder nowhere"],
      ["list_files", { path: "package.json" }, "no folder package.json"],
      ["list_files", { path: ".." }, ".. is outside the project folder"],
      ["read_file", "[1]", "arguments must be a JSON object"],
      ["read_file", "{bad", "arguments must be a JSON object"],
      ["shell", {}, "no tool shell"],
    ]
    for (const [name, args, text] of refusals) expect(await call(arm, name, args)).toEqual({ text, isError: true })
    expect(fs.existsSync(path.join(root, "home", "escape.ts"))).toBe(false)
  })

  it("refuses a read or a write that a link carries outside the project, and never writes a link", async () => {
    const arm = buildUArm("mui", { paths, exec })
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(paths.project, "src", "link.txt"))
    fs.symlinkSync(root, path.join(paths.project, "src", "out"))
    fs.symlinkSync(path.join(root, "nowhere"), path.join(paths.project, "src", "broken"))
    fs.symlinkSync(path.join(root, "nowhere-dir"), path.join(paths.project, "src", "gone"))
    fs.symlinkSync(path.join(paths.project, "src"), path.join(paths.project, "lib"))
    expect(await call(arm, "read_file", { path: "src/link.txt" })).toEqual({ text: "src/link.txt is outside the project folder", isError: true })
    expect(await call(arm, "write_file", { path: "src/link.txt", content: "x" })).toEqual({ text: "src/link.txt is a link, which can't be written", isError: true })
    expect(await call(arm, "write_file", { path: "src/broken", content: "x" })).toEqual({ text: "src/broken is a link, which can't be written", isError: true })
    expect(await call(arm, "write_file", { path: "src/out/planted.txt", content: "x" })).toEqual({ text: "src/out/planted.txt is outside the project folder", isError: true })
    expect(await call(arm, "write_file", { path: "src/gone/planted.txt", content: "x" })).toEqual({ text: "src/gone/planted.txt is outside the project folder", isError: true })
    expect(fs.existsSync(path.join(root, "planted.txt"))).toBe(false)
    expect(fs.existsSync(path.join(root, "nowhere"))).toBe(false)
    expect(await call(arm, "write_file", { path: "lib/inside.ts", content: "x" })).toEqual({ text: "Wrote lib/inside.ts (1 bytes).", isError: false })
    expect(fs.readFileSync(path.join(paths.project, "src", "inside.ts"), "utf8")).toBe("x")
    expect(await call(arm, "list_files", { path: "src" })).toEqual({ text: "broken\ngone\ninside.ts\nlink.txt\nout/", isError: false })
    expect(await call(arm, "write_file", { path: "..foo", content: "x" })).toEqual({ text: "Wrote ..foo (1 bytes).", isError: false })
    expect(resolveInProject(paths, KIT_SLOTS.mui, ".", "read")).toEqual({ full: paths.project, shown: "." })
  })

  it("reads a long file in parts, saying where to read on", async () => {
    const arm = buildUArm("ouro", { paths, exec })
    const text = `${"a".repeat(READ_LIMIT)}${"b".repeat(5)}`
    fs.writeFileSync(path.join(paths.project, "src", "long.txt"), text)
    expect((await call(arm, "read_file", { path: "src/long.txt" })).text).toBe(`${"a".repeat(READ_LIMIT)}\n[characters 0 to ${READ_LIMIT} of ${READ_LIMIT + 5}; read on with offset ${READ_LIMIT}]`)
    expect(await call(arm, "read_file", { path: "src/long.txt", offset: READ_LIMIT })).toEqual({ text: "bbbbb", isError: false })
    expect(await call(arm, "read_file", { path: "src/long.txt", offset: READ_LIMIT + 10 })).toEqual({ text: "", isError: false })
  })

  it("runs the checks from the tools folder on the project and gives their result as text", async () => {
    const arm = buildUArm("ouro", { paths, exec })
    answer = { code: 1, stdout: JSON.stringify({ typecheck: { ok: false, output: "src/RemoveCopy.tsx(1,1): error TS2307" }, axe: { ok: true, output: "" } }), stderr: "" }
    expect(await call(arm, "run_checks", {})).toEqual({ text: "Type-check: failed\nsrc/RemoveCopy.tsx(1,1): error TS2307\n\nAccessibility scan (axe): passed", isError: false })
    expect(runs[0]).toEqual({ file: process.execPath, args: [path.join(paths.tools, "check.mjs"), paths.project], cwd: paths.tools })
    expect(checksText({ code: 0, stdout: JSON.stringify({ typecheck: { ok: true, output: "" } }), stderr: "" })).toBe("Type-check: passed\n\nAccessibility scan (axe): not run")
    expect(checksText({ code: 1, stdout: "", stderr: " boom " })).toBe("The checks could not run: boom")
    expect(checksText({ code: 1, stdout: "not json", stderr: "" })).toBe("The checks could not run: not json")
    expect(checksText({ code: 1, stdout: JSON.stringify({ typecheck: { ok: "yes", output: 3 }, axe: { ok: true, output: null } }), stderr: "" })).toBe("Type-check: failed\n\nAccessibility scan (axe): passed")
  })

  it("ends the job at finish with its summary, and refuses a finish without one", async () => {
    const arm = buildUArm("ouro", { paths, exec })
    expect(await call(arm, "finish", { summary: "Built it." })).toEqual({ text: "Built it.", isError: false, ends: true })
    expect(await call(arm, "finish", { summary: " " })).toEqual({ text: "summary must be a non-empty string", isError: true })
    expect(arm.operationOf("finish", "{}")).toBeNull()
  })

  it("grades with the tools folder's grader, and reports a grader that gave no result", async () => {
    const arm = buildUArm("ouro", { paths, exec })
    answer = { code: 0, stdout: JSON.stringify({ typecheck: { ok: true } }), stderr: "" }
    expect(await arm.grade!()).toEqual({ typecheck: { ok: true } })
    expect(runs.at(-1)!.args[0]).toBe(path.join(paths.tools, "grade.mjs"))
    answer = { code: 137, stdout: "", stderr: "Killed" }
    expect(await arm.grade!()).toEqual({ error: "the grader gave no result (exit 137): Killed" })
    answer = { code: 1, stdout: "half", stderr: "" }
    expect(await arm.grade!()).toEqual({ error: "the grader gave no result (exit 1): half" })
  })

  it("runs a real command with the default runner", async () => {
    fs.writeFileSync(path.join(paths.tools, "check.mjs"), "process.stdout.write(JSON.stringify({ typecheck: { ok: true, output: '' }, axe: { ok: false, output: process.argv[2] } }))")
    fs.writeFileSync(path.join(paths.tools, "grade.mjs"), "process.stderr.write('no'); process.exit(3)")
    const arm = buildUArm("ouro", { paths })
    expect((await call(arm, "run_checks", {})).text).toBe(`Type-check: passed\n\nAccessibility scan (axe): failed\n${paths.project}`)
    expect(await arm.grade!()).toEqual({ error: "the grader gave no result (exit 3): no" })
    fs.writeFileSync(path.join(paths.tools, "grade.mjs"), "process.exit(4)")
    expect(await arm.grade!()).toMatchObject({ error: expect.stringMatching(/^the grader gave no result \(exit 4\): Command failed/) })
    const missing = await execNode(path.join(root, "no-such-program"), [], { cwd: root, timeoutMs: 5000 })
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/ENOENT/)
  })

  it("looks for the image's own folders when no paths are given", () => {
    expect(() => buildUArm("ouro")).toThrow("no project template k1 in the image")
    expect(() => ARM_BUILDERS.U!("mui", { bundle: root })).toThrow("no project template k3 in the image")
  })

  it("runs a job through the guest: finish ends the job turn, the debrief follows, then the grade comes back", async () => {
    const turnFile = path.join(root, "turn.json")
    fs.writeFileSync(turnFile, JSON.stringify({ product: "U", arm: "shadcn", labelLine: "The component kit for this job is component kit F.", prefix: [], userText: "Build it.", followUps: ["How did it go?"] }))
    const model = scripted([
      { calls: [{ name: "write_file", arguments: JSON.stringify({ path: "src/RemoveCopy.tsx", content: "export default function RemoveCopy() { return null }" }) }] },
      { calls: [{ name: "run_checks", arguments: "{}" }, { name: "finish", arguments: JSON.stringify({ summary: "Built the screen." }) }] },
      { content: "5\nThe kit was fine." },
    ])
    const { stdin, stdout } = wire(model)
    answer = { code: 0, stdout: JSON.stringify({ typecheck: { ok: true, output: "" }, axe: { ok: true, output: "" } }), stderr: "" }
    const outcome = await runInterviewGuest({ stdin, stdout, turnFile, bundle: root, builders: { U: (arm) => buildUArm(arm, { paths, exec }) } })
    expect(outcome).toMatchObject({
      ok: true,
      result: { finalReply: "Built the screen.", turns: [{ start: 0, finalReply: "Built the screen.", outcome: "settled", calls: 2 }, { finalReply: "5\nThe kit was fine.", calls: 1 }], grade: { typecheck: { ok: true, output: "" } } },
    })
    expect(runs.map((entry) => path.basename(entry.args[0]!))).toEqual(["check.mjs", "grade.mjs"])
    expect(fs.readFileSync(path.join(paths.project, "src", "RemoveCopy.tsx"), "utf8")).toContain("RemoveCopy")
  })

  it("reads empty arguments as none", async () => {
    const arm = buildUArm("ouro", { paths, exec })
    expect(await arm.call("list_files", "")).toEqual({ text: "node_modules/\npackage.json\nsrc/", isError: false })
  })
})
