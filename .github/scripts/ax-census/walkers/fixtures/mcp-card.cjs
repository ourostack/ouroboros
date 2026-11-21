// Built stand-in for mcp-card.ts.
exports.getToolSchemas = () => [
  {
    name: "ask",
    description: "Ask the agent a question.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    ax: { id: "mcp:ask", group: "agent", when: "Ask the agent a question and wait for its answer in this turn.", effect: "read", errors: [] },
  },
];
