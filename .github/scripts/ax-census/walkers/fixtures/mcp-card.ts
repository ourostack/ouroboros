// Source stand-in for a server whose one tool carries an ax card and a served read-only hint.
export const serverErrors = [{ code: "unknown-door", means: "No tool has that name.", fix: "Call the tool the message names." }];
export const unknownTool = { code: "unknown-door" };
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
