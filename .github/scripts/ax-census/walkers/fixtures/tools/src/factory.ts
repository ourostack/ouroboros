// A factory that takes the name as a parameter: each literal call is a door, any other call is unwalked.
declare const dynamicName: string

function define(name: string, description: string) {
  return { tool: { type: "function", function: { name, description, parameters: {} } }, handler: () => "rows", riskProfile: { mutates: "durable_state_write", risk: "high", reason: "rows" } }
}

export const rowTools = [
  define("list_rows", "List rows."),
  define("drop_rows", "Drop rows."),
  define(dynamicName, "Some rows."),
]

export const orphan = (label: string) => ({ type: "function", function: { name: label, description: "Never called." } })
export const opaque = { type: "function", function: makeFunction() }
declare function makeFunction(): { name: string }

export const toggles = (["pause", "resume"] as const).map((action) => define(`queue_${action}`, "Toggle the queue."))
export const notListed = ["a", "b"].map((x) => [x].map((action) => define(`deep_${action}`, "")))
declare const free: string
export const pairs = (a: string, b: string) => define(`two_${a}_${b}`, "")
export const keyed = (obj: { k: string }) => define(`key_${obj.k}`, "")
export const loose = define(`free_${free}`, "")
export const looped = ["x"].forEach((action) => define(`each_${action}`, ""))
