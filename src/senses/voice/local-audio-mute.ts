import { execFile } from "child_process"
import { createHash, randomBytes } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Device-level mute is invisible to sox and to the sound settings of the call app: a muted
 * BlackHole device loops back pure silence, which looks exactly like a missing microphone
 * permission. CoreAudio exposes it as `kAudioDevicePropertyMute`; macOS ships no CLI for it, so
 * a tiny Swift script (interpreted by the Xcode command line tools' `swift`) reads it.
 */
export interface DeviceMuteState {
  device: string
  inputMuted: boolean | null
  outputMuted: boolean | null
}

/** Resolves to null when the mute state could not be read (no swift, script failure). */
export type MuteQuery = (devices: string[]) => Promise<DeviceMuteState[] | null>

export const MUTE_PROBE_SWIFT = `import CoreAudio
import Foundation

func deviceIds() -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
  return ids
}

func deviceName(_ id: AudioObjectID) -> String {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var name: Unmanaged<CFString>? = nil
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &name)
  return (name?.takeRetainedValue() as String?) ?? ""
}

func muteState(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> String {
  var result: Bool? = nil
  for element in [kAudioObjectPropertyElementMain, 1, 2] as [UInt32] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: scope, mElement: element)
    if !AudioObjectHasProperty(id, &addr) { continue }
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    if AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == 0 { result = (result ?? false) || value != 0 }
  }
  guard let muted = result else { return "n/a" }
  return muted ? "muted" : "unmuted"
}

let wanted = Set(CommandLine.arguments.dropFirst())
for id in deviceIds() {
  let name = deviceName(id)
  if wanted.contains(name) {
    print("\\(name)\\tinput=\\(muteState(id, scope: kAudioObjectPropertyScopeInput))\\toutput=\\(muteState(id, scope: kAudioObjectPropertyScopeOutput))")
  }
}
`

function scopeState(text: string): boolean | null {
  const value = text.split("=")[1]
  if (value === "muted") return true
  if (value === "unmuted") return false
  return null
}

export function parseMuteProbeOutput(text: string): DeviceMuteState[] {
  const states: DeviceMuteState[] = []
  for (const line of text.split("\n")) {
    const [device = "", input = "", output = ""] = line.split("\t")
    if (!device || !input.startsWith("input=") || !output.startsWith("output=")) continue
    states.push({ device, inputMuted: scopeState(input), outputMuted: scopeState(output) })
  }
  return states
}

/** Exact steps for each device that is muted at the device level. */
export function muteFixSteps(states: DeviceMuteState[]): string[] {
  const steps: string[] = []
  for (const state of states) {
    const scopes = [state.inputMuted ? "input" : "", state.outputMuted ? "output" : ""].filter(Boolean)
    if (scopes.length === 0) continue
    steps.push(
      `${state.device} is muted (${scopes.join(" and ")}), so it loops back pure silence. Unmute it: open Audio MIDI Setup, select ${state.device}, open the ${scopes.join(" and ")} tab${scopes.length > 1 ? "s" : ""}, and uncheck Mute on the Main channel.`,
    )
  }
  return steps
}

export interface SwiftMuteQueryOptions {
  /** A directory private to the agent (created 0700). The compiled probe lives here, never in a shared temp dir. */
  dir: string
  run?: (command: string, args: string[]) => Promise<string>
  swiftcPath?: string
  /** The user id that must own the directory and binary. Defaults to this process's user. */
  uid?: number
}

export function defaultRun(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 60_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function privateDirectory(dir: string, uid: number | undefined): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`mute probe directory ${dir} is not a directory owned by this user`)
  }
  if (stat.mode & 0o077) fs.chmodSync(dir, 0o700)
}

/** A regular file (not a link), owned by us, executable, and writable by nobody else. */
function trustedBinary(file: string, uid: number | undefined): boolean {
  try {
    const stat = fs.lstatSync(file)
    return stat.isFile() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0 && (stat.mode & 0o100) !== 0
  } catch {
    return false
  }
}

/**
 * Compiles the probe once with `swiftc` (a few seconds) into the agent's private directory and
 * caches the binary, so later joins read mute state in milliseconds. The binary's name carries a
 * hash of the script, the build writes only new exclusive files and renames the result into place,
 * and the owner and mode are checked again before every run. Partial builds are deleted.
 */
export function createSwiftMuteQuery(options: SwiftMuteQueryOptions): MuteQuery {
  const run = options.run ?? defaultRun
  const swiftcPath = options.swiftcPath ?? "swiftc"
  const uid = options.uid ?? process.getuid?.()
  const hash = createHash("sha256").update(MUTE_PROBE_SWIFT).digest("hex").slice(0, 16)
  const binaryPath = path.join(options.dir, `mute-probe-${hash}`)

  const build = async (): Promise<void> => {
    const token = `${process.pid}.${randomBytes(4).toString("hex")}`
    const script = path.join(options.dir, `${hash}.${token}.swift`)
    const output = path.join(options.dir, `${hash}.${token}.bin`)
    try {
      fs.writeFileSync(script, MUTE_PROBE_SWIFT, { flag: "wx", mode: 0o600 })
      await run(swiftcPath, ["-O", script, "-o", output])
      fs.chmodSync(output, 0o700)
      fs.renameSync(output, binaryPath)
    } finally {
      fs.rmSync(script, { force: true })
      fs.rmSync(output, { force: true })
    }
  }

  return async (devices) => {
    try {
      privateDirectory(options.dir, uid)
      if (!trustedBinary(binaryPath, uid)) {
        fs.rmSync(binaryPath, { force: true })
        await build()
      }
      const states = parseMuteProbeOutput(await run(binaryPath, devices))
      emitNervesEvent({
        component: "senses",
        event: "senses.voice_local_mute_checked",
        message: "local audio device mute state read",
        meta: { devices: devices.length, muted: states.filter((s) => s.inputMuted || s.outputMuted).length },
      })
      return states
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.voice_local_mute_check_unavailable",
        message: "local audio device mute state could not be read",
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
      return null
    }
  }
}
