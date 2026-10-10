import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import type { LocalAudioJoinRequest } from "../senses/voice/local-audio-transport"
import type { LocalAudioLaunchDeps, LocalAudioLaunchResult } from "../senses/voice/local-audio-join"
import type { ToolDefinition } from "./tools-base"

/**
 * The tool that lets a family-trusted owner ask the agent to join a call on this Mac through the
 * BlackHole virtual devices. It has no device arguments: the lane always captures BlackHole 16ch
 * and plays into BlackHole 2ch, so it can never listen to a physical microphone.
 */
const TOOL_NAME = "voice_join_local_audio"

/** Direct (one person to one agent) text channels. Voice, inner, mail, a2a and mcp never get this tool. */
const DIRECT_TEXT_CHANNELS: ReadonlySet<string> = new Set(["cli", "bluebubbles", "telegram"])
const DEVICE_ARGUMENTS: ReadonlySet<string> = new Set(["device", "input_device", "output_device", "microphone", "input", "output", "capture_device", "playback_device"])
const ACTIONS: ReadonlySet<string> = new Set(["join", "leave", "status"])

export interface LocalAudioToolGateInput {
  context?: { friend: { trustLevel?: string }; channel: { channel: string }; isGroupChat?: boolean }
  habitSession?: unknown
  autonomousTurnKind?: unknown
  currentExternalEvent?: unknown
  delegatedCommand?: unknown
  relationshipAuthorization?: unknown
  voiceCall?: unknown
}

export type LocalAudioToolGateResult = { ok: true } | { ok: false; reason: string }

/** One predicate for both the offer (tool selection) and the execution-time re-check. */
export function localAudioToolGate(input: LocalAudioToolGateInput): LocalAudioToolGateResult {
  const context = input.context
  if (!context?.friend || !context.channel) return { ok: false, reason: "no resolved friend for this session" }
  if (input.habitSession || input.autonomousTurnKind || input.currentExternalEvent || input.delegatedCommand || input.relationshipAuthorization || input.voiceCall) {
    return { ok: false, reason: "this turn is automatic, delegated, relationship-scoped or a live call, not a direct conversation" }
  }
  if (!DIRECT_TEXT_CHANNELS.has(context.channel.channel)) {
    return { ok: false, reason: "it works only in a direct text session (cli, bluebubbles, telegram); Teams cannot confirm a one-to-one chat yet" }
  }
  if (context.isGroupChat) return { ok: false, reason: "it is not available in a group chat" }
  if (context.friend.trustLevel !== "family") return { ok: false, reason: "only a family-trust friend can start it" }
  return { ok: true }
}

export interface LocalAudioToolDeps {
  launch(request: LocalAudioJoinRequest): Promise<LocalAudioLaunchResult>
  leave(agentName: string): Promise<string>
  status(agentName: string): Promise<string>
}

const normalizeSentence = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/[.!?;:,\s]+$/u, "").toLowerCase()
const CONSENT_WORDING = /\b(consent(s|ed)?|agree[sd]?|okay with|ok with|fine with|permission)\b/iu
const SILENT_WORDING = /\b(silent(ly)?|quiet(ly)?|no announcement|without (an |the )?announc\w*|don'?t announce|do not announce|skip the announcement)\b/iu
const MIN_CONSENT_WORDS = 5

/**
 * True only when the statement is one whole sentence of the owner's current message, word for word,
 * and that sentence both states consent and asks for a silent join. A fragment ("the call") or a
 * sentence about something else never counts, so text the model was steered into quoting cannot
 * turn an ordinary request into a covert recording.
 */
export function ownerConsentsToSilentJoin(message: string | undefined, statement: string): boolean {
  const wanted = normalizeSentence(statement)
  if (wanted.split(" ").length < MIN_CONSENT_WORDS || !CONSENT_WORDING.test(wanted) || !SILENT_WORDING.test(wanted)) return false
  const sentences = (message ?? "").split(/(?<=[.!?])\s+|\n+/u).map(normalizeSentence)
  return sentences.includes(wanted)
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function createVoiceLocalAudioToolDefinition(deps: LocalAudioToolDeps): ToolDefinition {
  return {
    tool: {
      type: "function",
      function: {
        name: TOOL_NAME,
        description: [
          "join, leave, or check a call on this Mac through the BlackHole virtual audio devices (any call app: FaceTime, Zoom, Meet, a recorder).",
          "The call app must use BlackHole 2ch as its microphone and BlackHole 16ch as its speaker. This tool never listens to a physical microphone and takes no device names.",
          "Joining announces you aloud as an AI assistant that is transcribing. Skip the announcement only when the owner's current message has a sentence saying everyone consented to a silent join; pass that whole sentence in silent_consent exactly as they wrote it. A paraphrase or a fragment is refused.",
          "Several people may share this audio, and you cannot tell voices apart. Use action=leave to hang up.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["join", "leave", "status"], description: "join (default), leave, or status" },
            participants: { type: "string", description: "who is on the call, as the owner described them" },
            occasion: { type: "string", description: "what the call is for" },
            owner_alone: { type: "boolean", description: "true only when the owner said they are alone on the call" },
            silent_consent: { type: "string", description: "the owner's own words consenting to a silent join (no spoken announcement), copied verbatim from their current message; omit otherwise" },
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const gate = ctx ? localAudioToolGate(ctx) : ({ ok: false, reason: "no session context" } as const)
      if (!gate.ok) return `${TOOL_NAME} is not available: ${gate.reason}.`
      const provided = Object.keys(args).find((key) => DEVICE_ARGUMENTS.has(key))
      if (provided) {
        emitNervesEvent({ level: "warn", component: "tools", event: "tool.voice_local_audio_device_refused", message: "local audio tool refused a device argument", meta: { argument: provided } })
        return "This tool only uses the BlackHole virtual devices and never listens to a physical microphone or any other device. Remove the device argument."
      }
      const action = readString(args, "action") ?? "join"
      if (!ACTIONS.has(action)) return "action must be join, leave, or status."
      const agentName = ctx?.agentName
      if (!agentName) return `${TOOL_NAME} is not available: no agent name for this session.`
      if (action === "leave") return deps.leave(agentName)
      if (action === "status") return deps.status(agentName)

      const silentConsent = readString(args, "silent_consent")
      if (silentConsent && !ownerConsentsToSilentJoin(ctx!.currentUserMessage, silentConsent)) {
        emitNervesEvent({ level: "warn", component: "tools", event: "tool.voice_local_audio_silent_refused", message: "silent join refused: consent not in the owner's current message", meta: { agentName } })
        return "I can't do a silent join from here: the consent has to be one whole sentence of the owner's current message, copied exactly, that says everyone consented to a silent join, and I can't confirm that. Join with the spoken announcement instead, or the owner can run `ouro voice join --silent-consent \"...\"` themselves."
      }
      const friend = ctx!.context!.friend
      const channel = ctx!.context!.channel.channel
      const session = ctx!.currentSession
      const notify = session
        ? { friendId: session.friendId, channel: session.channel, key: session.key }
        : channel === "cli" ? { friendId: friend.id, channel: "cli", key: "session" } : undefined
      const request: LocalAudioJoinRequest = {
        agentName,
        friendId: friend.id,
        mode: "conversation",
        ownerName: friend.name,
        ...(readString(args, "participants") ? { participants: readString(args, "participants") } : {}),
        ...(readString(args, "occasion") ? { occasion: readString(args, "occasion") } : {}),
        ...(String(args.owner_alone) === "true" ? { ownerAlone: true } : {}),
        ...(silentConsent ? { silentConsent } : {}),
        ...(notify ? { notify } : {}),
      }
      emitNervesEvent({
        component: "tools",
        event: "tool.voice_local_audio_join_requested",
        message: "local audio join requested by the owner",
        meta: { agentName, silent: String(Boolean(request.silentConsent)), ownerAlone: String(Boolean(request.ownerAlone)), notify: String(Boolean(notify)) },
      })
      const result = await deps.launch(request)
      if (!result.ok) return `I did not join the call: ${result.message}`
      return [
        result.message,
        request.silentConsent
          ? "I joined silently on the owner's stated consent."
          : "I am announcing myself aloud as an AI assistant that is transcribing; if I cannot confirm that was spoken I leave and tell the owner.",
        "The call app must use BlackHole 2ch as its microphone and BlackHole 16ch as its speaker for me to hear and be heard.",
        notify ? "The owner is notified when I join and when I leave." : "I could not notify the owner's session (no session to notify), so tell them yourself.",
      ].join(" ")
    },
  }
}

export interface DefaultLocalAudioToolDepsOptions {
  agentRoot?: (agentName: string) => string
  launch?: Pick<LocalAudioLaunchDeps, "execPath" | "cliEntry" | "spawn" | "sleep" | "now" | "timeoutMs">
}

/** Loaded lazily: the join runner pulls in the whole Realtime session, which itself imports the tool registry. */
export function defaultLocalAudioToolDeps(options: DefaultLocalAudioToolDepsOptions = {}): LocalAudioToolDeps {
  const agentRoot = options.agentRoot ?? ((agentName: string) => getAgentRoot(agentName))
  return {
    launch: async (request) => {
      const join = await import("../senses/voice/local-audio-join")
      const control = await import("../senses/voice/local-audio-control")
      const launch = options.launch ?? {
        execPath: process.execPath,
        cliEntry: path.resolve(__dirname, "../heart/daemon/ouro-entry.js"),
        spawn: join.defaultLaunchSpawn(control.localAudioPaths(agentRoot(request.agentName))),
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
        timeoutMs: 300_000,
      }
      return join.launchLocalAudioJoin(request, { agentRoot, ...launch })
    },
    leave: async (agentName) => (await import("../senses/voice/local-audio-join")).runLocalAudioLeave(agentName, { agentRoot }),
    status: async (agentName) => (await import("../senses/voice/local-audio-join")).runLocalAudioStatus(agentName, { agentRoot }),
  }
}

export const voiceLocalAudioToolDefinition: ToolDefinition = createVoiceLocalAudioToolDefinition(defaultLocalAudioToolDeps())
