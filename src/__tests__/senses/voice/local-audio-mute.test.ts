import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkLocalAudioRouting } from "../../../senses/voice/local-audio-devices"
import {
  MUTE_PROBE_SWIFT,
  createSwiftMuteQuery,
  muteFixSteps,
  parseMuteProbeOutput,
} from "../../../senses/voice/local-audio-mute"

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-audio-mute-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe("parseMuteProbeOutput", () => {
  it("parses muted, unmuted and not-applicable scopes and ignores junk lines", () => {
    const states = parseMuteProbeOutput([
      "BlackHole 2ch\tinput=muted\toutput=muted",
      "BlackHole 16ch\tinput=unmuted\toutput=n/a",
      "garbage",
      "",
    ].join("\n"))
    expect(states).toEqual([
      { device: "BlackHole 2ch", inputMuted: true, outputMuted: true },
      { device: "BlackHole 16ch", inputMuted: false, outputMuted: null },
    ])
  })
})

describe("muteFixSteps", () => {
  it("names the muted device, the scope and exactly how to unmute", () => {
    const steps = muteFixSteps([
      { device: "BlackHole 2ch", inputMuted: true, outputMuted: true },
      { device: "BlackHole 16ch", inputMuted: false, outputMuted: true },
      { device: "Other", inputMuted: false, outputMuted: null },
    ])
    expect(steps).toHaveLength(2)
    expect(steps[0]).toContain("BlackHole 2ch is muted (input and output)")
    expect(steps[0]).toContain("Audio MIDI Setup")
    expect(steps[0]).toContain("uncheck Mute")
    expect(steps[1]).toContain("BlackHole 16ch is muted (output)")
    expect(muteFixSteps([{ device: "X", inputMuted: true, outputMuted: false }])[0]).toContain("X is muted (input)")
  })
})

describe("createSwiftMuteQuery", () => {
  const hash = createHash("sha256").update(MUTE_PROBE_SWIFT).digest("hex").slice(0, 16)

  /** A fake swiftc that writes a runnable-looking binary to the -o path. */
  function fakeRun(calls: Array<{ command: string; args: string[] }>, output = "BlackHole 2ch\tinput=muted\toutput=unmuted\n") {
    return async (command: string, args: string[]) => {
      calls.push({ command, args })
      if (command === "/usr/bin/swiftc") {
        fs.writeFileSync(args[args.indexOf("-o") + 1]!, "binary")
        return ""
      }
      return output
    }
  }

  it("builds under the given private directory (0700) with a content-hashed name, then runs the cached binary", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const probeDir = path.join(dir, "state", "probe")
    const query = createSwiftMuteQuery({ dir: probeDir, swiftcPath: "/usr/bin/swiftc", run: fakeRun(calls) })
    const states = await query(["BlackHole 2ch", "BlackHole 16ch"])
    expect(states).toEqual([{ device: "BlackHole 2ch", inputMuted: true, outputMuted: false }])
    const binaryPath = path.join(probeDir, `mute-probe-${hash}`)
    expect(fs.statSync(probeDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(binaryPath).mode & 0o777).toBe(0o700)
    expect(calls[1]).toEqual({ command: binaryPath, args: ["BlackHole 2ch", "BlackHole 16ch"] })
    expect(calls[0]!.command).toBe("/usr/bin/swiftc")
    expect(fs.readdirSync(probeDir)).toEqual([`mute-probe-${hash}`])
    await query(["BlackHole 2ch"])
    expect(calls).toHaveLength(3)
  })

  it("writes the script exclusively and removes it with any partial build when compilation fails", async () => {
    const probeDir = path.join(dir, "probe-fail")
    const query = createSwiftMuteQuery({
      dir: probeDir,
      run: async (command, args) => {
        fs.writeFileSync(args[args.indexOf("-o") + 1]!, "half a binary")
        throw new Error("swiftc exploded")
      },
    })
    expect(await query(["X"])).toBeNull()
    expect(fs.readdirSync(probeDir)).toEqual([])
  })

  it("never reuses a binary another user owns, a symlink, or one that others can write: it rebuilds a trusted one", async () => {
    const probeDir = path.join(dir, "probe-trust")
    fs.mkdirSync(probeDir, { recursive: true, mode: 0o700 })
    const binaryPath = path.join(probeDir, `mute-probe-${hash}`)
    const calls: Array<{ command: string; args: string[] }> = []
    const query = createSwiftMuteQuery({ dir: probeDir, swiftcPath: "/usr/bin/swiftc", run: fakeRun(calls) })

    fs.writeFileSync(binaryPath, "planted", { mode: 0o755 })
    fs.chmodSync(binaryPath, 0o777)
    await query(["X"])
    expect(calls.some((c) => c.command === "/usr/bin/swiftc")).toBe(true)
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("binary")
    expect(fs.statSync(binaryPath).mode & 0o777).toBe(0o700)

    calls.length = 0
    fs.rmSync(binaryPath)
    const target = path.join(dir, "elsewhere")
    fs.writeFileSync(target, "evil", { mode: 0o700 })
    fs.symlinkSync(target, binaryPath)
    await query(["X"])
    expect(calls.some((c) => c.command === "/usr/bin/swiftc")).toBe(true)
    expect(fs.lstatSync(binaryPath).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(target, "utf8")).toBe("evil")

    calls.length = 0
    const foreign = createSwiftMuteQuery({ dir: probeDir, swiftcPath: "/usr/bin/swiftc", run: fakeRun(calls), uid: process.getuid!() + 1 })
    expect(await foreign(["X"])).toBeNull()
    expect(calls).toEqual([])
  })

  it("tightens a probe directory that others could read or write before using it", async () => {
    const open = path.join(dir, "open")
    fs.mkdirSync(open, { mode: 0o755 })
    fs.chmodSync(open, 0o755)
    const calls: Array<{ command: string; args: string[] }> = []
    const query = createSwiftMuteQuery({ dir: open, swiftcPath: "/usr/bin/swiftc", run: fakeRun(calls) })
    // An existing directory with loose permissions is tightened to 0700, then used.
    expect(await query(["X"])).toEqual([{ device: "BlackHole 2ch", inputMuted: true, outputMuted: false }])
    expect(fs.statSync(open).mode & 0o777).toBe(0o700)
  })

  it("returns null when swiftc is missing or fails, so the join can fall back to the silence health check", async () => {
    const query = createSwiftMuteQuery({ dir: path.join(dir, "a"), run: async () => { throw new Error("no swift") } })
    expect(await query(["X"])).toBeNull()
    const blocked = path.join(dir, "file")
    fs.writeFileSync(blocked, "x")
    const unwritable = createSwiftMuteQuery({ dir: path.join(blocked, "sub"), run: async () => "" })
    expect(await unwritable(["X"])).toBeNull()
    const nonError = createSwiftMuteQuery({ dir: path.join(dir, "c"), run: async () => { throw "plain string" } })
    expect(await nonError(["X"])).toBeNull()
  })

  it("defaults to swiftc on PATH", async () => {
    const seen: string[] = []
    const query = createSwiftMuteQuery({ dir: path.join(dir, "d"), run: async (command, args) => { seen.push(command); if (command === "swiftc") fs.writeFileSync(args[args.indexOf("-o") + 1]!, "b"); return "" } })
    await query(["Z"])
    expect(seen[0]).toBe("swiftc")
  })

  it("the bundled swift script reads CoreAudio mute properties", () => {
    expect(MUTE_PROBE_SWIFT).toContain("kAudioDevicePropertyMute")
    expect(MUTE_PROBE_SWIFT).toContain("CommandLine.arguments")
  })
})

describe("checkLocalAudioRouting mute detection", () => {
  const ready = async () => ({ status: "ready" as const, hasCaptureDevice: true, hasOutputDevice: true, currentOutput: null, missing: [], guidance: [] })

  it("fails the routing check with exact unmute steps when a BlackHole device is muted", async () => {
    const result = await checkLocalAudioRouting(ready, async (devices) => {
      expect(devices).toEqual(["BlackHole 16ch", "BlackHole 2ch"])
      return [{ device: "BlackHole 2ch", inputMuted: true, outputMuted: true }]
    })
    expect(result.ok).toBe(false)
    expect(result.steps[0]).toContain("BlackHole 2ch is muted (input and output)")
  })

  it("stays ok when nothing is muted or the mute state cannot be read", async () => {
    expect((await checkLocalAudioRouting(ready, async () => [{ device: "BlackHole 2ch", inputMuted: false, outputMuted: null }])).ok).toBe(true)
    expect((await checkLocalAudioRouting(ready, async () => null)).ok).toBe(true)
    expect((await checkLocalAudioRouting(ready)).ok).toBe(true)
  })

  it("does not query mute for devices that are not installed", async () => {
    let queried = false
    const result = await checkLocalAudioRouting(
      async () => ({ status: "needs_setup" as const, hasCaptureDevice: false, hasOutputDevice: false, currentOutput: null, missing: ["BlackHole 16ch", "BlackHole 2ch"], guidance: [] }),
      async () => { queried = true; return [] },
    )
    expect(queried).toBe(false)
    expect(result.ok).toBe(false)
  })
})

describe("mute query details", () => {
  it("counts a device that is muted only on output", async () => {
    const query = createSwiftMuteQuery({ dir: path.join(dir, "out"), run: async (command, args) => { if (command === "swiftc") fs.writeFileSync(args[args.indexOf("-o") + 1]!, "b"); return "BlackHole 2ch\tinput=unmuted\toutput=muted\n" } })
    expect(await query(["BlackHole 2ch"])).toEqual([{ device: "BlackHole 2ch", inputMuted: false, outputMuted: true }])
  })

  it("runs a real process and reports its output, or its failure", async () => {
    const { defaultRun } = await import("../../../senses/voice/local-audio-mute")
    expect(await defaultRun(process.execPath, ["-e", "process.stdout.write('hello')"])).toBe("hello")
    await expect(defaultRun(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow()
  })
})
