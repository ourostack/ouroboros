import type { Server } from "http"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import {
  agentScopedTwilioPhoneBasePath,
  closeTwilioPhoneBridgeServer,
  placeConfiguredTwilioPhoneCall,
  resolveTwilioPhoneTransportRuntime,
  startConfiguredTwilioPhoneTransport,
  type TwilioPhoneOutboundCallRuntimeDeps,
  type TwilioPhoneTransportRuntimeDeps,
} from "../../../senses/voice"
import type { VoiceTtsService, VoiceTranscriber } from "../../../senses/voice"

function runtimeReadResult(config: Record<string, unknown>) {
  return {
    ok: true as const,
    itemPath: "runtime/config",
    config,
    revision: "rev_123",
    updatedAt: "2026-05-07T08:00:00.000Z",
  }
}

function fakeDeps(runtimeConfig: Record<string, unknown>, machineConfig: Record<string, unknown>): TwilioPhoneTransportRuntimeDeps {
  const transcriber: VoiceTranscriber = {
    transcribe: vi.fn(),
  }
  const tts: VoiceTtsService = {
    synthesize: vi.fn(),
  }
  return {
    waitForRuntimeCredentialBootstrap: vi.fn(async () => undefined),
    loadMachineIdentity: vi.fn(() => ({
      schemaVersion: 1,
      machineId: "machine_voice",
      createdAt: "2026-05-07T08:00:00.000Z",
      updatedAt: "2026-05-07T08:00:00.000Z",
      hostnameAliases: [],
    })),
    refreshRuntimeConfig: vi.fn(async () => runtimeReadResult(runtimeConfig)),
    refreshMachineRuntimeConfig: vi.fn(async () => runtimeReadResult(machineConfig)),
    readRuntimeConfig: vi.fn(() => runtimeReadResult(runtimeConfig)),
    readMachineRuntimeConfig: vi.fn(() => runtimeReadResult(machineConfig)),
    cacheSelectedProviderCredentials: vi.fn(async () => undefined),
    createTranscriber: vi.fn(() => transcriber),
    createTts: vi.fn(() => tts),
    startBridgeServer: vi.fn(async () => ({
      bridge: { handle: vi.fn() },
      server: { close: vi.fn() } as unknown as Server,
      localUrl: "http://127.0.0.1:2222",
    })),
  }
}

function fakeOutboundDeps(runtimeConfig: Record<string, unknown>, machineConfig: Record<string, unknown>): TwilioPhoneOutboundCallRuntimeDeps {
  const tts: VoiceTtsService = {
    synthesize: vi.fn(),
  }
  return {
    waitForRuntimeCredentialBootstrap: vi.fn(async () => undefined),
    loadMachineIdentity: vi.fn(() => ({
      schemaVersion: 1,
      machineId: "machine_voice",
      createdAt: "2026-05-07T08:00:00.000Z",
      updatedAt: "2026-05-07T08:00:00.000Z",
      hostnameAliases: [],
    })),
    refreshRuntimeConfig: vi.fn(async () => runtimeReadResult(runtimeConfig)),
    refreshMachineRuntimeConfig: vi.fn(async () => runtimeReadResult(machineConfig)),
    readRuntimeConfig: vi.fn(() => runtimeReadResult(runtimeConfig)),
    readMachineRuntimeConfig: vi.fn(() => runtimeReadResult(machineConfig)),
    createTts: vi.fn(() => tts),
    runVoiceLoopbackTurn: vi.fn(async () => ({
      responseText: "hey Ari, it is Slugger",
      ponderDeferred: false,
      tts: {
        status: "delivered",
        audio: Buffer.from("ulaw-ready"),
        byteLength: Buffer.byteLength("ulaw-ready"),
        chunkCount: 1,
        mimeType: "audio/x-mulaw;rate=8000",
        modelId: "eleven_flash_v2_5",
        voiceId: "voice_123",
      },
      speechSegments: [],
      speechDeliveryErrors: [],
    })),
    writeVoicePlaybackArtifact: vi.fn(async (request) => {
      const audioPath = path.join(request.outputDir, `${request.utteranceId}.audio`)
      await fs.mkdir(request.outputDir, { recursive: true })
      await fs.writeFile(audioPath, request.delivery.audio)
      return {
        status: "written",
        audioPath,
        byteLength: request.delivery.byteLength,
        mimeType: request.delivery.mimeType,
        playbackAttempted: false,
      }
    }),
    createOutboundCall: vi.fn(async () => ({ callSid: "CAOUT", status: "queued" })),
  }
}

describe("Twilio phone transport runtime", () => {
  const configuredRuntime = {
    integrations: {
      elevenLabsApiKey: "eleven-secret",
      elevenLabsVoiceId: "voice_123",
    },
    voice: {
      twilioAccountSid: "AC123",
      twilioAuthToken: "twilio-secret",
      twilioFromNumber: "+15557654321",
    },
  }
  const configuredMachine = {
    voice: {
      twilioPublicUrl: "https://voice.example.test",
      twilioBasePath: "/voice/agents/slugger/twilio",
      twilioPort: "2222",
      twilioDefaultFriendId: "ari",
      twilioRecordTimeoutSeconds: "3",
      twilioGreetingPrebufferMs: "4200",
      twilioTransportMode: "media-stream",
      whisperCliPath: "/opt/whisper.cpp/main",
      whisperModelPath: "/models/ggml-base.en.bin",
    },
  }

  it("uses agent-scoped Twilio routes for managed voice transports", () => {
    expect(agentScopedTwilioPhoneBasePath("Slugger")).toBe("/voice/agents/slugger/twilio")
    expect(agentScopedTwilioPhoneBasePath("Ari Test.Agent")).toBe("/voice/agents/ari-test.agent/twilio")
    expect(agentScopedTwilioPhoneBasePath("!!!")).toBe("/voice/agents/agent/twilio")
  })

  it("leaves the phone transport disabled until this machine has a public URL", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {},
      machineConfig: {},
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    })

    expect(resolution).toEqual({
      status: "disabled",
      reason: "voice.twilioPublicUrl is not configured",
    })
  })

  it("resolves the runtime settings needed by the managed Twilio transport", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: configuredMachine,
      defaultBasePath: "/voice/agents/ignored/twilio",
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        agentName: "slugger",
        publicBaseUrl: "https://voice.example.test/",
        basePath: "/voice/agents/slugger/twilio",
        webhookUrl: "https://voice.example.test/voice/agents/slugger/twilio/incoming",
        port: 2222,
        host: "127.0.0.1",
        defaultFriendId: "ari",
        twilioFromNumber: "+15557654321",
        recordTimeoutSeconds: 3,
        recordMaxLengthSeconds: 30,
        greetingPrebufferMs: 4200,
        playbackMode: "stream",
        transportMode: "media-stream",
      },
    })
  })

  it("resolves OpenAI Realtime phone voice without requiring cascade STT/TTS credentials", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        integrations: {
          openaiEmbeddingsApiKey: "openai-compat-key",
        },
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeVoice: "cedar",
          openaiRealtimeVoiceStyle: "scrappy and lightly British",
          openaiRealtimeVoiceSpeed: "1.08",
          openaiRealtimeVadThreshold: "0.64",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioBasePath: "/voice/agents/slugger/twilio",
          twilioTransportMode: "media-stream",
          twilioConversationEngine: "openai-realtime",
          openaiRealtimeModel: "gpt-realtime-2",
          openaiRealtimeVoice: "marin",
          openaiRealtimeReasoningEffort: "low",
          openaiRealtimeNoiseReduction: "near_field",
          openaiRealtimeVadSilenceDurationMs: "420",
          openaiRealtimeVadPrefixPaddingMs: 300,
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        conversationEngine: "openai-realtime",
        transportMode: "media-stream",
        elevenLabsApiKey: "",
        elevenLabsVoiceId: "",
        whisperCliPath: "",
        whisperModelPath: "",
        openaiRealtime: {
          apiKey: "openai-compat-key",
          apiKeySource: "integrations.openaiEmbeddingsApiKey",
          model: "gpt-realtime-2",
          voice: "cedar",
          voiceStyle: "scrappy and lightly British",
          voiceSpeed: 1.08,
          reasoningEffort: "low",
          noiseReduction: "near_field",
          turnDetection: {
            threshold: 0.64,
            prefixPaddingMs: 300,
            silenceDurationMs: 420,
          },
        },
      },
    })
  })

  it("infers OpenAI Realtime phone voice from a key on Media Stream transports", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeApiKey: "openai-secret",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        conversationEngine: "openai-realtime",
        outboundConversationEngine: "openai-realtime",
        elevenLabsApiKey: "",
        whisperCliPath: "",
        openaiRealtime: {
          apiKey: "openai-secret",
          apiKeySource: "voice.openaiRealtimeApiKey",
        },
      },
    })
  })

  it("requires Media Streams and an OpenAI key for the Realtime phone engine", () => {
    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: { openaiRealtimeApiKey: "openai-secret" },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "record-play",
          twilioConversationEngine: "openai-realtime",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })).toThrow("voice.twilioConversationEngine/openai-realtime requires voice.twilioTransportMode=media-stream")

    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {},
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
          twilioConversationEngine: "openai-realtime",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })).toThrow("missing voice.openaiRealtimeApiKey")
  })

  it("resolves OpenAI SIP phone voice without requiring cascade STT/TTS credentials", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
          openaiSipWebhookSecret: "whsec_test",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioBasePath: "/voice/agents/slugger/twilio",
          twilioTransportMode: "media-stream",
          twilioConversationEngine: "openai-sip",
          openaiRealtimeModel: "gpt-realtime-2",
          openaiRealtimeVoice: "cedar",
          openaiRealtimeVoiceStyle: "scrappy and lightly British",
          openaiRealtimeVoiceSpeed: "1.08",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        conversationEngine: "openai-sip",
        outboundConversationEngine: "openai-realtime",
        transportMode: "media-stream",
        elevenLabsApiKey: "",
        elevenLabsVoiceId: "",
        whisperCliPath: "",
        whisperModelPath: "",
        openaiRealtime: {
          apiKey: "openai-secret",
          apiKeySource: "voice.openaiRealtimeApiKey",
          model: "gpt-realtime-2",
          voice: "cedar",
          voiceStyle: "scrappy and lightly British",
          voiceSpeed: 1.08,
        },
        openaiSip: {
          projectId: "proj_test",
          webhookPath: "/voice/agents/slugger/sip/openai",
          webhookSecret: "whsec_test",
        },
        openaiSipWebhookUrl: "https://voice.example.test/voice/agents/slugger/sip/openai",
      },
    })
  })

  it("can keep inbound SIP while routing outbound calls through OpenAI Realtime Media Streams", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
          openaiSipWebhookSecret: "whsec_test",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
          twilioConversationEngine: "openai-sip",
          twilioOutboundConversationEngine: "openai-realtime",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        conversationEngine: "openai-sip",
        outboundConversationEngine: "openai-realtime",
        transportMode: "media-stream",
        elevenLabsApiKey: "",
        whisperCliPath: "",
        openaiRealtime: {
          apiKey: "openai-secret",
        },
        openaiSip: {
          projectId: "proj_test",
        },
      },
    })

    const invalidCascadeResolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
          openaiSipWebhookSecret: "whsec_test",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
          twilioConversationEngine: "openai-sip",
          twilioOutboundConversationEngine: "cascade",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })
    expect(invalidCascadeResolution).toMatchObject({
      status: "configured",
      settings: {
        conversationEngine: "openai-sip",
        outboundConversationEngine: "openai-realtime",
      },
    })
  })

  it("infers OpenAI SIP voice from SIP credentials when the engine field is absent", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
          openaiSipWebhookSecret: "whsec_test",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        conversationEngine: "openai-sip",
        outboundConversationEngine: "openai-realtime",
        openaiRealtime: { apiKey: "openai-secret" },
        openaiSip: { projectId: "proj_test" },
      },
    })

    const staleCascadeResolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          twilioConversationEngine: "cascade",
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
          openaiSipWebhookSecret: "whsec_test",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })
    expect(staleCascadeResolution).toMatchObject({
      status: "configured",
      settings: {
        conversationEngine: "openai-sip",
        outboundConversationEngine: "openai-realtime",
      },
    })
  })

  it("can resolve unsigned local OpenAI SIP webhooks when explicitly enabled", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
          openaiSipAllowUnsignedWebhooks: true,
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioConversationEngine: "openai-sip",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        openaiSip: {
          projectId: "proj_test",
          allowUnsignedWebhooks: true,
        },
      },
    })
  })

  it("requires an OpenAI project id and webhook secret for the SIP phone engine", () => {
    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: { openaiRealtimeApiKey: "openai-secret" },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioConversationEngine: "openai-sip",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })).toThrow("missing voice.openaiSipProjectId")

    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        voice: {
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
        },
      },
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioConversationEngine: "openai-sip",
        },
      },
      defaultBasePath: "/voice/agents/ignored/twilio",
    })).toThrow("missing voice.openaiSipWebhookSecret")
  })

  it("places configured outbound phone calls through the Twilio transport", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-runtime-"))
    try {
      const machineConfig = {
        voice: {
          ...configuredMachine.voice,
          twilioOutputDir: outputDir,
        },
      }
      const deps = fakeOutboundDeps(configuredRuntime, machineConfig)
      const result = await placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+1 (555) 123-4567",
        reason: "check in about the phone alpha",
        outboundId: "outbound-test",
        now: new Date("2026-05-08T12:00:00.000Z"),
        initialAudio: { source: "tone", label: "hello tone", toneHz: 440, durationMs: 80 },
      }, deps)

      expect(result).toMatchObject({
        outboundId: "outbound-test",
        callSid: "CAOUT",
        status: "queued",
        webhookUrl: "https://voice.example.test/voice/agents/slugger/twilio/outgoing/outbound-test",
        statusCallbackUrl: "https://voice.example.test/voice/agents/slugger/twilio/outgoing/outbound-test/status",
      })
      expect(deps.createOutboundCall).toHaveBeenCalledWith({
        accountSid: "AC123",
        authToken: "twilio-secret",
        to: "+15551234567",
        from: "+15557654321",
        twimlUrl: "https://voice.example.test/voice/agents/slugger/twilio/outgoing/outbound-test",
        statusCallbackUrl: "https://voice.example.test/voice/agents/slugger/twilio/outgoing/outbound-test/status",
        machineDetection: "Enable",
        asyncAmd: true,
        asyncAmdStatusCallbackUrl: "https://voice.example.test/voice/agents/slugger/twilio/outgoing/outbound-test/amd",
      })
      expect(deps.waitForRuntimeCredentialBootstrap).not.toHaveBeenCalled()
      expect(deps.refreshRuntimeConfig).not.toHaveBeenCalled()
      expect(deps.refreshMachineRuntimeConfig).not.toHaveBeenCalled()
      expect(deps.runVoiceLoopbackTurn).toHaveBeenCalledWith(expect.objectContaining({
        agentName: "slugger",
        friendId: "ari",
        sessionKey: "twilio-phone-ari-via-15557654321",
      }))
      const saved = JSON.parse(await fs.readFile(path.join(outputDir, "outbound", "outbound-test.json"), "utf8")) as { status?: string; transportCallSid?: string; reason?: string; initialAudio?: unknown; prewarmedGreeting?: { audioPath?: string; mimeType?: string } }
      expect(saved).toMatchObject({
        status: "queued",
        transportCallSid: "CAOUT",
        reason: "check in about the phone alpha",
        initialAudio: { source: "tone", label: "hello tone", toneHz: 440, durationMs: 80 },
        prewarmedGreeting: {
          mimeType: "audio/x-mulaw;rate=8000",
        },
      })
      expect(saved.prewarmedGreeting?.audioPath).toContain("outbound-greetings/outbound-test")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("creates outbound ids when none are supplied", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-runtime-"))
    try {
      const deps = fakeOutboundDeps(configuredRuntime, {
        voice: {
          ...configuredMachine.voice,
          twilioOutputDir: outputDir,
        },
      })

      const result = await placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        reason: "test generated id",
        now: new Date("2026-05-08T12:34:56.000Z"),
      }, deps)

      expect(result.outboundId).toMatch(/^outbound-20260508T123456-[A-Za-z0-9._-]{8}$/)
      expect(deps.createOutboundCall).toHaveBeenCalledOnce()
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("prewarms media-stream outbound greetings even without a pinned friend id", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-runtime-no-friend-"))
    try {
      const deps = fakeOutboundDeps(configuredRuntime, {
        voice: {
          ...configuredMachine.voice,
          twilioOutputDir: outputDir,
        },
      })

      const result = await placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        to: "+15551234567",
        reason: "unpinned friend",
        outboundId: "outbound-no-friend",
        now: new Date("2026-05-08T12:00:00.000Z"),
      }, deps)

      expect(result.status).toBe("queued")
      expect(deps.runVoiceLoopbackTurn).toHaveBeenCalledWith(expect.objectContaining({
        friendId: "twilio-15551234567",
        sessionKey: "twilio-phone-twilio-15551234567-via-15557654321",
      }))
      const saved = JSON.parse(await fs.readFile(path.join(outputDir, "outbound", "outbound-no-friend.json"), "utf8")) as { friendId?: string; prewarmedGreeting?: unknown }
      expect(saved.friendId).toBeUndefined()
      expect(saved.prewarmedGreeting).toBeDefined()
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("places SIP outbound calls without prewarming or optional Twilio response fields", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-runtime-sip-"))
    try {
      const deps = fakeOutboundDeps({
        voice: {
          twilioAccountSid: "AC123",
          twilioAuthToken: "twilio-secret",
          twilioFromNumber: "+15557654321",
          openaiRealtimeApiKey: "openai-secret",
          openaiSipProjectId: "proj_test",
          openaiSipWebhookSecret: "whsec_test",
        },
      }, {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioConversationEngine: "openai-sip",
          twilioOutputDir: outputDir,
        },
      })
      deps.createOutboundCall = vi.fn(async () => ({}))

      const result = await placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        to: "+15551234567",
        reason: "sip check",
        outboundId: "out-sip-runtime",
      }, deps)

      expect(result).toMatchObject({
        outboundId: "out-sip-runtime",
        webhookUrl: "https://voice.example.test/voice/agents/slugger/twilio/outgoing/out-sip-runtime",
        statusCallbackUrl: "https://voice.example.test/voice/agents/slugger/twilio/outgoing/out-sip-runtime/status",
      })
      expect(result.callSid).toBeUndefined()
      expect(result.status).toBeUndefined()
      expect(deps.runVoiceLoopbackTurn).not.toHaveBeenCalled()
      const saved = JSON.parse(await fs.readFile(path.join(outputDir, "outbound", "out-sip-runtime.json"), "utf8")) as { status?: string; friendId?: string; events?: Array<{ status?: string; callSid?: string }> }
      expect(saved.status).toBe("queued")
      expect(saved.friendId).toBeUndefined()
      expect(saved.events?.[0]).toMatchObject({ status: "queued" })
      expect(saved.events?.[0]?.callSid).toBeUndefined()
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("rejects invalid outbound call coordinates before dialing", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-runtime-invalid-"))
    try {
      const baseVoice = {
        ...configuredRuntime.voice,
        twilioOutputDir: outputDir,
      }
      await expect(placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "not a phone",
        reason: "bad target",
      }, fakeOutboundDeps(configuredRuntime, { voice: { ...configuredMachine.voice, twilioOutputDir: outputDir } }))).rejects.toThrow("outbound voice call target must be an E.164 phone number")

      await expect(placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        reason: "missing from",
      }, fakeOutboundDeps({
        integrations: configuredRuntime.integrations,
        voice: { twilioAccountSid: "AC123", twilioAuthToken: "twilio-secret" },
      }, { voice: { ...configuredMachine.voice, twilioOutputDir: outputDir } }))).rejects.toThrow("missing voice.twilioFromNumber")

      await expect(placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        reason: "missing sid",
      }, fakeOutboundDeps({
        integrations: configuredRuntime.integrations,
        voice: { ...baseVoice, twilioAccountSid: "   " },
      }, { voice: { ...configuredMachine.voice, twilioOutputDir: outputDir } }))).rejects.toThrow("missing voice.twilioAccountSid")

      await expect(placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        reason: "missing token",
      }, fakeOutboundDeps({
        integrations: configuredRuntime.integrations,
        voice: { ...baseVoice, twilioAuthToken: "   " },
      }, { voice: { ...configuredMachine.voice, twilioOutputDir: outputDir } }))).rejects.toThrow("missing voice.twilioAuthToken")
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("suppresses duplicate outbound calls while a previous call is still active", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-runtime-"))
    try {
      await fs.mkdir(path.join(outputDir, "outbound"), { recursive: true })
      await fs.writeFile(path.join(outputDir, "outbound", "recent.json"), JSON.stringify({
        schemaVersion: 1,
        outboundId: "recent",
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        from: "+15557654321",
        reason: "already ringing",
        createdAt: "2026-05-08T12:00:00.000Z",
      }), "utf8")
      const deps = fakeOutboundDeps(configuredRuntime, {
        voice: {
          ...configuredMachine.voice,
          twilioOutputDir: outputDir,
        },
      })

      await expect(placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        reason: "duplicate",
        now: new Date("2026-05-08T12:00:30.000Z"),
      }, deps)).rejects.toThrow("outbound voice call suppressed")
      expect(deps.createOutboundCall).not.toHaveBeenCalled()
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  it("fails outbound calls when the cached phone transport is disabled", async () => {
    const deps = fakeOutboundDeps(configuredRuntime, { voice: { twilioPublicUrl: "https://voice.example.test", twilioEnabled: false } })

    await expect(placeConfiguredTwilioPhoneCall({
      agentName: "slugger",
      friendId: "ari",
      to: "+15551234567",
      reason: "test disabled",
    }, deps)).rejects.toThrow("Twilio phone voice transport is disabled: voice.twilioPublicUrl is not configured")
    expect(deps.waitForRuntimeCredentialBootstrap).not.toHaveBeenCalled()
  })

  it("marks outbound calls failed when greeting prewarm or Twilio placement fails", async () => {
    const prewarmOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-prewarm-fail-"))
    try {
      const prewarmDeps = fakeOutboundDeps(configuredRuntime, {
        voice: {
          ...configuredMachine.voice,
          twilioOutputDir: prewarmOutputDir,
        },
      })
      prewarmDeps.runVoiceLoopbackTurn = vi.fn(async () => ({
        responseText: "",
        ponderDeferred: false,
        tts: {
          status: "failed",
          error: "tts down",
        },
        speechSegments: [],
        speechDeliveryErrors: [],
      }))

      await expect(placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        reason: "prewarm failure",
        outboundId: "prewarm-fail",
      }, prewarmDeps)).rejects.toThrow("outbound greeting prewarm failed: tts down")
      const prewarmJob = JSON.parse(await fs.readFile(path.join(prewarmOutputDir, "outbound", "prewarm-fail.json"), "utf8")) as { status?: string; error?: string }
      expect(prewarmJob).toMatchObject({ status: "failed", error: "outbound greeting prewarm failed: tts down" })
    } finally {
      await fs.rm(prewarmOutputDir, { recursive: true, force: true })
    }

    const twilioOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-twilio-call-fail-"))
    try {
      const twilioDeps = fakeOutboundDeps(configuredRuntime, {
        voice: {
          ...configuredMachine.voice,
          twilioOutputDir: twilioOutputDir,
        },
      })
      twilioDeps.createOutboundCall = vi.fn(async () => {
        throw new Error("twilio offline")
      })

      await expect(placeConfiguredTwilioPhoneCall({
        agentName: "slugger",
        friendId: "ari",
        to: "+15551234567",
        reason: "twilio failure",
        outboundId: "twilio-fail",
      }, twilioDeps)).rejects.toThrow("twilio offline")
      const twilioJob = JSON.parse(await fs.readFile(path.join(twilioOutputDir, "outbound", "twilio-fail.json"), "utf8")) as { status?: string; error?: string }
      expect(twilioJob).toMatchObject({ status: "failed", error: "twilio offline" })
    } finally {
      await fs.rm(twilioOutputDir, { recursive: true, force: true })
    }
  })

  it("throws when phone transport is explicitly required without a public URL", () => {
    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {},
      requirePublicUrl: true,
    })).toThrow("missing voice.twilioPublicUrl")

    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: { voice: { twilioEnabled: true } },
    })).toThrow("missing voice.twilioPublicUrl")
  })

  it("lets an explicit disabled flag suppress a saved public URL", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          ...configuredMachine.voice,
          twilioEnabled: false,
        },
      },
    })

    expect(resolution).toEqual({
      status: "disabled",
      reason: "voice.twilioPublicUrl is not configured",
    })

    const stringResolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          ...configuredMachine.voice,
          twilioEnabled: "false",
        },
      },
    })
    expect(stringResolution.status).toBe("disabled")

    const ignoredStringResolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          ...configuredMachine.voice,
          twilioEnabled: "not-a-bool",
        },
      },
    })
    expect(ignoredStringResolution.status).toBe("configured")
  })

  it("accepts string enabled flags from runtime config", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          ...configuredMachine.voice,
          twilioEnabled: "true",
        },
      },
    })

    expect(resolution.status).toBe("configured")
  })

  it("rejects public URLs that Twilio cannot call securely", () => {
    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          ...configuredMachine.voice,
          twilioPublicUrl: "http://voice.example.test",
        },
      },
    })).toThrow("voice.twilioPublicUrl must be an https URL")
  })

  it("fails fast on missing STT and TTS runtime fields", () => {
    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: { integrations: { elevenLabsVoiceId: "voice_123" } },
      machineConfig: configuredMachine,
    })).toThrow("missing integrations.elevenLabsApiKey")

    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: { integrations: { elevenLabsApiKey: "eleven-secret" } },
      machineConfig: configuredMachine,
    })).toThrow("missing integrations.elevenLabsVoiceId")

    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          whisperModelPath: "/models/ggml-base.en.bin",
        },
      },
    })).toThrow("missing voice.whisperCliPath")

    expect(() => resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          whisperCliPath: "/opt/whisper.cpp/main",
        },
      },
    })).toThrow("missing voice.whisperModelPath")
  })

  it("lets explicit overrides win over saved runtime settings", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: {
        integrations: {
          elevenLabsApiKey: "eleven-secret",
        },
        voice: {
          elevenLabsVoiceId: "voice_from_voice_config",
        },
      },
      machineConfig: {
        voice: {
          whisperCliPath: "/opt/whisper.cpp/main",
          whisperModelPath: "/models/ggml-base.en.bin",
          twilioRecordMaxLengthSeconds: 12,
        },
      },
      overrides: {
        publicBaseUrl: "https://override.example.test/base",
        basePath: "custom/phone",
        port: 3333,
        host: "0.0.0.0",
        outputDir: "/tmp/voice-output",
        defaultFriendId: "bea",
        elevenLabsVoiceId: "voice_override",
        recordTimeoutSeconds: 4,
        greetingPrebufferMs: 750,
        playbackMode: "buffered",
        transportMode: "record-play",
      },
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        publicBaseUrl: "https://override.example.test/base",
        basePath: "/custom/phone",
        webhookUrl: "https://override.example.test/custom/phone/incoming",
        port: 3333,
        host: "0.0.0.0",
        outputDir: "/tmp/voice-output",
        defaultFriendId: "bea",
        elevenLabsVoiceId: "voice_override",
        recordTimeoutSeconds: 4,
        recordMaxLengthSeconds: 12,
        greetingPrebufferMs: 750,
        playbackMode: "buffered",
        transportMode: "record-play",
      },
    })
  })

  it("uses default Twilio server settings when optional machine fields are absent", () => {
    const resolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          whisperCliPath: "/opt/whisper.cpp/main",
          whisperModelPath: "/models/ggml-base.en.bin",
        },
      },
    })

    expect(resolution).toMatchObject({
      status: "configured",
      settings: {
        port: 18910,
        host: "127.0.0.1",
        recordTimeoutSeconds: 1,
        recordMaxLengthSeconds: 30,
        greetingPrebufferMs: 3500,
        playbackMode: "stream",
        transportMode: "record-play",
      },
    })

    const invalidNumberResolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioPort: "not-a-number",
          whisperCliPath: "/opt/whisper.cpp/main",
          whisperModelPath: "/models/ggml-base.en.bin",
        },
      },
    })
    expect(invalidNumberResolution).toMatchObject({
      status: "configured",
      settings: { port: 18910 },
    })

    const malformedConfigResolution = resolveTwilioPhoneTransportRuntime({
      agentName: "slugger",
      runtimeConfig: configuredRuntime,
      machineConfig: "not-object" as unknown as Record<string, unknown>,
      overrides: {
        publicBaseUrl: "https://voice.example.test",
        basePath: "/voice/agents/slugger/twilio",
        whisperCliPath: "/opt/whisper.cpp/main",
        whisperModelPath: "/models/ggml-base.en.bin",
      },
    })
    expect(malformedConfigResolution).toMatchObject({
      status: "configured",
      settings: { port: 18910 },
    })
  })

  it("returns disabled from the start helper before constructing clients", async () => {
    const deps = fakeDeps({}, {})

    const result = await startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)

    expect(result).toEqual({
      status: "disabled",
      reason: "voice.twilioPublicUrl is not configured",
    })
    expect(deps.cacheSelectedProviderCredentials).not.toHaveBeenCalled()
    expect(deps.startBridgeServer).not.toHaveBeenCalled()
  })

  it("continues with cached runtime config when refresh calls fail", async () => {
    const deps = fakeDeps(configuredRuntime, configuredMachine)
    deps.refreshRuntimeConfig = vi.fn(async () => {
      throw new Error("runtime refresh unavailable")
    })
    deps.refreshMachineRuntimeConfig = vi.fn(async () => {
      throw new Error("machine refresh unavailable")
    })

    const result = await startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)

    expect(result.status).toBe("started")
    expect(deps.startBridgeServer).toHaveBeenCalledOnce()
  })

  it("fails when cached runtime config cannot be read", async () => {
    const deps = fakeDeps(configuredRuntime, configuredMachine)
    deps.readRuntimeConfig = vi.fn(() => ({
      ok: false,
      reason: "missing",
      itemPath: "runtime/config",
      error: "not found",
    }))

    await expect(startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)).rejects.toThrow("portable runtime/config unavailable: not found")
  })

  it("starts the configured bridge after refreshing runtime and provider credentials", async () => {
    const deps = fakeDeps(
      {
        integrations: {
          elevenLabsApiKey: "eleven-secret",
          elevenLabsVoiceId: "voice_123",
        },
        voice: {
          twilioAuthToken: "twilio-secret",
        },
      },
      {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioPort: 2222,
          twilioDefaultFriendId: "ari",
          whisperCliPath: "/opt/whisper.cpp/main",
          whisperModelPath: "/models/ggml-base.en.bin",
        },
      },
    )

    const result = await startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)

    expect(result.status).toBe("started")
    expect(deps.waitForRuntimeCredentialBootstrap).toHaveBeenCalledWith("slugger")
    expect(deps.refreshMachineRuntimeConfig).toHaveBeenCalledWith("slugger", "machine_voice", { preserveCachedOnFailure: true })
    expect(deps.cacheSelectedProviderCredentials).toHaveBeenCalledWith("slugger")
    expect(deps.createTts).toHaveBeenCalledWith(expect.objectContaining({
      outputFormat: "mp3_44100_128",
    }))
    expect(deps.startBridgeServer).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "slugger",
      publicBaseUrl: "https://voice.example.test/",
      basePath: "/voice/agents/slugger/twilio",
      port: 2222,
      defaultFriendId: "ari",
      recordTimeoutSeconds: 1,
      recordMaxLengthSeconds: 30,
      greetingPrebufferMs: 3500,
      playbackMode: "stream",
      transportMode: "record-play",
    }))
  })

  it("uses daemon-bootstrapped runtime config without re-reading the vault", async () => {
    const deps = fakeDeps(configuredRuntime, configuredMachine)
    deps.waitForRuntimeCredentialBootstrap = vi.fn(async () => true)

    const result = await startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)

    expect(result.status).toBe("started")
    expect(deps.loadMachineIdentity).not.toHaveBeenCalled()
    expect(deps.refreshRuntimeConfig).not.toHaveBeenCalled()
    expect(deps.refreshMachineRuntimeConfig).not.toHaveBeenCalled()
    expect(deps.startBridgeServer).toHaveBeenCalledOnce()
  })

  it("uses Twilio-native ulaw TTS for Media Streams transports", async () => {
    const deps = fakeDeps(configuredRuntime, configuredMachine)

    const result = await startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)

    expect(result.status).toBe("started")
    expect(deps.createTts).toHaveBeenCalledWith(expect.objectContaining({
      outputFormat: "ulaw_8000",
    }))
    expect(deps.startBridgeServer).toHaveBeenCalledWith(expect.objectContaining({
      transportMode: "media-stream",
    }))
  })

  it("starts OpenAI Realtime phone transports without cascade clients", async () => {
    const deps = fakeDeps(
      {
        integrations: {
          openaiApiKey: "openai-secret",
        },
      },
      {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
          twilioConversationEngine: "openai-realtime",
          openaiRealtimeModel: "gpt-realtime-2",
          openaiRealtimeVoice: "marin",
        },
      },
    )

    const result = await startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)

    expect(result.status).toBe("started")
    expect(deps.createTranscriber).not.toHaveBeenCalled()
    expect(deps.createTts).not.toHaveBeenCalled()
    expect(deps.startBridgeServer).toHaveBeenCalledWith(expect.objectContaining({
      transportMode: "media-stream",
      conversationEngine: "openai-realtime",
      openaiRealtime: expect.objectContaining({
        apiKey: "openai-secret",
        apiKeySource: "integrations.openaiApiKey",
        model: "gpt-realtime-2",
        voice: "marin",
      }),
    }))
    const bridgeOptions = vi.mocked(deps.startBridgeServer).mock.calls[0]?.[0]
    await expect(bridgeOptions?.transcriber.transcribe({
      utteranceId: "utt",
      audioPath: "/tmp/audio.wav",
    })).rejects.toThrow("OpenAI Realtime voice sessions do not use the cascade transcriber")
    await expect(bridgeOptions?.tts.synthesize({
      utteranceId: "utt",
      text: "hello",
    })).rejects.toThrow("OpenAI Realtime voice sessions do not use the cascade TTS service")
  })

  it("announces the legacy OpenAI compatibility key while starting Realtime", async () => {
    const deps = fakeDeps(
      {
        integrations: {
          openaiEmbeddingsApiKey: "openai-compat-key",
        },
      },
      {
        voice: {
          twilioPublicUrl: "https://voice.example.test",
          twilioTransportMode: "media-stream",
          twilioConversationEngine: "openai-realtime",
          openaiRealtimeModel: "gpt-realtime-2",
          openaiRealtimeVoice: "cedar",
        },
      },
    )

    await expect(startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: agentScopedTwilioPhoneBasePath("slugger"),
    }, deps)).resolves.toMatchObject({ status: "started" })

    expect(deps.startBridgeServer).toHaveBeenCalledWith(expect.objectContaining({
      openaiRealtime: expect.objectContaining({
        apiKey: "openai-compat-key",
        apiKeySource: "integrations.openaiEmbeddingsApiKey",
      }),
    }))
  })

  it("closes Twilio bridge servers and surfaces close failures", async () => {
    await expect(closeTwilioPhoneBridgeServer({
      bridge: { handle: vi.fn() },
      localUrl: "http://127.0.0.1:2222",
      server: {
        close: vi.fn((callback: (error?: Error) => void) => callback()),
      } as unknown as Server,
    })).resolves.toBeUndefined()

    await expect(closeTwilioPhoneBridgeServer({
      bridge: { handle: vi.fn() },
      localUrl: "http://127.0.0.1:2222",
      server: {
        close: vi.fn((callback: (error?: Error) => void) => callback(new Error("close failed"))),
      } as unknown as Server,
    })).rejects.toThrow("close failed")
  })

  it("uses selected provider credentials when running with default dependencies", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/tmp/slugger.ouro",
      loadAgentConfig: () => ({
        version: 1,
        enabled: true,
        provider: "minimax",
        humanFacing: { provider: "anthropic", model: "claude" },
        agentFacing: { provider: "openai-codex", model: "gpt" },
        senses: { voice: { enabled: true } },
        phrases: { thinking: [], tool: [], followup: [] },
      }),
    }))
    vi.doMock("../../../heart/machine-identity", () => ({
      loadOrCreateMachineIdentity: () => ({
        schemaVersion: 1,
        machineId: "machine_voice",
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        hostnameAliases: [],
      }),
    }))
    vi.doMock("../../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => undefined),
      refreshRuntimeCredentialConfig: vi.fn(async () => runtimeReadResult(configuredRuntime)),
      refreshMachineRuntimeCredentialConfig: vi.fn(async () => runtimeReadResult(configuredMachine)),
      readRuntimeCredentialConfig: vi.fn(() => runtimeReadResult(configuredRuntime)),
      readMachineRuntimeCredentialConfig: vi.fn(() => runtimeReadResult(configuredMachine)),
    }))
    const refreshProviderCredentialPool = vi.fn(async () => ({
      ok: false,
      error: "vault locked",
    }))
    vi.doMock("../../../heart/provider-credentials", () => ({
      readProviderCredentialPool: vi.fn(() => ({ ok: false })),
      refreshProviderCredentialPool,
    }))
    vi.doMock("../../../senses/voice/whisper", () => ({
      createWhisperCppTranscriber: vi.fn(),
    }))
    vi.doMock("../../../senses/voice/elevenlabs", () => ({
      createElevenLabsTtsClient: vi.fn(),
    }))

    const runtime = await import("../../../senses/voice/twilio-phone-runtime")

    await expect(runtime.startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: runtime.agentScopedTwilioPhoneBasePath("slugger"),
    })).rejects.toThrow("provider credentials unavailable for phone voice: vault locked")
    expect(refreshProviderCredentialPool).toHaveBeenCalledWith("slugger", {
      providers: ["anthropic", "openai-codex", "minimax"],
    })
  })

  it("reports missing selected provider credentials from default dependencies", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/tmp/slugger.ouro",
      loadAgentConfig: () => ({
        version: 1,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude" },
        agentFacing: { provider: "openai-codex", model: "gpt" },
        senses: { voice: { enabled: true } },
        phrases: { thinking: [], tool: [], followup: [] },
      }),
    }))
    vi.doMock("../../../heart/machine-identity", () => ({
      loadOrCreateMachineIdentity: () => ({
        schemaVersion: 1,
        machineId: "machine_voice",
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        hostnameAliases: [],
      }),
    }))
    vi.doMock("../../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => undefined),
      refreshRuntimeCredentialConfig: vi.fn(async () => runtimeReadResult(configuredRuntime)),
      refreshMachineRuntimeCredentialConfig: vi.fn(async () => runtimeReadResult(configuredMachine)),
      readRuntimeCredentialConfig: vi.fn(() => runtimeReadResult(configuredRuntime)),
      readMachineRuntimeCredentialConfig: vi.fn(() => runtimeReadResult(configuredMachine)),
    }))
    const refreshProviderCredentialPool = vi.fn(async () => ({
      ok: true,
      pool: { providers: { anthropic: {} } },
    }))
    vi.doMock("../../../heart/provider-credentials", () => ({
      readProviderCredentialPool: vi.fn(() => ({ ok: false })),
      refreshProviderCredentialPool,
    }))
    vi.doMock("../../../senses/voice/whisper", () => ({
      createWhisperCppTranscriber: vi.fn(),
    }))
    vi.doMock("../../../senses/voice/elevenlabs", () => ({
      createElevenLabsTtsClient: vi.fn(),
    }))

    const runtime = await import("../../../senses/voice/twilio-phone-runtime")

    await expect(runtime.startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: runtime.agentScopedTwilioPhoneBasePath("slugger"),
    })).rejects.toThrow("missing provider credentials for phone voice: openai-codex")
    expect(refreshProviderCredentialPool).toHaveBeenCalledWith("slugger", {
      providers: ["anthropic", "openai-codex"],
    })
  })

  it("starts with default dependencies when all selected provider credentials are present", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/tmp/slugger.ouro",
      loadAgentConfig: () => ({
        version: 1,
        enabled: true,
        provider: "minimax",
        humanFacing: { provider: "anthropic", model: "claude" },
        agentFacing: { provider: "openai-codex", model: "gpt" },
        senses: { voice: { enabled: true } },
        phrases: { thinking: [], tool: [], followup: [] },
      }),
    }))
    vi.doMock("../../../heart/machine-identity", () => ({
      loadOrCreateMachineIdentity: () => ({
        schemaVersion: 1,
        machineId: "machine_voice",
        createdAt: "2026-05-07T08:00:00.000Z",
        updatedAt: "2026-05-07T08:00:00.000Z",
        hostnameAliases: [],
      }),
    }))
    vi.doMock("../../../heart/runtime-credentials", () => ({
      waitForRuntimeCredentialBootstrap: vi.fn(async () => undefined),
      refreshRuntimeCredentialConfig: vi.fn(async () => runtimeReadResult(configuredRuntime)),
      refreshMachineRuntimeCredentialConfig: vi.fn(async () => runtimeReadResult(configuredMachine)),
      readRuntimeCredentialConfig: vi.fn(() => runtimeReadResult(configuredRuntime)),
      readMachineRuntimeCredentialConfig: vi.fn(() => runtimeReadResult(configuredMachine)),
    }))
    vi.doMock("../../../heart/provider-credentials", () => ({
      readProviderCredentialPool: vi.fn(() => ({ ok: false })),
      refreshProviderCredentialPool: vi.fn(async () => ({
        ok: true,
        pool: {
          providers: {
            anthropic: {},
            "openai-codex": {},
            minimax: {},
          },
        },
      })),
    }))
    vi.doMock("../../../senses/voice/whisper", () => ({
      createWhisperCppTranscriber: vi.fn(() => ({ transcribe: vi.fn() })),
    }))
    vi.doMock("../../../senses/voice/elevenlabs", () => ({
      createElevenLabsTtsClient: vi.fn(() => ({ synthesize: vi.fn() })),
    }))
    const startTwilioPhoneBridgeServer = vi.fn(async () => ({
      bridge: { handle: vi.fn() },
      server: { close: vi.fn() } as unknown as Server,
      localUrl: "http://127.0.0.1:2222",
    }))
    vi.doMock("../../../senses/voice/twilio-phone", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../../senses/voice/twilio-phone")>(),
      startTwilioPhoneBridgeServer,
    }))

    const runtime = await import("../../../senses/voice/twilio-phone-runtime")

    const result = await runtime.startConfiguredTwilioPhoneTransport({
      agentName: "slugger",
      defaultBasePath: runtime.agentScopedTwilioPhoneBasePath("slugger"),
    })

    expect(result.status).toBe("started")
    expect(startTwilioPhoneBridgeServer).toHaveBeenCalledOnce()
  })
})
