import type OpenAI from "openai";
import type { ToolDoorCard } from "./tools-base";
import { withCode } from "./tool-error-code";

export const ponderTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "ponder",
    description: "create or revise a ponder packet: harness friction, research, or reflection that should survive this turn. when asked to think privately and return later from an outward session, keep literal return tokens and constraints in payload_json or success_criteria, then only acknowledge that the private pass is queued. in private runtime it only preserves state; surface an existing held item instead of pondering a replacement. does not end the turn. not for trivial questions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "revise"],
          description: "create, or revise a drafting packet",
        },
        kind: {
          type: "string",
          enum: ["harness_friction", "research", "reflection"],
          description: "packet kind",
        },
        packet_id: {
          type: "string",
          description: "for revise",
        },
        follows_packet_id: {
          type: "string",
          description: "earlier packet this follows from",
        },
        objective: {
          type: "string",
          description: "durable objective",
        },
        summary: {
          type: "string",
          description: "brief factual summary",
        },
        success_criteria: {
          type: "string",
          description: "newline-delimited bullets",
        },
        payload_json: {
          type: "string",
          description: "JSON object: exact markers, return wording or constraints the private pass must keep ({} if none)",
        },
        thought: {
          type: "string",
          description: "deprecated: becomes a reflection packet",
        },
        say: {
          type: "string",
          description: "deprecated: no effect",
        },
      },
    },
  },
};

export const observeTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "observe",
    description: "absorb what happened without responding — the moment doesn't call for words. must be the only tool call in the turn.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "brief reason for staying silent (for logging)" },
      },
    },
  },
};

export const settleTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "settle",
    description:
      "deliver your response and end your turn — this hands control back to the user. only settle when your work is complete, you're genuinely blocked, the user asked a direct question that needs an answer now, or a required confirmation/stop/pause boundary is reached. process feedback during active work is loop input, not a settle reason. do not settle with status updates mid-task. if you're settling with 'I'll look into that,' you probably should be using a tool instead.",
    parameters: {
      type: "object",
      properties: {
        answer: { type: "string" },
        intent: { type: "string", enum: ["complete", "blocked", "direct_reply"] },
      },
      required: ["answer"],
    },
  },
};

export const speakTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "speak",
    description: "i speak to send words to my friend mid-turn without ending it. for progress, acknowledgment, or phase-boundary updates during heavy work. after speaking, continue with tools unless the next step needs a reply. i settle when my work is done or i need a reply.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "the words i'm sending to my friend right now" },
      },
      required: ["message"],
    },
  },
};

export const restTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "rest",
    description: "end a private-runtime turn when private work is complete. rest remains the explicit terminal move for the private-runtime turn and must be the only tool call in the turn. on idle heartbeat turns, use status=HEARTBEAT_OK.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "optional rest status. use HEARTBEAT_OK when the heartbeat fires and there is nothing to do.",
        },
        note: {
          type: "string",
          description: "optional brief note about why i'm resting.",
        },
      },
    },
  },
};

/**
 * The engine's refusals for the flow tools above, which it handles itself rather than through a definition's handler.
 * Each ends with the code its card below names; they live here so the census finds each code beside its tool.
 */
export const FLOW_TOOL_REFUSALS = {
  settleAlone: withCode("rejected: settle must be the only tool call. finish your work first, then call settle alone.", "settle-alone"),
  observeAlone: withCode("rejected: observe must be the only tool call. call observe alone when you want to stay silent.", "observe-alone"),
  restAlone: withCode("rejected: rest must be the only tool call. finish your work first, then call rest alone.", "rest-alone"),
  settleHeldWork: withCode("current held-work frame still has unsurfaced items — return each listed item with surface(delegationId=...) before you settle. Older transcript claims are historical; only the current held-work frame is the gate.", "held-work-unsurfaced"),
  restHeldWork: withCode("current held-work frame still has unsurfaced items — return each listed item with surface(delegationId=...) before you rest. Older transcript claims are historical; only the current held-work frame is the gate.", "held-work-unsurfaced"),
  restFreshWork: withCode("fresh work arrived for me this turn — inspect the pending messages above and take the next concrete action before you rest.", "fresh-work-pending"),
  speakEmpty: withCode("speak requires a non-empty `message` string.", "empty-message"),
  speakNotDelivered: (detail: string): string => withCode(`speak delivery failed: ${detail}. the message did not reach your friend; do not assume they saw it.`, "speak-not-delivered"),
  ponderCreateIncomplete: withCode("ponder create requires kind, objective, success_criteria, and valid payload_json.", "ponder-fields-missing"),
  ponderReviseIncomplete: withCode("ponder revise requires packet_id, kind, objective, success_criteria, and valid payload_json.", "ponder-fields-missing"),
  ponderHeldWork: withCode("private runtime already has held return work in the attention queue; surface the existing delegationId instead of creating a replacement ponder packet.", "held-work-unsurfaced"),
}

/** The flow tools' Ouro AX cards. The schemas above are bare (the engine runs them), so the census reads cards here. */
export const toolCards: ToolDoorCard[] = [
  { id: "tool:settle", group: "turn-flow", when: "Pick this to give your final answer and hand the turn back: the work is done, you're blocked, or the person asked something that needs an answer now. For progress while you keep working, use speak.", effect: "write", errors: [
    { code: "settle-alone", means: "settle came in one batch with other tool calls, so nothing in the batch ran.", fix: "Make the other calls first, read their results, then call settle on its own." },
  ] },
  { id: "tool:speak", group: "turn-flow", when: "Pick this to tell the person something now, like progress on long work, while you keep working; settle gives the final answer.", effect: "write", errors: [
    { code: "empty-message", means: "The message was empty, so nothing was sent.", fix: "Call speak again with the words you mean to send." },
    { code: "speak-not-delivered", means: "The channel failed to deliver the message, so the person has not seen it.", fix: "Say it again in your settle answer, or retry speak once if the failure looks brief." },
  ] },
  { id: "tool:observe", group: "turn-flow", when: "Pick this in a group chat or passing moment where a reply would add nothing, to end the turn and stay quiet.", effect: "write", errors: [
    { code: "observe-alone", means: "observe came in one batch with other tool calls, so nothing in the batch ran.", fix: "Make the other calls first, read their results, then call observe on its own, or settle if you do mean to reply." },
  ] },
  { id: "tool:rest", group: "turn-flow", when: "Pick this to close a private turn once nothing is left to do there; outward chats end with settle instead.", effect: "write", errors: [
    { code: "rest-alone", means: "rest came in one batch with other tool calls, so nothing in the batch ran.", fix: "Make the other calls first, read their results, then call rest on its own." },
    { code: "held-work-unsurfaced", means: "This private turn still holds work someone is waiting on.", fix: "Return each listed item with surface(delegationId=...), then rest." },
    { code: "fresh-work-pending", means: "New messages arrived during this turn, so rest waits once.", fix: "Read the pending messages and act on them, then rest." },
  ] },
  { id: "tool:ponder", group: "turn-flow", when: "Pick this when a question needs more thought than this turn allows, or harness friction should be worked on privately later.", effect: "write", errors: [
    { code: "ponder-fields-missing", means: "A field ponder needs was missing, or payload_json was not a JSON object.", fix: "Call ponder again with kind, objective, success_criteria and payload_json, plus packet_id to revise." },
    { code: "held-work-unsurfaced", means: "This private turn already holds work someone is waiting on, so no new packet was made.", fix: "Return the held item with surface(delegationId=...) instead of pondering a replacement." },
  ] },
]
