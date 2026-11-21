// Ways a tool could slip past a census that only reads the plain shape (from review).
const FN = "function" as const
const base = { type: "function" as const }
const GATED = new Set(["spread_tool"])
export function readDef(name: string) { return { tool: { type: "function", function: { name, description: "d" } }, handler: () => "" } }
export const defs = [
  readDef("direct_one"),
  ...["mapped_ref"].map(readDef),
  { tool: { type: "function", function: { name: "helper_policy", description: "d" } }, handler: () => "", approvalPolicy: (a: { x?: string }) => (a.x ? requireOwner() : { kind: "not_required" }) },
  { tool: { type: "function", function: { name: "never_asks", description: "d" } }, handler: () => "", approvalPolicy: () => ({ kind: "not_required" }) },
]
export const flat = { type: "function", name: "flat_tool", parameters: {} }
export const viaConst = { type: FN, function: { name: "const_type_tool" } }
export const viaSpread = { ...base, function: { name: "spread_tool", description: "d" } }
export const computed = { type: "function", ["function"]: { name: "computed_tool" } }
function requireOwner() { return { kind: "required" } }
export function mcpSchema(entry: { server: string }, tool: { name: string }) {
  return { type: "function" as const, function: { name: tool.name || "shell" } }
}
export function mcpTwice(entry: { server: string }, tool: { name: string }) {
  const one = { type: "function" as const, function: { name: `a_${entry.server}_${tool.name}` } }
  const two = { type: "function" as const, function: { name: `b_${entry.server}_${tool.name}` } }
  return [one, two]
}
export function mcpOk(entry: { server: string }, tool: { name: string }) {
  return { type: "function" as const, function: { name: `mcp__${entry.server}__${tool.name}` } }
}
export const hidden = mcpOk({ server: "shell2" }, { name: "" })
export function resolver(name: string) {
  switch (name) { case "direct_one": return 2 }
  if (GATED.has(name)) return 4
  return ["computed_tool"].includes(name) ? 3 : 0
}
export function reencode(tools: { function: { name: string } }[]) {
  return tools.map((t) => ({ type: "function" as const, name: t.function.name, parameters: {} }))
}
export function leakyReencode(tools: { function: { name: string } }[]) {
  return tools.map((t) => ({ type: "function" as const, name: `${FN}_${t.function.name}`, parameters: {} }))
}
export const exportedOnly = { tool: makeSchema("built_only"), handler: () => "" }
declare function makeSchema(name: string): { type: "function"; function: { name: string } }
export const anonymous = ["x"].map((label: string) => ({ type: "function", function: { name: label } }))
function listedLater(name: string) { return { type: "function", function: { name, description: "d" } } }
export { listedLater }
