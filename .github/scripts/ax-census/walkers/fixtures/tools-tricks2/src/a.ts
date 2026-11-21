// More ways to hide a tool (second review).
const K = { fn: "function" as const }
export function readDef(name: string) { return { tool: { type: "function", function: { name, description: "d" } }, handler: () => "" } }
export const one = readDef("direct_one")
export const propType = { tool: { type: K.fn, function: { name: "prop_type_tool", parameters: {} } }, handler: () => "" }
export function mcpSchema(entry: { server: string }, tool: { name: string }) {
  return { type: "function" as const, function: { name: `${entry.server}_${tool.name}` } }
}
const SHELL = { name: "shell_hidden" }
export const viaConstArg = mcpSchema({ server: entry() }, SHELL)
function entry() { return "x" }
export function forwardAll(entries: { server: string; tools: { name: string }[] }[]) {
  return entries.flatMap((e) => { const picked = e.tools.filter((t) => t.name); return picked.map((t) => mcpSchema(e, t)) })
}
export function reshapeIt(defs: { function: { name: string } }[]) {
  const sneaky = "sneaky_flat"
  return defs.map((d) => ({ type: "function", name: d.function.name || sneaky, parameters: {} }))
}
export function reshapeLoop(defs: { function: { name: string } }[]) {
  const out = []
  for (const { function: fn } of defs) out.push({ type: "function", name: fn.name, parameters: {} })
  return out
}
const GRANTS: Record<string, number> = {}
export function resolver(name: string, imported: Set<string>) {
  if (name === "direct_one") return 1
  if (imported.has(name)) return 2
  return GRANTS[name] ?? 0
}
