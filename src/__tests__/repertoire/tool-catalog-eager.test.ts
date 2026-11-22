import { beforeEach, describe, expect, it } from "vitest"
import { buildToolCatalog, TURN_TOOL_NAMES } from "../../repertoire/tool-catalog"
import { baseToolDefinitions } from "../../repertoire/tools-base"
import { emitNervesEvent } from "../../nerves/runtime"

/** The tools an agent reaches for on almost any turn stay loaded; everything else is found with find_tools. */
const EAGER_CARDS = ["send_message", "read_file", "edit_file", "grep", "shell", "load_skill"]

describe("eager tool cards", () => {
  beforeEach(() => {
    emitNervesEvent({ component: "repertoire", event: "repertoire.test_run", message: "eager tool cards", meta: { test: true } })
  })

  it("keeps the turn tools and the six everyday tools loaded, and only those", () => {
    const catalog = buildToolCatalog(baseToolDefinitions.map((definition) => ({ tool: definition.tool, ax: definition.ax })))
    const eager = catalog.doors.filter((door) => door.eager).map((door) => door.name).sort()
    const turnTools = catalog.doors.map((door) => door.name).filter((name) => TURN_TOOL_NAMES.has(name))
    expect(eager).toEqual([...turnTools, ...EAGER_CARDS].sort())
  })
})
