import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import { withCode, type ChatActions, type ReplyTargetRequest, type SenseChatActions, type ToolContext, type ToolDefinition } from "./tools-base"

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
        return id ? react(emoji, id) : withCode("there is no message to react to here; pass message_id.", "no-message")
      },
    } : {}),
    ...(setReplyTarget ? {
      setReplyTarget: (request: ReplyTargetRequest) => {
        if (request.target !== "thread") return setReplyTarget(request)
        const id = request.messageId ?? inboundMessageId
        return id ? setReplyTarget({ target: "thread", messageId: id }) : withCode("there is no message to reply to here; pass message_id.", "no-message")
      },
    } : {}),
  }
}

/** Chat actions act in the chat the turn came from, so a turn that may not send can't take them, even when called directly. */
export function offTurnRefusal(ctx: ToolContext | undefined): string | undefined {
  return ctx?.noSend || ctx?.habitSession || ctx?.autonomousTurnKind ? withCode("I can't act in a chat on this turn.", "off-turn") : undefined
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
      if (!emoji) return ended("react", false, withCode("emoji is required.", "missing-emoji"))
      const actions = ctx?.chatActions
      if (!actions?.react) return ended("react", false, withCode("this chat doesn't take reactions from me.", "no-reactions"))
      try {
        return ended("react", true, await actions.react(emoji, argText(args.message_id) || undefined))
      } catch (error) {
        return ended("react", false, withCode(`the reaction didn't go through: ${error instanceof Error ? error.message : String(error)}`, "reaction-failed"))
      }
    },
    ax: { id: "tool:react", group: "turn-chat", when: "Pick this to acknowledge or answer someone with a single emoji tap, alone or beside a text reply, when words would be too much.", effect: "write", errors: [
      { code: "missing-emoji", means: "emoji was empty, so there was nothing to react with.", fix: "Call again with emoji set to one emoji, for example 👍." },
      { code: "no-reactions", means: "This chat app doesn't let me add reactions.", fix: "Answer in words instead; a short text reply does the same job here." },
      { code: "reaction-failed", means: "The chat app refused or dropped the reaction; the reason follows the colon.", fix: "Check message_id is a real id from this chat, then try once more or reply in words." },
      { code: "no-message", means: "No message_id was given and this turn has no starting message to react to.", fix: "Call again with message_id set to one of the ids shown in this chat's context." },
      { code: "off-turn", means: "This turn may not send (an autonomous, habit or no-send turn), so nothing happened in the chat.", fix: "Leave the chat alone this turn; act in it on a turn that someone in that chat started." },
    ] },
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
      if (!actions?.setReplyTarget) return ended("set_reply_target", false, withCode("this chat doesn't let me choose where a reply lands.", "no-reply-choice"))
      let request: ReplyTargetRequest
      if (target === "current_lane" || target === "top_level") {
        request = { target }
      } else if (target === "thread") {
        const messageId = argText(args.message_id)
        request = messageId ? { target, messageId } : { target }
      } else {
        return ended("set_reply_target", false, withCode("target must be one of: current_lane, top_level, thread.", "invalid-target"))
      }
      return ended("set_reply_target", true, actions.setReplyTarget(request))
    },
    ax: { id: "tool:set_reply_target", group: "turn-chat", when: "Pick this before you settle, to thread the reply under one message, post it top-level, or go back to this chat's usual lane.", effect: "write", idempotent: true, errors: [
      { code: "no-reply-choice", means: "This chat app gives me no choice of where a reply lands.", fix: "Just send the reply; it lands where this chat always puts it." },
      { code: "invalid-target", means: "target wasn't current_lane, top_level or thread.", fix: "Call again with target set to current_lane, top_level or thread." },
      { code: "no-message", means: "No message_id was given and this turn has no starting message to reply to.", fix: "Call again with message_id set to one of the ids shown in this chat's context." },
      { code: "off-turn", means: "This turn may not send (an autonomous, habit or no-send turn), so nothing happened in the chat.", fix: "Leave the chat alone this turn; act in it on a turn that someone in that chat started." },
    ] },
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
      if (!filePath.startsWith("/")) throw new Error(withCode("path must be an absolute path to a file.", "relative-path"))
      const actions = ctx?.chatActions
      if (!actions?.sendFile) throw new Error(withCode("this chat doesn't take files from me.", "no-files"))
      return actions.sendFile(filePath, typeof args.caption === "string" ? args.caption : "")
    },
    ax: { id: "tool:send_file", group: "turn-chat", when: "Pick this to hand someone an actual photo, PDF or document stored on disk; for a link or a few lines of text, just reply.", effect: "write", errors: [
      { code: "relative-path", means: "path didn't start with /, so I can't tell which file you mean.", fix: "Call again with the file's absolute path, such as /Users/me/menu.pdf." },
      { code: "no-files", means: "This chat app doesn't take files from me.", fix: "Describe the file in your reply, or tell them where it is on disk." },
      { code: "off-turn", means: "This turn may not send (an autonomous, habit or no-send turn), so nothing happened in the chat.", fix: "Leave the chat alone this turn; act in it on a turn that someone in that chat started." },
    ] },
    summaryKeys: ["path"],
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends a local file into the current chat" },
  },
]
