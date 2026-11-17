import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  resolveShepherd, SHEPHERD_BIN_ENV, SHEPHERD_INSTALL, shepherd, ShepherdFailure, ShepherdUnavailableError,
} from "../../../senses/app-sessions/shepherd-cli"

const FAKE = fileURLToPath(new URL("./fake-shepherd.mjs", import.meta.url))

let root: string
let dir: string
let fake: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-cli-"))
  dir = path.join(root, "bin")
  fs.mkdirSync(dir)
  fake = path.join(dir, "shepherd.mjs")
  fs.copyFileSync(FAKE, fake)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const replies = (map: Record<string, unknown>): void => fs.writeFileSync(path.join(dir, "reply.json"), JSON.stringify(map))
const calls = (): Array<{ argv: string[]; input?: unknown }> =>
  fs.existsSync(path.join(dir, "calls.jsonl")) ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)) : []
const env = (value: string = fake): NodeJS.ProcessEnv => ({ [SHEPHERD_BIN_ENV]: value })

describe("finding Shepherd", () => {
  it("runs SHEPHERD_BIN through Node when it is a script, and as itself when it is an executable", () => {
    expect(resolveShepherd(env())).toEqual({ file: process.execPath, prefix: [fake] })
    const tool = path.join(root, "tool")
    fs.writeFileSync(tool, "#!/bin/sh\n")
    fs.chmodSync(tool, 0o755)
    expect(resolveShepherd(env(tool))).toEqual({ file: tool, prefix: [] })
  })

  it("names a SHEPHERD_BIN that does not exist, with how to install Shepherd", () => {
    expect(() => resolveShepherd(env(path.join(root, "missing")))).toThrow(ShepherdUnavailableError)
    expect(() => resolveShepherd(env(path.join(root, "missing")))).toThrow(`does not exist. Fix: install Shepherd with ${SHEPHERD_INSTALL}`)
  })

  it("finds shepherd on PATH, skipping entries that are not an executable file, before Housesitter's copy", () => {
    const early = path.join(root, "early")
    const late = path.join(root, "late")
    fs.mkdirSync(path.join(early, "shepherd"), { recursive: true })
    fs.mkdirSync(late)
    fs.writeFileSync(path.join(late, "shepherd"), "#!/bin/sh\n")
    fs.chmodSync(path.join(late, "shepherd"), 0o755)
    const bundled = path.join(root, "home", "Library", "Application Support", "housesitter", "releases", "shepherd", "current", "bin", "shepherd.mjs")
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, "")
    expect(resolveShepherd({ PATH: ["", early, late].join(path.delimiter) }, path.join(root, "home"))).toEqual({ file: path.join(late, "shepherd"), prefix: [] })
  })

  it("falls back to Housesitter's bundled Shepherd, run through Node, and is null when none is installed", () => {
    const home = path.join(root, "home")
    const bundled = path.join(home, "Library", "Application Support", "housesitter", "releases", "shepherd", "current", "bin", "shepherd.mjs")
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, "")
    expect(resolveShepherd({ PATH: "" }, home)).toEqual({ file: process.execPath, prefix: [bundled] })
    expect(resolveShepherd({ PATH: "" }, root)).toBeNull()
  })
})

describe("running a verb", () => {
  it("runs the verb with --json, sends the input on stdin, and returns the JSON result", async () => {
    replies({ send: { body: { ok: true, status: "accepted", session_id: "s1" } } })
    expect(await shepherd(["send", "s1"], { message: "hi" }, { env: env() })).toEqual({ ok: true, status: "accepted", session_id: "s1" })
    expect(calls()).toEqual([{ argv: ["send", "s1", "--json", "--input", "-"], input: { message: "hi" } }])
  })

  it("runs a verb with no input without --input", async () => {
    replies({ sessions: { body: { summary: { total: 0 }, sessions: [] } } })
    expect(await shepherd(["sessions", "--state", "busy"], undefined, { env: env() })).toEqual({ summary: { total: 0 }, sessions: [] })
    expect(calls()).toEqual([{ argv: ["sessions", "--state", "busy", "--json"] }])
  })

  it("turns a failed verb into its code, problem and fix", async () => {
    const error = "no session 'x' in the Copilot app. Fix: list the sessions with shepherd sessions."
    replies({ session: { code: 1, body: { ok: false, code: "no-session", error } } })
    await expect(shepherd(["session", "x"], undefined, { env: env() })).rejects.toBeInstanceOf(ShepherdFailure)
    await expect(shepherd(["session", "x"], undefined, { env: env() })).rejects.toMatchObject({ code: "no-session", message: error })
  })

  it("names the exit code and stderr when a failure has no JSON, and only the exit code when it has no output", async () => {
    replies({ sessions: { code: 2, stderr: "usage\n", body: "not json" } })
    await expect(shepherd(["sessions"], undefined, { env: env() })).rejects.toMatchObject({ code: "exit-2", message: "shepherd sessions failed (exit 2): usage" })
    replies({ sessions: { code: 3, body: "not json" } })
    await expect(shepherd(["sessions"], undefined, { env: env() })).rejects.toMatchObject({ code: "exit-3", message: "shepherd sessions failed (exit 3)" })
    replies({ sessions: { code: 4 } })
    await expect(shepherd(["sessions"], undefined, { env: env() })).rejects.toMatchObject({ code: "exit-4", message: "shepherd sessions failed (exit 4)" })
  })

  it("treats ok: false as a failure even at exit 0", async () => {
    replies({ answer: { body: { ok: false, code: "not-waiting", error: "not waiting. Fix: answer it in the app." } } })
    await expect(shepherd(["answer", "s1"], { answer: "y" }, { env: env() })).rejects.toMatchObject({ code: "not-waiting" })
  })

  it("says when a verb printed no JSON, or JSON that is not an object", async () => {
    replies({ sessions: { body: "hello" } })
    await expect(shepherd(["sessions"], undefined, { env: env() })).rejects.toMatchObject({ code: "no-json" })
    replies({ sessions: { body: [1] } })
    await expect(shepherd(["sessions"], undefined, { env: env() })).rejects.toMatchObject({ code: "no-json" })
  })

  it("reports a verb that exits without reading its input, and that prints nothing, as having no JSON", async () => {
    const quitter = path.join(root, "quitter")
    fs.writeFileSync(quitter, "#!/bin/sh\nexit 0\n")
    fs.chmodSync(quitter, 0o755)
    await expect(shepherd(["answer", "s1"], { answer: "x".repeat(2 * 1024 * 1024) }, { env: env(quitter) })).rejects.toMatchObject({ code: "no-json" })
  })

  it("gives up on a verb that does not answer in time", async () => {
    replies({ sessions: { delayMs: 2000 } })
    await expect(shepherd(["sessions"], undefined, { env: env(), timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("did not answer") })
  })

  it("says Shepherd could not be started when its file cannot run", async () => {
    const notes = path.join(root, "notes.txt")
    fs.writeFileSync(notes, "not a program")
    await expect(shepherd(["sessions"], undefined, { env: env(notes) })).rejects.toMatchObject({ name: "ShepherdUnavailableError", message: expect.stringContaining("could not start shepherd") })
  })

  it("says Shepherd is not installed when none is found", async () => {
    await expect(shepherd(["sessions"], undefined, { env: {}, home: root })).rejects.toThrow(`Shepherd is not installed`)
  })
})
