import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { ChatActions, ReplyTargetRequest, SenseChatActions, ToolContext, ToolDefinition } from "./tools-base"

// Every chat app lets you react to a message, reply to a specific one and send a file. These tools are the same on
// every sense; each sense binds `ctx.chatActions` to its own app, and a missing action means the app can't do it.

const MESSAGING_APPS: ReadonlySet<string> = new Set(["bluebubbles", "telegram"])
/**
 * Tools that act in the chat the turn came from, and the senses whose turns bind them. They are offered only there,
 * and only when the turn may send. Teams can't add reactions and already replies to the activity, but it takes files.
 */
export const CHAT_ACTION_TOOL_CHANNELS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["react", MESSAGING_APPS],
  ["set_reply_target", MESSAGING_APPS],
  ["send_file", new Set([...MESSAGING_APPS, "teams"])],
])

/**
 * Binds a sense's chat actions to the turn: a left-out message id means the message that started it. The id stays
 * inside these closures, so it never sits in the tool context as data.
 */
export function chatActionsForTurn(actions: SenseChatActions, inboundMessageId: string | undefined): ChatActions {
  const { react, setReplyTarget, sendFile } = actions
  return {
    ...(sendFile ? { sendFile } : {}),
    ...(react ? {
      react: async (emoji: string, messageId?: string) => {
        const id = messageId ?? inboundMessageId
        return id ? react(emoji, id) : "there is no message to react to here; pass message_id."
      },
    } : {}),
    ...(setReplyTarget ? {
      setReplyTarget: (request: ReplyTargetRequest) => {
        if (request.target !== "thread") return setReplyTarget(request)
        const id = request.messageId ?? inboundMessageId
        return id ? setReplyTarget({ target: "thread", messageId: id }) : "there is no message to reply to here; pass message_id."
      },
    } : {}),
  }
}

/** Chat actions act in the chat the turn came from, so a turn that may not send can't take them, even when called directly. */
export function offTurnRefusal(ctx: ToolContext | undefined): string | undefined {
  return ctx?.noSend || ctx?.habitSession || ctx?.autonomousTurnKind ? "I can't act in a chat on this turn." : undefined
}

function argText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function ended(tool: string, success: boolean, result: string): string {
  if (success) emitNervesEvent({ component: "tools", event: "tool.end", message: `${tool} done`, meta: { tool, success } })
  else emitNervesEvent({ level: "warn", component: "tools", event: "tool.error", message: `${tool} refused`, meta: { tool, success } })
  return result
}

export const chatToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "react",
        description:
          "react to a message in this chat with an emoji. message_id defaults to the message that started this turn. a reaction can be the whole answer.",
        parameters: {
          type: "object",
          properties: {
            emoji: { type: "string", description: "one emoji, for example ❤️ or 👍." },
            message_id: { type: "string", description: "the message to react to; leave out to react to the message that started this turn." },
          },
          required: ["emoji"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: async (args, ctx) => {
      const refusal = offTurnRefusal(ctx)
      if (refusal) return ended("react", false, refusal)
      const emoji = argText(args.emoji)
      if (!emoji) return ended("react", false, "emoji is required.")
      const actions = ctx?.chatActions
      if (!actions?.react) return ended("react", false, "this chat doesn't take reactions from me.")
      try {
        return ended("react", true, await actions.react(emoji, argText(args.message_id) || undefined))
      } catch (error) {
        return ended("react", false, `the reaction didn't go through: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    summaryKeys: ["emoji", "message_id"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "adds a reaction in the current chat" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "set_reply_target",
        description:
          "choose where my reply in this chat lands: current_lane (the default for this chat), top_level (the main chat, not a reply), or thread (a reply to message_id, or to the message that started this turn).",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["current_lane", "top_level", "thread"] },
            message_id: { type: "string", description: "with target=thread: the message to reply to, from the ids shown in this chat's context; leave out to reply to the message that started this turn." },
          },
          required: ["target"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    handler: (args, ctx) => {
      const refusal = offTurnRefusal(ctx)
      if (refusal) return ended("set_reply_target", false, refusal)
      const target = argText(args.target)
      const actions = ctx?.chatActions
      if (!actions?.setReplyTarget) return ended("set_reply_target", false, "this chat doesn't let me choose where a reply lands.")
      let request: ReplyTargetRequest
      if (target === "current_lane" || target === "top_level") {
        request = { target }
      } else if (target === "thread") {
        const messageId = argText(args.message_id)
        request = messageId ? { target, messageId } : { target }
      } else {
        return ended("set_reply_target", false, "target must be one of: current_lane, top_level, thread.")
      }
      return ended("set_reply_target", true, actions.setReplyTarget(request))
    },
    summaryKeys: ["target", "message_id"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "changes where the reply in the current chat lands" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "send_file",
        description:
          "send a file from this machine into this chat, with an optional caption. images show inline; other files arrive as documents where the app takes them.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "absolute path to the file." },
            caption: { type: "string", description: "optional text sent with the file." },
          },
          required: ["path"],
        },
      },
    } satisfies OpenAI.ChatCompletionFunctionTool,
    // A file that didn't go through throws, so the turn records the send as failed rather than done.
    handler: async (args, ctx) => {
      const refusal = offTurnRefusal(ctx)
      if (refusal) throw new Error(refusal)
      const filePath = argText(args.path)
      if (!filePath.startsWith("/")) throw new Error("path must be an absolute path to a file.")
      const actions = ctx?.chatActions
      if (!actions?.sendFile) throw new Error("this chat doesn't take files from me.")
      return actions.sendFile(filePath, typeof args.caption === "string" ? args.caption : "")
    },
    summaryKeys: ["path"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends a local file into the current chat" },
  },
]
