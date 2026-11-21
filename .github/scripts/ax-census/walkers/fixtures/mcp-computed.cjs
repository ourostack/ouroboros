// Built stand-in for mcp-computed.ts.
exports.getToolSchemas = () => [
  { name: "ask", description: "Ask the agent a question.", inputSchema: { type: "object", properties: {} } },
  { name: "check_response", description: "Check for a reply.", inputSchema: { type: "object", properties: {} } },
];
