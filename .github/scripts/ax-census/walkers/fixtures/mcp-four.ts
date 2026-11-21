// Source stand-in for mcp-ok.ts with a fourth tool that has no card.
export function getToolSchemas() {
  return [
    { name: "ask", description: "Ask the agent a question.", inputSchema: { type: "object", properties: {} } },
    { name: "status", description: "The agent's status.", inputSchema: { type: "object", properties: {} } },
    { name: "catchup", description: "What happened while you were away.", inputSchema: { type: "object", properties: {} } },
    { name: "delegate", description: "Hand a task to the agent.", inputSchema: { type: "object", properties: {} } },
  ];
}
