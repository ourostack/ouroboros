import { describe, expect, it, vi } from "vitest"
import {
  createNodeVoiceCommandRunner,
  inspectVoiceAudioRouting,
} from "../../../senses/voice/audio-routing"

describe("voice audio routing readiness", () => {
  it("marks the local BlackHole/Multi-Output shape ready when both devices are present", async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("-a")) {
        return { stdout: "MacBook Pro Speakers\nBlackHole 2ch\nMulti-Output Device\n" }
      }
      return { stdout: "BlackHole 2ch\n" }
    })

    const result = await inspectVoiceAudioRouting({ commandRunner: runner, switchAudioSourcePath: "/opt/SwitchAudioSource" })

    expect(runner).toHaveBeenCalledWith("/opt/SwitchAudioSource", ["-a"], { timeoutMs: 5_000 })
    expect(runner).toHaveBeenCalledWith("/opt/SwitchAudioSource", ["-c"], { timeoutMs: 5_000 })
    expect(result).toMatchObject({
      status: "ready",
      hasCaptureDevice: true,
      hasOutputDevice: true,
      currentOutput: "BlackHole 2ch",
      missing: [],
    })
  })

  it("returns setup guidance when required routing devices are missing", async () => {
    const result = await inspectVoiceAudioRouting({
      commandRunner: async () => ({ stdout: "MacBook Pro Speakers\n" }),
    })

    expect(result).toMatchObject({
      status: "needs_setup",
      hasCaptureDevice: false,
      hasOutputDevice: false,
      missing: ["BlackHole 2ch", "Multi-Output Device"],
    })
    expect(result.guidance.join("\n")).toContain("BlackHole 2ch")
    expect(result.guidance.join("\n")).toContain("Multi-Output Device")
  })

  it("handles blank command output and raw command runner failures", async () => {
    const blankOutput = await inspectVoiceAudioRouting({
      commandRunner: async () => ({}),
    })
    const rawFailure = await inspectVoiceAudioRouting({
      commandRunner: async () => {
        throw "raw routing failure"
      },
    })

    expect(blankOutput).toMatchObject({
      status: "needs_setup",
      currentOutput: null,
      missing: ["BlackHole 2ch", "Multi-Output Device"],
    })
    expect(rawFailure).toMatchObject({
      status: "unknown",
      error: "raw routing failure",
    })
  })

  it("reports command failures without pretending routing is ready", async () => {
    const result = await inspectVoiceAudioRouting({
      commandRunner: async () => ({ exitCode: 1, stderr: "SwitchAudioSource missing" }),
    })

    expect(result).toMatchObject({
      status: "unknown",
      missing: ["BlackHole 2ch", "Multi-Output Device"],
      error: "SwitchAudioSource missing",
    })
  })

  it("reports current-output command failures and stdout-only command failures", async () => {
    const currentFailure = await inspectVoiceAudioRouting({
      commandRunner: async (_command, args) => args.includes("-c")
        ? { exitCode: 2, stdout: "cannot read current output" }
        : { stdout: "BlackHole 2ch\nMulti-Output Device\n", exitCode: 0 },
    })
    expect(currentFailure).toMatchObject({
      status: "unknown",
      error: "cannot read current output",
    })

    const blankFailure = await inspectVoiceAudioRouting({
      commandRunner: async () => ({ exitCode: 7 }),
    })
    expect(blankFailure).toMatchObject({
      status: "unknown",
      error: "exit 7",
    })
  })

  it("provides a Node command runner for local routing probes", async () => {
    const runner = createNodeVoiceCommandRunner()

    const ok = await runner(process.execPath, ["-e", "process.stdout.write('routing-ok')"], { timeoutMs: 5_000 })
    const stderr = await runner(process.execPath, ["-e", "process.stderr.write('routing-err')"], { timeoutMs: 5_000 })
    await expect(runner(process.execPath, ["-e", "setTimeout(() => undefined, 50)"], { timeoutMs: 1 }))
      .rejects.toThrow("command timed out")
    await expect(runner("/definitely/not-a-real-ouro-command", [], { timeoutMs: 5_000 }))
      .rejects.toThrow()

    expect(ok).toMatchObject({ stdout: "routing-ok", stderr: "", exitCode: 0 })
    expect(stderr).toMatchObject({ stdout: "", stderr: "routing-err", exitCode: 0 })
  })
})
