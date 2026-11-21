// Tools forwarded from a connected server: excluded only when the name reads nothing but the function's parameters.
const PREFIX = "x_"

export function serverSchema(entry: { server: string }, tool: { name: string }) {
  return { type: "function" as const, function: { name: `mcp__${entry.server}__${tool.name}`, description: "forwarded" } }
}

export function leakySchema(tool: { name: string }) {
  return { type: "function" as const, function: { name: `${PREFIX}${tool.name}`, description: "forwarded" } }
}

export function literalOnly() {
  return { type: "function" as const, function: { name: "local_tool", description: "a real tool" } }
}

export function noSchema() {
  return null
}
