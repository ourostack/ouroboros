import type OpenAI from "openai";

export const ponderTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "ponder",
    description: "create or revise a typed ponder packet so i don't lose the plot while i keep working. use this for harness friction, research, or reflection that should survive the current turn. ponder does not end the turn, does not defer the response by itself, and may be followed by more tools before i settle or rest. Don't ponder trivial questions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "revise"],
          description: "create a new packet or revise an existing drafting packet.",
        },
        kind: {
          type: "string",
          enum: ["harness_friction", "research", "reflection"],
          description: "the packet kind. determines the SOP the inner session should follow.",
        },
        packet_id: {
          type: "string",
          description: "required for action=revise. the packet to revise in place.",
        },
        follows_packet_id: {
          type: "string",
          description: "optional follow-up linkage when a new packet grows out of an earlier one.",
        },
        objective: {
          type: "string",
          description: "the durable objective for this packet.",
        },
        summary: {
          type: "string",
          description: "brief factual summary of the work object or friction being preserved.",
        },
        success_criteria: {
          type: "string",
          description: "newline-delimited success criteria bullets.",
        },
        payload_json: {
          type: "string",
          description: "JSON object string with packet-specific structured details. use {} when empty.",
        },
        thought: {
          type: "string",
          description: "deprecated compatibility field. legacy thought text is normalized into a reflection packet.",
        },
        say: {
          type: "string",
          description: "deprecated compatibility field. retained for migration only; it no longer controls deferral or silence.",
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
      "deliver your response and end your turn — this hands control back to the user. only settle when your work is complete, you're genuinely blocked, or the user asked a direct question that needs an answer now. do not settle with status updates mid-task. if you're settling with 'I'll look into that,' you probably should be using a tool instead.",
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

export const restTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "rest",
    description: "end an inner-session turn when i'm done thinking. rest remains the explicit terminal move for the inner session and must be the only tool call in the turn. on idle heartbeat turns, use status=HEARTBEAT_OK.",
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
