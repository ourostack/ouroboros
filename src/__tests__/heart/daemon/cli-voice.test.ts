import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const join = vi.hoisted(() => ({
  runLocalAudioJoin: vi.fn(async () => ({ reason: "left", callSid: "local-audio-abc", durationMs: 12_000 })),
  runLocalAudioLeave: vi.fn(async () => "Left local audio session local-audio-abc."),
  runLocalAudioStatus: vi.fn(async () => "No local audio session is running."),
  defaultLocalAudioJoinDeps: vi.fn(() => ({ marker: "deps" })),
}))
vi.mock("../../../senses/voice/local-audio-join", () => join)

let fixtureDir: string
let inFile: string
let outFile: string
beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-voice-"))
  inFile = path.join(fixtureDir, "in.wav")
  outFile = path.join(fixtureDir, "out.wav")
  fs.writeFileSync(inFile, "RIFF")
})
afterAll(() => { fs.rmSync(fixtureDir, { recursive: true, force: true }) })

import { runOuroCli } from "../../../heart/daemon/cli-exec"
import { COMMAND_REGISTRY } from "../../../heart/daemon/cli-help"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

function makeDeps(): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn(async () => true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    listDiscoveredAgents: vi.fn(async () => ["slugger"]),
  }
}

describe("ouro voice parse", () => {
  it("parses a join with every stated fact", () => {
    expect(parseOuroCommand([
      "voice", "join", "--agent", "slugger", "--friend", "ari", "--participants", "Ari, Sam", "--occasion", "podcast prep",
      "--mode", "conversation", "--owner-alone", "--owner-name", "Ari", "--silent-consent", "everyone agreed",
      "--notify-session", "ari:cli:session", "--input-file", inFile, "--output-file", outFile,
      "--idle-silence-ms", "5000", "--max-duration-ms", "60000",
    ])).toEqual({
      kind: "voice.join",
      request: {
        agentName: "slugger", friendId: "ari", participants: "Ari, Sam", occasion: "podcast prep", mode: "conversation",
        ownerAlone: true, ownerName: "Ari", silentConsent: "everyone agreed", notify: { friendId: "ari", channel: "cli", key: "session" },
        files: { inputPath: inFile, outputPath: outFile }, idleSilenceMs: 5000, maxDurationMs: 60000,
      },
    })
  })

  it("parses a minimal join, leave and status", () => {
    expect(parseOuroCommand(["voice", "join", "--agent", "slugger"])).toEqual({ kind: "voice.join", request: { agentName: "slugger" } })
    expect(parseOuroCommand(["voice", "leave", "--agent", "slugger"])).toEqual({ kind: "voice.leave", agent: "slugger" })
    expect(parseOuroCommand(["voice", "status", "--agent", "slugger"])).toEqual({ kind: "voice.status", agent: "slugger" })
  })

  it("refuses bad input with a usage message", () => {
    const bad: string[][] = [
      ["voice"],
      ["voice", "dance", "--agent", "slugger"],
      ["voice", "join"],
      ["voice", "leave"],
      ["voice", "join", "--agent", "slugger", "--mode", "listen"],
      ["voice", "join", "--agent", "slugger", "--input-file", inFile],
      ["voice", "join", "--agent", "slugger", "--output-file", outFile],
      ["voice", "join", "--agent", "slugger", "--notify-session", "../x"],
      ["voice", "join", "--agent", "slugger", "--idle-silence-ms", "soon"],
      ["voice", "join", "--agent", "slugger", "--max-duration-ms", "0"],
      ["voice", "join", "--agent", "slugger", "--friend"],
      ["voice", "join", "--agent", "slugger", "--device", "Built-in Microphone"],
      ["voice", "leave", "--agent", "slugger", "extra"],
      ["voice", "leave", "--agent", "slugger", "--friend", "ari"],
      ["voice", "status", "--agent", "slugger", "--owner-alone"],
    ]
    for (const args of bad) expect(() => parseOuroCommand(args), args.join(" ")).toThrow(/ouro voice/)
  })
})

describe("ouro voice help", () => {
  it("is registered", () => {
    expect(COMMAND_REGISTRY.voice.usage).toContain("ouro voice join --agent <name>")
    expect(COMMAND_REGISTRY.voice.subcommands).toEqual(["join", "leave", "status"])
  })
})

describe("ouro voice execution", () => {
  beforeEach(() => vi.clearAllMocks())

  it("joins locally, without the daemon socket, and reports how it ended", async () => {
    const deps = makeDeps()
    const result = await runOuroCli(["voice", "join", "--agent", "slugger"], deps)
    expect(join.runLocalAudioJoin).toHaveBeenCalledWith({ agentName: "slugger" }, { marker: "deps" })
    expect(result).toContain("local-audio-abc")
    expect(result).toContain("left")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("leaves and reports status", async () => {
    const deps = makeDeps()
    expect(await runOuroCli(["voice", "leave", "--agent", "slugger"], deps)).toBe("Left local audio session local-audio-abc.")
    expect(join.runLocalAudioLeave).toHaveBeenCalledWith("slugger", { marker: "deps" })
    expect(await runOuroCli(["voice", "status", "--agent", "slugger"], deps)).toBe("No local audio session is running.")
    expect(join.runLocalAudioStatus).toHaveBeenCalledWith("slugger", { marker: "deps" })
  })
})

describe("ouro voice join --input-file / --output-file", () => {
  const join = (...flags: string[]) => () => parseOuroCommand(["voice", "join", "--agent", "slugger", ...flags])

  it("accepts a regular input file and an output file in an existing directory, resolving relative paths", () => {
    const previous = process.cwd()
    process.chdir(fixtureDir)
    try {
      expect(join("--input-file", "in.wav", "--output-file", "out.wav")()).toMatchObject({
        request: { files: { inputPath: path.resolve("in.wav"), outputPath: path.resolve("out.wav") } },
      })
    } finally {
      process.chdir(previous)
    }
  })

  it("accepts overwriting an existing regular output file", () => {
    fs.writeFileSync(outFile, "old")
    expect(join("--input-file", inFile, "--output-file", outFile)()).toMatchObject({ kind: "voice.join" })
    fs.rmSync(outFile)
  })

  it.each([
    ["a bare dash (sox standard input)", ["--input-file", "-", "--output-file", "OUT"], /regular file/i],
    ["a sox option such as -d (the default audio device)", ["--input-file", "-d", "--output-file", "OUT"], /regular file/i],
    ["an output of -d", ["--input-file", "IN", "--output-file", "-d"], /regular file/i],
    ["a device node as input", ["--input-file", "/dev/null", "--output-file", "OUT"], /regular file/i],
    ["a device node as output", ["--input-file", "IN", "--output-file", "/dev/null"], /regular file|device/i],
    ["a directory as input", ["--input-file", os.tmpdir(), "--output-file", "OUT"], /regular file/i],
    ["a missing input", ["--input-file", "/no/such/in.wav", "--output-file", "OUT"], /does not exist|regular file/i],
    ["an output in a missing directory", ["--input-file", "IN", "--output-file", "/no/such/dir/out.wav"], /directory/i],
    ["an output that is an existing directory", ["--input-file", "IN", "--output-file", os.tmpdir()], /regular file/i],
  ])("rejects %s", (_name, flags, message) => {
    const resolved = flags.map((flag) => flag === "IN" ? inFile : flag === "OUT" ? outFile : flag)
    expect(join(...resolved)).toThrow(message)
  })
})
