import * as t from "./a"
import { mcpSchema as m } from "./a"
export const ns = t.readDef("namespace_tool")
export const aliased = m({ server: "s" }, { name: "alias_lit" })
export { readDef } from "./a"
