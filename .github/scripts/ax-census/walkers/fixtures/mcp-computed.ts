// Source stand-in for a server whose tool name comes from a constant and a template.
const ASK = "ask";
const prefix = "check";
export function getToolSchemas() {
  return [
    { name: ASK, description: "Ask the agent a question.", inputSchema: { type: "object", properties: {} } },
    { name: `${prefix}_response`, description: "Check for a reply.", inputSchema: { type: "object", properties: {} } },
  ];
}
