import type OpenAI from "openai";

export const ponderTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "ponder",
    description: "i need to sit with this. from a conversation, takes the thread inward with a thought and a parting word. from inner dialog, keeps the wheel turning for another pass. must be the only tool call in the turn. Use when a question deserves more thought than this turn allows. Don't ponder trivial questions.",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "the question or thread that needs more thought — brief framing, not analysis. required from a conversation, ignored from inner dialog.",
        },
        say: {
          type: "string",
          description: "what you say before going quiet — speak to what caught your attention, not just that something did. required from a conversation, ignored from inner dialog.",
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
      "respond to the user with your message. call this tool when you are ready to deliver your response. Only call when you have a substantive response. If you're settling with 'I'll look into that,' you probably should be using a tool instead.",
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
    description: "put this down for now — the wheel stops until the next heartbeat. must be the only tool call in the turn.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};
