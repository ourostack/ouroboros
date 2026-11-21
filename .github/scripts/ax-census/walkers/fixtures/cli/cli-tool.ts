// A sub-parser in another file, reached through an import.
export type ToolCommand = { kind: "tool.run"; name: string }

export function parseToolCommand(args: string[]): ToolCommand {
  const sub = args[0]
  if (sub === "run") {
    const at = args.indexOf("--name")
    if (at === -1 || !args[at + 1]) throw new Error("Usage: tool run --name <name>")
    return { kind: "tool.run", name: args[at + 1]! }
  }
  throw new Error("Usage: tool run --name <name>")
}
