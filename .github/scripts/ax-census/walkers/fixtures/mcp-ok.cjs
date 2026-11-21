// Built stand-in for mcp-ok.ts.
exports.getToolSchemas = () => [
  { name: "ask", description: "Ask the agent a question.", inputSchema: { type: "object", properties: {} } },
  { name: "status", description: "The agent's status.", inputSchema: { type: "object", properties: {} } },
  { name: "catchup", description: "What happened while you were away.", inputSchema: { type: "object", properties: {} } },
];
