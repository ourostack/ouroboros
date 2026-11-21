// Source stand-in for a server that lists "ask" twice.
export function getToolSchemas() {
  return [{
    name: "ask",
    description: "Ask the agent a question.",
    inputSchema: { type: "object", properties: {} },
  }, {
    name: "status",
    description: "The agent's status.",
    inputSchema: { type: "object", properties: {} },
  }, {
    name: "ask",
    description: "Ask again.",
    inputSchema: { type: "object", properties: {} },
  }];
}
