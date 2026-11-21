// Built stand-in for a server whose one tool has an ax card with a null error entry. Its source is mcp-ok.ts.
exports.getToolSchemas = () => [
  { name: "ask", description: "Ask the agent a question.", inputSchema: { type: "object", properties: {} }, ax: { id: "mcp:ask", group: "agent", when: "Ask the agent a question and wait for its answer in this turn.", effect: "read", errors: [null] } },
];
