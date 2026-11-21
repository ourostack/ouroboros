// Source stand-in for a server whose one tool carries an ax card and a served read-only hint.
export function getToolSchemas() {
  return [
    {
      name: "ask",
      description: "Ask the agent a question.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      ax: { id: "mcp:ask", group: "agent", when: "Ask the agent a question and wait for its answer in this turn.", effect: "read", errors: [] },
    },
  ];
}
