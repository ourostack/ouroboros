// Source stand-in for a server whose unknown-door card is declared but never raised.
export const serverErrors = [{ code: "unknown-door", means: "No tool has that name.", fix: "Call the tool the message names." }];

export function getToolSchemas() {
  return [
    {
      name: "ask",
      description: "Ask the agent a question.",
      inputSchema: { type: "object", properties: {} },
      ax: { id: "mcp:ask", group: "agent", when: "Ask the agent a question and wait for its answer in this turn.", effect: "write", errors: [] },
    },
  ];
}
