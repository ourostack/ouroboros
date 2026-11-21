// Source stand-in for a server with one valid tool card and one tool with no card.
export const serverErrors = [{ code: "unknown-door", means: "No tool has that name.", fix: "Call the tool the message names." }];

export function handle(name: string) {
  if (name !== "ask" && name !== "status") return { code: "unknown-door" };
  return { code: "daemon-down" };
}

export function getToolSchemas() {
  return [
    {
      name: "ask",
      description: "Ask the agent a question.",
      inputSchema: { type: "object", properties: {} },
      ax: {
        id: "mcp:ask",
        group: "agent",
        when: "Get one answer from the agent, which may research it with its own tools first.",
        effect: "write",
        errors: [{ code: "daemon-down", means: "The daemon isn't running.", fix: "Run ouro up, then ask again." }],
      },
    },
    { name: "status", description: "The agent's status.", inputSchema: { type: "object", properties: {} } },
  ];
}
