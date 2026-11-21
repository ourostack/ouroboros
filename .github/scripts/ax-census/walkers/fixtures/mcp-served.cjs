// Built stand-in for a server that serves its annotations from listTools(), not on getToolSchemas(). Its source is mcp-ok.ts.
const schemas = [
  { name: "ask", description: "Ask the agent a question.", inputSchema: { type: "object", properties: {} } },
  { name: "status", description: "The agent's status.", inputSchema: { type: "object", properties: {} } },
  { name: "catchup", description: "What happened while you were away.", inputSchema: { type: "object", properties: {} } },
];
exports.getToolSchemas = () => schemas;
exports.listTools = () => schemas.map((s) => ({ ...s, annotations: { readOnlyHint: s.name === "status" } }));
