import type OpenAI from "openai";

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
