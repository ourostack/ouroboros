import { spawn } from "child_process"
import { emitNervesEvent } from "../../nerves/runtime"

export type VoiceAudioRoutingStatus = "ready" | "needs_setup" | "unknown"

export interface VoiceCommandResult {
  stdout?: string
  stderr?: string
  exitCode?: number
}

export type VoiceCommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<VoiceCommandResult>

export interface VoiceAudioRoutingInspection {
  status: VoiceAudioRoutingStatus
  hasCaptureDevice: boolean
  hasOutputDevice: boolean
  currentOutput: string | null
  missing: string[]
  guidance: string[]
  error?: string
}

export interface VoiceAudioRoutingOptions {
  commandRunner?: VoiceCommandRunner
  switchAudioSourcePath?: string
  captureDeviceName?: string
  outputDeviceName?: string
  timeoutMs?: number
}

export function createNodeVoiceCommandRunner(): VoiceCommandRunner {
  return (command, args, options) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error(`command timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (exitCode) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? 0,
      })
    })
  })
}

function parseDeviceLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function commandFailureMessage(exitCode: number, result: VoiceCommandResult): string {
  const stderr = result.stderr?.trim()
  if (stderr) return stderr
  const stdout = result.stdout?.trim()
  if (stdout) return stdout
  return `exit ${exitCode}`
}

function setupGuidance(missing: string[], currentOutput: string | null, outputDeviceName: string): string[] {
  const guidance = missing.map((device) => `Install or configure the local audio device: ${device}.`)
  if (currentOutput && currentOutput !== outputDeviceName) {
    guidance.push(`Browser meeting audio should be routed through ${outputDeviceName}; current output is ${currentOutput}.`)
  }
  return guidance
}

export async function inspectVoiceAudioRouting(options: VoiceAudioRoutingOptions = {}): Promise<VoiceAudioRoutingInspection> {
  const commandRunner = options.commandRunner ?? createNodeVoiceCommandRunner()
  const switchAudioSourcePath = options.switchAudioSourcePath ?? "SwitchAudioSource"
  const captureDeviceName = options.captureDeviceName ?? "BlackHole 2ch"
  const outputDeviceName = options.outputDeviceName ?? "Multi-Output Device"
  const timeoutMs = options.timeoutMs ?? 5_000

  try {
    const devicesResult = await commandRunner(switchAudioSourcePath, ["-a"], { timeoutMs })
    if (typeof devicesResult.exitCode === "number" && devicesResult.exitCode !== 0) {
      throw new Error(commandFailureMessage(devicesResult.exitCode, devicesResult))
    }
    const currentResult = await commandRunner(switchAudioSourcePath, ["-c"], { timeoutMs })
    if (typeof currentResult.exitCode === "number" && currentResult.exitCode !== 0) {
      throw new Error(commandFailureMessage(currentResult.exitCode, currentResult))
    }

    const devices = parseDeviceLines(devicesResult.stdout ?? "")
    const currentOutput = parseDeviceLines(currentResult.stdout ?? "")[0] ?? null
    const hasCaptureDevice = devices.includes(captureDeviceName)
    const hasOutputDevice = devices.includes(outputDeviceName)
    const missing = [
      ...(hasCaptureDevice ? [] : [captureDeviceName]),
      ...(hasOutputDevice ? [] : [outputDeviceName]),
    ]
    const result: VoiceAudioRoutingInspection = {
      status: missing.length === 0 ? "ready" : "needs_setup",
      hasCaptureDevice,
      hasOutputDevice,
      currentOutput,
      missing,
      guidance: setupGuidance(missing, currentOutput, outputDeviceName),
    }

    emitNervesEvent({
      component: "senses",
      event: "senses.voice_audio_routing_checked",
      message: "voice audio routing readiness checked",
      meta: {
        status: result.status,
        hasCaptureDevice,
        hasOutputDevice,
        currentOutput,
        missing,
      },
    })

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result: VoiceAudioRoutingInspection = {
      status: "unknown",
      hasCaptureDevice: false,
      hasOutputDevice: false,
      currentOutput: null,
      missing: [captureDeviceName, outputDeviceName],
      guidance: setupGuidance([captureDeviceName, outputDeviceName], null, outputDeviceName),
      error: message,
    }

    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_audio_routing_error",
      message: "voice audio routing readiness check failed",
      meta: { error: message, missing: result.missing },
    })

    return result
  }
}
