// Source stand-in for a server whose getToolSchemas() lists three tools. Read as text by the walker; never run.
export function getToolSchemas() {
  return [
    {
      name: "ask",
      description: "Ask the agent a question.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "status",
      description: "The agent's status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "catchup",
      description: "What happened while you were away.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}
