// Source stand-in for a server whose error cards are built by a helper outside the ax property; nothing raises them.
export const serverErrors = [{ code: "unknown-door", means: "No tool has that name.", fix: "Call the tool the message names." }];
export const unknownTool = { code: "unknown-door" };

function turnErrors(tool: string) {
  return [{ code: "turn-failed", means: "The turn failed.", fix: `Call ${tool} again.` }];
}

export function getToolSchemas() {
  return [
    {
      name: "ask",
      description: "Ask the agent a question.",
      inputSchema: { type: "object", properties: {} },
      ax: { id: "mcp:ask", group: "agent", when: "Get one answer from the agent, which may research it first.", effect: "write", errors: turnErrors("ask") },
    },
  ];
}
