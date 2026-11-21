// Built stand-in for mcp-helper-card.ts.
exports.serverErrors = [{ code: "unknown-door", means: "No tool has that name.", fix: "Call the tool the message names." }];
exports.getToolSchemas = () => [
  {
    name: "ask",
    description: "Ask the agent a question.",
    inputSchema: { type: "object", properties: {} },
    ax: { id: "mcp:ask", group: "agent", when: "Get one answer from the agent, which may research it first.", effect: "write", errors: [{ code: "turn-failed", means: "The turn failed.", fix: "Call ask again." }] },
  },
];
