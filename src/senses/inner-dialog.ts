import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { sessionPath } from "../heart/config"
import { runAgent, type ChannelCallbacks } from "../heart/core"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { loadSession, postTurn, type UsageData } from "../mind/context"
import { buildSystem } from "../mind/prompt"
import { findNonCanonicalBundlePaths } from "../mind/bundle-manifest"
import { drainPending, getPendingDir } from "../mind/pending"
import { createTraceId } from "../nerves"
import { emitNervesEvent } from "../nerves/runtime"

export interface InnerDialogInstinct {
  id: string
  prompt: string
  enabled?: boolean
}

export interface InnerDialogState {
  cycleCount: number
  resting?: boolean
  lastHeartbeatAt?: string
  checkpoint?: string
}

export interface RunInnerDialogTurnOptions {
  reason?: "boot" | "heartbeat" | "instinct"
  instincts?: InnerDialogInstinct[]
  now?: () => Date
  signal?: AbortSignal
  drainInbox?: () => Array<{ from: string; content: string }>
}

export interface InnerDialogTurnResult {
  messages: OpenAI.ChatCompletionMessageParam[]
  usage?: UsageData
  sessionPath: string
}

const DEFAULT_INNER_DIALOG_INSTINCTS: InnerDialogInstinct[] = [
  {
    id: "heartbeat_checkin",
    prompt: "...time passing. anything stirring?",
    enabled: true,
  },
]

function readAspirations(agentRoot: string): string {
  try {
    return fs.readFileSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"), "utf8").trim()
  } catch {
    return ""
  }
}

export function loadInnerDialogInstincts(): InnerDialogInstinct[] {
  return [...DEFAULT_INNER_DIALOG_INSTINCTS]
}

export function buildInnerDialogBootstrapMessage(_aspirations: string, _stateSummary: string): string {
  return "waking up. settling in.\n\nwhat needs my attention?"
}

export function buildNonCanonicalCleanupNudge(nonCanonicalPaths: string[]): string {
  if (nonCanonicalPaths.length === 0) return ""
  const listed = nonCanonicalPaths.slice(0, 20).map((entry) => `- ${entry}`)
  if (nonCanonicalPaths.length > 20) {
    listed.push(`- ... (${nonCanonicalPaths.length - 20} more)`)
  }
  return [
    "## canonical cleanup nudge",
    "I found non-canonical files in my bundle. I should distill anything valuable into your memory system and remove these files.",
    ...listed,
  ].join("\n")
}

export function buildInstinctUserMessage(
  instincts: InnerDialogInstinct[],
  _reason: "boot" | "heartbeat" | "instinct",
  state: InnerDialogState,
): string {
  const active = instincts.find((instinct) => instinct.enabled !== false) ?? DEFAULT_INNER_DIALOG_INSTINCTS[0]
  const checkpoint = state.checkpoint?.trim()
  const lines = [active.prompt]
  if (checkpoint) {
    lines.push(`\nlast i remember: ${checkpoint}`)
  }
  return lines.join("\n")
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const text = content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text
      }
      return ""
    })
    .join("\n")
  return text.trim()
}

export function deriveResumeCheckpoint(messages: OpenAI.ChatCompletionMessageParam[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
  if (!lastAssistant) return "no prior checkpoint recorded"
  const assistantText = contentToText(lastAssistant.content)
  if (!assistantText) return "no prior checkpoint recorded"

  const explicitCheckpoint = assistantText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^checkpoint\s*:/i.test(line))
  if (explicitCheckpoint) {
    const parsed = explicitCheckpoint.replace(/^checkpoint\s*:\s*/i, "").trim()
    return parsed || "no prior checkpoint recorded"
  }

  const firstLine = assistantText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)[0] as string
  if (firstLine.length <= 220) return firstLine
  return `${firstLine.slice(0, 217)}...`
}

function createInnerDialogCallbacks(): ChannelCallbacks {
  return {
    onModelStart: () => {},
    onModelStreamStart: () => {},
    onTextChunk: () => {},
    onReasoningChunk: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
  }
}

export function innerDialogSessionPath(): string {
  return sessionPath("self", "inner", "dialog")
}

export async function runInnerDialogTurn(options?: RunInnerDialogTurnOptions): Promise<InnerDialogTurnResult> {
  const now = options?.now ?? (() => new Date())
  const reason = options?.reason ?? "heartbeat"
  const sessionFilePath = innerDialogSessionPath()
  const loaded = loadSession(sessionFilePath)
  const messages = loaded?.messages ? [...loaded.messages] : []
  const instincts = options?.instincts ?? loadInnerDialogInstincts()
  const state: InnerDialogState = {
    cycleCount: 1,
    resting: false,
    lastHeartbeatAt: now().toISOString(),
  }

  if (messages.length === 0) {
    const systemPrompt = await buildSystem("inner", { toolChoiceRequired: true })
    messages.push({ role: "system", content: systemPrompt })
    const aspirations = readAspirations(getAgentRoot())
    const nonCanonical = findNonCanonicalBundlePaths(getAgentRoot())
    const cleanupNudge = buildNonCanonicalCleanupNudge(nonCanonical)
    const bootstrapMessage = [
      buildInnerDialogBootstrapMessage(aspirations, "No prior inner dialog session found."),
      cleanupNudge,
    ].filter(Boolean).join("\n\n")
    messages.push({ role: "user", content: bootstrapMessage })
  } else {
    const assistantTurns = messages.filter((message) => message.role === "assistant").length
    state.cycleCount = assistantTurns + 1
    state.checkpoint = deriveResumeCheckpoint(messages)
    const instinctPrompt = buildInstinctUserMessage(instincts, reason, state)
    messages.push({ role: "user", content: instinctPrompt })
  }

  const pendingMessages = drainPending(getPendingDir(getAgentName(), "self", "inner", "dialog"))
  if (pendingMessages.length > 0) {
    const lastUserIdx = messages.length - 1
    const lastUser = messages[lastUserIdx]
    /* v8 ignore next -- defensive: all code paths push a user message before here @preserve */
    if (lastUser?.role === "user" && typeof lastUser.content === "string") {
      const section = pendingMessages
        .map((msg) => `- **${msg.from}**: ${msg.content}`)
        .join("\n")
      messages[lastUserIdx] = {
        ...lastUser,
        content: `${lastUser.content}\n\n## pending messages\n${section}`,
      }
    }
  }

  const inboxMessages = options?.drainInbox?.() ?? []
  if (inboxMessages.length > 0) {
    const lastUserIdx = messages.length - 1
    const lastUser = messages[lastUserIdx]
    /* v8 ignore next -- defensive: all code paths push a user message before here @preserve */
    if (lastUser?.role === "user" && typeof lastUser.content === "string") {
      const section = inboxMessages
        .map((msg) => `- **${msg.from}**: ${msg.content}`)
        .join("\n")
      messages[lastUserIdx] = {
        ...lastUser,
        content: `${lastUser.content}\n\n## incoming messages\n${section}`,
      }
    }
  }

  const callbacks = createInnerDialogCallbacks()
  const traceId = createTraceId()
  const result = await runAgent(messages, callbacks, "inner", options?.signal, {
    traceId,
    toolChoiceRequired: true,
    skipConfirmation: true,
  })

  postTurn(messages, sessionFilePath, result.usage)

  emitNervesEvent({
    component: "senses",
    event: "senses.inner_dialog_turn",
    message: "inner dialog turn completed",
    meta: { reason, session: sessionFilePath },
  })

  return {
    messages,
    usage: result.usage,
    sessionPath: sessionFilePath,
  }
}
