import type { ToolDefinition, VoiceCallAudioRequest } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"

export const voiceToolDefinitions: ToolDefinition[] = [{
  tool: {
    type: "function",
    function: {
      name: "voice_end_call",
      description: [
        "request that the current live voice call end.",
        "Use this only in a voice session when the conversation is actually finished or the caller asked to hang up.",
        "After calling it, settle with a brief goodbye if you have not already spoken one; the transport will try to let already-sent speech finish before hanging up.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "short reason for ending the call, such as caller said goodbye",
          },
        },
      },
    },
  },
  handler: async (args, ctx) => {
    const reason = typeof args.reason === "string" && args.reason.trim().length > 0
      ? args.reason.trim()
      : undefined
    emitNervesEvent({
      component: "tools",
      event: "tool.voice_end_call_start",
      message: "voice end-call tool requested",
      meta: { hasActiveCall: String(Boolean(ctx?.voiceCall)), ...(reason ? { reasonLength: reason.length } : {}) },
    })

    if (!ctx?.voiceCall) {
      emitNervesEvent({
        component: "tools",
        event: "tool.voice_end_call_end",
        message: "voice end-call tool had no active call",
        meta: { hasActiveCall: "false" },
      })
      return "no active voice call to end"
    }

    await ctx.voiceCall.requestEnd(reason)
    emitNervesEvent({
      component: "tools",
      event: "tool.voice_end_call_end",
      message: "voice end-call request accepted",
      meta: { hasActiveCall: "true" },
    })
    return "(voice call ending)"
  },
}, {
  tool: {
    type: "function",
    function: {
      name: "voice_play_audio",
      description: [
        "play a short non-speech audio clip into the current live voice call.",
        "Use this when the caller asks to hear a tone, sample, clip, or other audio over the phone.",
        "For a simple test use source=tone. For clips, use source=url or source=file with a short audio asset; the transport may cap duration.",
        "Do not use it for your normal spoken response.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: ["tone", "url", "file"],
            description: "audio source type; defaults to tone",
          },
          url: {
            type: "string",
            description: "http(s) URL of a short audio clip when source=url",
          },
          path: {
            type: "string",
            description: "path to a short local audio clip when source=file",
          },
          label: {
            type: "string",
            description: "short human-readable label for the audio",
          },
          toneHz: {
            type: "number",
            description: "tone frequency in Hz when source=tone",
          },
          durationMs: {
            type: "number",
            description: "requested duration in milliseconds; short clips only",
          },
        },
      },
    },
  },
  handler: async (args, ctx) => {
    const source: NonNullable<VoiceCallAudioRequest["source"]> = args.source === "url" || args.source === "file" || args.source === "tone"
      ? args.source
      : "tone"
    const durationMs = typeof args.durationMs === "string" && args.durationMs.trim()
      ? Number(args.durationMs)
      : undefined
    const toneHz = typeof args.toneHz === "string" && args.toneHz.trim()
      ? Number(args.toneHz)
      : undefined
    const request: VoiceCallAudioRequest = {
      source,
      /* v8 ignore next -- sparse playback argument permutations are covered in the transport-level voice_play_audio tests @preserve */
      ...(typeof args.url === "string" ? { url: args.url } : {}),
      /* v8 ignore next -- sparse playback argument permutations are covered in the transport-level voice_play_audio tests @preserve */
      ...(typeof args.path === "string" ? { path: args.path } : {}),
      /* v8 ignore next -- sparse playback argument permutations are covered in the transport-level voice_play_audio tests @preserve */
      ...(typeof args.label === "string" ? { label: args.label } : {}),
      ...(Number.isFinite(toneHz) ? { toneHz } : {}),
      ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    }
    emitNervesEvent({
      component: "tools",
      event: "tool.voice_play_audio_start",
      message: "voice play-audio tool requested",
      meta: { hasActiveCallAudio: String(Boolean(ctx?.voiceCall?.playAudio)), source },
    })

    if (!ctx?.voiceCall?.playAudio) {
      emitNervesEvent({
        component: "tools",
        event: "tool.voice_play_audio_end",
        message: "voice play-audio tool had no active audio-capable call",
        meta: { hasActiveCallAudio: "false", source },
      })
      return "no active voice call audio path"
    }

    const result = await ctx.voiceCall.playAudio(request)
    emitNervesEvent({
      component: "tools",
      event: "tool.voice_play_audio_end",
      message: "voice play-audio request accepted",
      meta: { hasActiveCallAudio: "true", source, durationMs: String(result.durationMs) },
    })
    if (result.toolResult?.trim()) return result.toolResult.trim()
    return `(played audio: ${result.label}, ${Math.round(result.durationMs)}ms)`
  },
}]
