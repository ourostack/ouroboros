import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { sessionPath } from "../heart/config"
import { runAgent, type ChannelCallbacks } from "../heart/core"
import { getAgentName, getAgentRoot } from "../heart/identity"
import { loadSession, postTurn, type UsageData } from "../mind/context"
import { buildSystem } from "../mind/prompt"
import { findNonCanonicalBundlePaths } from "../mind/bundle-manifest"
import { drainPending, getInnerDialogPendingDir, INNER_DIALOG_PENDING } from "../mind/pending"
import { getChannelCapabilities } from "../mind/friends/channel"
import { enforceTrustGate } from "./trust-gate"
import { accumulateFriendTokens } from "../mind/friends/tokens"
import { handleInboundTurn } from "./pipeline"
import { createTraceId } from "../nerves"
import { emitNervesEvent } from "../nerves/runtime"
import type { FriendRecord, ResolvedContext } from "../mind/friends/types"
import type { FriendStore } from "../mind/friends/store"

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
  taskId?: string
  instincts?: InnerDialogInstinct[]
  now?: () => Date
  signal?: AbortSignal
}

export interface InnerDialogTurnResult {
  messages: OpenAI.ChatCompletionMessageParam[]
  usage?: UsageData
  sessionPath: string
}

interface InnerDialogRuntimeState {
  status: "idle" | "running"
  reason?: "boot" | "heartbeat" | "instinct"
  startedAt?: string
  lastCompletedAt?: string
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

export function buildInnerDialogBootstrapMessage(aspirations: string, stateSummary: string): string {
  const lines = ["waking up."]
  if (aspirations) {
    lines.push("", "## what matters to me", aspirations)
  }
  if (stateSummary) {
    lines.push("", "## what i know so far", stateSummary)
  }
  lines.push("", "what needs my attention?")
  return lines.join("\n")
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

export function readTaskFile(agentRoot: string, taskId: string): string {
  // Task files live in collection subdirectories (one-shots, ongoing, habits).
  // Try each collection, then fall back to root tasks/ for legacy layout.
  const collections = ["one-shots", "ongoing", "habits", ""]
  for (const collection of collections) {
    try {
      return fs.readFileSync(path.join(agentRoot, "tasks", collection, `${taskId}.md`), "utf8").trim()
    } catch {
      // not in this collection — try next
    }
  }
  return ""
}

export function buildTaskTriggeredMessage(taskId: string, taskContent: string, checkpoint?: string): string {
  const lines = ["a task needs my attention."]
  if (taskContent) {
    lines.push("", `## task: ${taskId}`, taskContent)
  } else {
    lines.push("", `## task: ${taskId}`, "(task file not found)")
  }
  if (checkpoint) {
    lines.push("", `last i remember: ${checkpoint}`)
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
    .find((line) => line.length > 0)
  /* v8 ignore next -- unreachable: contentToText().trim() guarantees a non-empty line @preserve */
  if (!firstLine) return "no prior checkpoint recorded"
  if (firstLine.length <= 220) return firstLine
  return `${firstLine.slice(0, 217)}...`
}

function extractAssistantPreview(messages: OpenAI.ChatCompletionMessageParam[], maxLength = 120): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  if (!lastAssistant) return ""
  const text = contentToText(lastAssistant.content)
  if (!text) return ""
  /* v8 ignore next -- unreachable: contentToText().trim() guarantees a non-empty line @preserve */
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (firstLine.length <= maxLength) return firstLine
  return `${firstLine.slice(0, maxLength - 3)}...`
}

function extractToolCallNames(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  const names: string[] = []
  for (const msg of messages) {
    if (msg.role === "assistant" && "tool_calls" in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if ("function" in tc && tc.function?.name) names.push(tc.function.name)
      }
    }
  }
  return [...new Set(names)]
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
  return sessionPath(INNER_DIALOG_PENDING.friendId, INNER_DIALOG_PENDING.channel, INNER_DIALOG_PENDING.key)
}

function innerDialogRuntimeStatePath(sessionFilePath: string): string {
  return path.join(path.dirname(sessionFilePath), "runtime.json")
}

function writeInnerDialogRuntimeState(sessionFilePath: string, state: InnerDialogRuntimeState): void {
  const filePath = innerDialogRuntimeStatePath(sessionFilePath)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf8")
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.inner_dialog_runtime_state_error",
      message: "failed to write inner dialog runtime state",
      meta: {
        status: state.status,
        reason: state.reason ?? null,
        path: filePath,
        /* v8 ignore next -- Node fs APIs throw Error objects for mkdirSync/writeFileSync failures @preserve */
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

// Self-referencing friend record for inner dialog (agent talking to itself).
// No real friend to resolve -- this satisfies the pipeline's friend resolver contract.
function createSelfFriend(agentName: string): FriendRecord {
  return {
    id: "self",
    name: agentName,
    trustLevel: "family",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  }
}

// No-op friend store for inner dialog. Inner dialog doesn't track token usage per-friend.
function createNoOpFriendStore(): FriendStore {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    findByExternalId: async () => null,
  }
}

export async function runInnerDialogTurn(options?: RunInnerDialogTurnOptions): Promise<InnerDialogTurnResult> {
  const now = options?.now ?? (() => new Date())
  const reason = options?.reason ?? "heartbeat"
  const sessionFilePath = innerDialogSessionPath()
  writeInnerDialogRuntimeState(sessionFilePath, {
    status: "running",
    reason,
    startedAt: now().toISOString(),
  })

  try {
  const loaded = loadSession(sessionFilePath)
  const existingMessages = loaded?.messages ? [...loaded.messages] : []
  const instincts = options?.instincts ?? loadInnerDialogInstincts()
  const state: InnerDialogState = {
    cycleCount: 1,
    resting: false,
    lastHeartbeatAt: now().toISOString(),
  }

  // ── Adapter concern: build user message ──────────────────────────
  let userContent: string

  if (existingMessages.length === 0) {
    // Fresh session: bootstrap message with non-canonical cleanup nudge
    const aspirations = readAspirations(getAgentRoot())
    const nonCanonical = findNonCanonicalBundlePaths(getAgentRoot())
    const cleanupNudge = buildNonCanonicalCleanupNudge(nonCanonical)
    userContent = [
      buildInnerDialogBootstrapMessage(aspirations, "No prior inner dialog session found."),
      cleanupNudge,
    ].filter(Boolean).join("\n\n")
  } else {
    // Resumed session: task-triggered or instinct message with checkpoint context
    const assistantTurns = existingMessages.filter((message) => message.role === "assistant").length
    state.cycleCount = assistantTurns + 1
    state.checkpoint = deriveResumeCheckpoint(existingMessages)

    if (options?.taskId) {
      const taskContent = readTaskFile(getAgentRoot(), options.taskId)
      userContent = buildTaskTriggeredMessage(options.taskId, taskContent, state.checkpoint)
    } else {
      userContent = buildInstinctUserMessage(instincts, reason, state)
    }
  }

  const userMessage: OpenAI.ChatCompletionMessageParam = { role: "user", content: userContent }

  // ── Session loader: wraps existing session logic ──────────────────
  const innerCapabilities = getChannelCapabilities("inner")
  const pendingDir = getInnerDialogPendingDir(getAgentName())
  const selfFriend = createSelfFriend(getAgentName())
  const selfContext: ResolvedContext = { friend: selfFriend, channel: innerCapabilities }

  const sessionLoader = {
    loadOrCreate: async () => {
      if (existingMessages.length > 0) {
        return { messages: existingMessages, sessionPath: sessionFilePath }
      }
      // Fresh session: build system prompt
      const systemPrompt = await buildSystem("inner", { toolChoiceRequired: true })
      return {
        messages: [{ role: "system" as const, content: systemPrompt }],
        sessionPath: sessionFilePath,
      }
    },
  }

  // ── Call shared pipeline ──────────────────────────────────────────
  const callbacks = createInnerDialogCallbacks()
  const traceId = createTraceId()

  const result = await handleInboundTurn({
    channel: "inner",
    capabilities: innerCapabilities,
    messages: [userMessage],
    continuityIngressTexts: [],
    callbacks,
    friendResolver: { resolve: () => Promise.resolve(selfContext) },
    sessionLoader,
    pendingDir,
    friendStore: createNoOpFriendStore(),
    enforceTrustGate,
    drainPending,
    runAgent,
    postTurn,
    accumulateFriendTokens,
    signal: options?.signal,
    runAgentOptions: {
      traceId,
      toolChoiceRequired: true,
      skipConfirmation: true,
    },
  })

  const resultMessages = result.messages ?? []
  const assistantPreview = extractAssistantPreview(resultMessages)
  const toolCalls = extractToolCallNames(resultMessages)

  emitNervesEvent({
    component: "senses",
    event: "senses.inner_dialog_turn",
    message: "inner dialog turn completed",
    meta: {
      reason,
      session: sessionFilePath,
      ...(options?.taskId && { taskId: options.taskId }),
      ...(assistantPreview && { assistantPreview }),
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(result.usage && {
        promptTokens: result.usage.input_tokens,
        completionTokens: result.usage.output_tokens,
        totalTokens: result.usage.total_tokens,
      }),
    },
  })

  return {
    messages: resultMessages,
    usage: result.usage,
    sessionPath: result.sessionPath ?? sessionFilePath,
  }
  } finally {
    writeInnerDialogRuntimeState(sessionFilePath, {
      status: "idle",
      lastCompletedAt: now().toISOString(),
    })
  }
}
