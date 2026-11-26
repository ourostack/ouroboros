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

/** What settle does. A turn's progress goes through speak; settle is the turn's end. */
export const SETTLE_DESCRIPTION = "delivers answer to the person and ends the turn, handing control back to them. it is the move for finished work, a real block, a question from them that needs an answer now, or a confirmation, stop or pause point. feedback that arrives during active work is input to the loop, and progress while i keep working goes through speak. an answer like 'I'll look into that' means a tool call is the next step. when the block is a missing tool (not a missing answer from them), report_failure tells the engineers about the gap, and settle with intent blocked ends the turn." as const

export const settleTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "settle",
    description: SETTLE_DESCRIPTION,
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

/** How often a check-back filed by settle is looked at again after its time, until it is resolved or canceled. */
export const SETTLE_CHECK_BACK_CADENCE = "1d" as const

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
    description: "end a private-runtime turn when private work is complete. rest remains the explicit terminal move for the private-runtime turn and must be the only tool call in the turn. on idle heartbeat turns, use status=HEARTBEAT_OK; a tool line starting ACT: needs a send_message first.",
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
  settleCheckBackIncomplete: withCode("settle takes check_back_at and condition together: give both to leave a check-back, or neither. nothing was sent.", "check-back-incomplete"),
  settleCheckBackNotFiled: (detail: string): string => withCode(`settle couldn't leave the check-back: ${detail}. nothing was sent; fix it and settle again, or settle without check_back_at.`, "check-back-not-filed"),
  settleHeldWork: withCode("current held-work frame still has unsurfaced items — return each listed item with surface(delegationId=...) before you settle. Older transcript claims are historical; only the current held-work frame is the gate.", "held-work-unsurfaced"),
  restHeldWork: withCode("current held-work frame still has unsurfaced items — return each listed item with surface(delegationId=...) before you rest. Older transcript claims are historical; only the current held-work frame is the gate.", "held-work-unsurfaced"),
  restFreshWork: withCode("fresh work arrived for me this turn — inspect the pending messages above and take the next concrete action before you rest.", "fresh-work-pending"),
  restActUnanswered: (lines: string): string => withCode(`a tool this turn printed work for me to act on and tell someone about, and nobody has been told:\n${lines}\ndo it and send_message the person now, then rest.`, "act-unanswered"),
  restSurfaceNotSent: (surfaceResult: string): string => withCode(`your surface this turn did not reach them: ${surfaceResult.replace(/ \(code: [a-z0-9-]+\)$/u, "").replace(/\.$/u, "")}. reach them another way now if the result names one, or rest again and it waits for their next message.`, "surface-not-sent"),
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
    { code: "check-back-incomplete", means: "settle had check_back_at or condition but not both, so nothing was sent.", fix: "Give both to leave a check-back, or neither." },
    { code: "check-back-not-filed", means: "The check-back couldn't be filed (the reason is in the reply), so nothing was sent.", fix: "Fix what the reply names, such as the time's format, then settle again, or settle without check_back_at." },
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
    { code: "act-unanswered", means: "A tool result this turn printed ACT: lines and no send reached anyone after them, so rest waits once.", fix: "Do what the ACT: lines say, send_message the person, then rest." },
    { code: "surface-not-sent", means: "A surface this turn came back not sent (saved for the person's next message), so rest waits once.", fix: "Reach them another way if the surface result names one, or rest again and it waits for their next message." },
  ] },
  { id: "tool:ponder", group: "turn-flow", when: "Pick this when a question needs more thought than this turn allows, or harness friction should be worked on privately later.", effect: "write", errors: [
    { code: "ponder-fields-missing", means: "A field ponder needs was missing, or payload_json was not a JSON object.", fix: "Call ponder again with kind, objective, success_criteria and payload_json, plus packet_id to revise." },
    { code: "held-work-unsurfaced", means: "This private turn already holds work someone is waiting on, so no new packet was made.", fix: "Return the held item with surface(delegationId=...) instead of pondering a replacement." },
  ] },
]
