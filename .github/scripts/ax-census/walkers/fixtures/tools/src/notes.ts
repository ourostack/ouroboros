// Literal names, `as const`, a const name, a tool call record and a static or resolver risk profile.
const PING = "ping"

export const noteTools = [
  {
    tool: { type: "function", function: { name: "read_note", description: "Read one note.", parameters: {} } },
    handler: (args: { id: string }) => (args.id ? "note" : JSON.stringify({ error: "no such note", code: "note-missing" })),
    riskProfile: { mutates: "none", risk: "low" },
  },
  {
    tool: { type: "function" as const, function: { name: "save_note", description: "Save a note.", parameters: {} } },
    handler: () => "saved",
  },
  {
    tool: { type: "function", function: { name: PING, description: "Ping.", parameters: {} } },
    handler: () => "pong",
    riskProfile: (args: { loud?: string }) => (args.loud ? { mutates: "external_side_effect", risk: "high", reason: "loud" } : { mutates: "none", risk: "low" }),
  },
]

export const replayed = { id: "call_1", type: "function", function: { name: "read_note", arguments: "{}" } }
export const forwarded = { id: "call_2", type: "function", function: replayed.function }
