// Source stand-in for a declared server: one error code is raised in the handler, one only appears in the card.
export const serverErrors = [{ code: "unknown-door", means: "No tool has that name.", fix: "Call the tool the message names." }];

export function handle(name: string) {
  if (name !== "ask") return { error: { code: -32602, data: { code: "unknown-door" } } };
  return { isError: true, code: "daemon-down" };
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
        when: "Ask the agent a question and wait for its answer in this turn.",
        effect: "write",
        errors: [
          { code: "daemon-down", means: "The daemon isn't running.", fix: "Run ouro up." },
          { code: "never-raised", means: "Nothing raises this.", fix: "Remove it." },
        ],
      },
    },
  ];
}
