import { describe, expect, it, vi } from "vitest"
import { getChannelCapabilities } from "../../mind/friends/channel"
import { execTool, getToolsForChannel } from "../../repertoire/tools"

describe("voice lifecycle tools", () => {
  it("exposes voice call controls only on the voice channel", () => {
    const voiceToolNames = getToolsForChannel(getChannelCapabilities("voice"))
      .map((tool) => tool.function.name)
    const cliToolNames = getToolsForChannel(getChannelCapabilities("cli"))
      .map((tool) => tool.function.name)

    expect(voiceToolNames).toContain("voice_end_call")
    expect(voiceToolNames).toContain("voice_play_audio")
    expect(cliToolNames).not.toContain("voice_end_call")
    expect(cliToolNames).not.toContain("voice_play_audio")
  })

  it("requests active voice call termination through ToolContext", async () => {
    const requestEnd = vi.fn(async (_reason?: string) => undefined)

    const result = await execTool("voice_end_call", { reason: "caller said goodbye" }, {
      signin: async () => undefined,
      voiceCall: { requestEnd },
    })

    expect(requestEnd).toHaveBeenCalledWith("caller said goodbye")
    expect(result).toBe("(voice call ending)")
  })

  it("reports missing voice call control without throwing", async () => {
    const result = await execTool("voice_end_call", {}, {
      signin: async () => undefined,
    })

    expect(result).toBe("no active voice call to end")
  })

  it("requests active voice call audio playback through ToolContext", async () => {
    const playAudio = vi.fn(async () => ({ label: "latency beep", durationMs: 700 }))

    const result = await execTool("voice_play_audio", {
      source: "tone",
      label: "latency beep",
      toneHz: "880",
      durationMs: "700",
    }, {
      signin: async () => undefined,
      voiceCall: { requestEnd: vi.fn(), playAudio },
    })

    expect(playAudio).toHaveBeenCalledWith({
      source: "tone",
      label: "latency beep",
      toneHz: 880,
      durationMs: 700,
    })
    expect(result).toBe("(played audio: latency beep, 700ms)")
  })

  it("allows transports to provide custom playback tool output", async () => {
    const playAudio = vi.fn(async () => ({
      label: "SIP tone cue",
      durationMs: 500,
      toolResult: "Render the SIP tone cue now.",
    }))

    const result = await execTool("voice_play_audio", {
      source: "tone",
      label: "SIP tone cue",
    }, {
      signin: async () => undefined,
      voiceCall: { requestEnd: vi.fn(), playAudio },
    })

    expect(playAudio).toHaveBeenCalled()
    expect(result).toBe("Render the SIP tone cue now.")
  })

  it("reports missing voice audio path without throwing", async () => {
    const result = await execTool("voice_play_audio", {}, {
      signin: async () => undefined,
    })

    expect(result).toBe("no active voice call audio path")
  })
})
