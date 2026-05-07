import type { Server } from "http"
import { describe, expect, it, vi } from "vitest"
import {
  agentScopedTwilioPhoneBasePath,
  closeTwilioPhoneBridgeServer,
  resolveTwilioPhoneTransportRuntime,
  startConfiguredTwilioPhoneTransport,
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

describe("Twilio phone transport runtime", () => {
  const configuredRuntime = {
    integrations: {
      elevenLabsApiKey: "eleven-secret",
      elevenLabsVoiceId: "voice_123",
    },
    voice: {
      twilioAccountSid: "AC123",
      twilioAuthToken: "twilio-secret",
    },
  }
  const configuredMachine = {
    voice: {
      twilioPublicUrl: "https://voice.example.test",
      twilioBasePath: "/voice/agents/slugger/twilio",
      twilioPort: "2222",
      twilioDefaultFriendId: "ari",
      twilioRecordTimeoutSeconds: "3",
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
        recordTimeoutSeconds: 3,
        recordMaxLengthSeconds: 30,
      },
    })
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
        recordTimeoutSeconds: 2,
        recordMaxLengthSeconds: 30,
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
    expect(deps.startBridgeServer).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "slugger",
      publicBaseUrl: "https://voice.example.test/",
      basePath: "/voice/agents/slugger/twilio",
      port: 2222,
      defaultFriendId: "ari",
      recordTimeoutSeconds: 2,
      recordMaxLengthSeconds: 30,
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
