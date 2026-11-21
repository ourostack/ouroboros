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

// A kind the walker can't see in the branch (it comes from a table), behind a value no test argv has: only a
// declaration's example reaches it.
export type SealCommand = { kind: "seal"; code: string }
const SEAL = { kind: "seal" } as const

export function parseSeal(args: string[]): SealCommand {
  if (!/^[0-9]{6}$/.test(args[0] ?? "")) throw new Error("Usage: seal <6 digits>")
  return { kind: SEAL.kind, code: args[0]! }
}

// Words checked by guards that throw when they don't match (`!==`): the words after them are read below the guard.
export type KeyCommand = { kind: "key.add" } | { kind: "key.show" }

export function parseKey(args: string[]): KeyCommand {
  const vendor = args[0]
  const action = args[1]
  if (vendor !== "acme") throw new Error("Usage: key acme add|show")
  if (action !== "add" && action !== "show") throw new Error("Usage: key acme add|show")
  return action === "add" ? { kind: "key.add" } : { kind: "key.show" }
}
