import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeMcpView, shutdownMcpFixtures } from "./mcp-fixture"
import { loadDeclaredTools, parseDeclaredTools } from "../../repertoire/mcp-declared-tools"
import { mcpToolsAsDefinitions } from "../../repertoire/mcp-tools"

// Unlike mcp-declared-tools.test.ts, the nerves runtime is real here, so the audit sees each warning these emit.
const tool = (name: string, effect?: string) => ({
  type: "function", function: { name, description: "Does it.", parameters: { type: "object" } },
  ax: { group: "turn-x", when: "Pick this to do it.", errors: [], ...(effect ? { effect } : {}) },
})

afterEach(shutdownMcpFixtures)

describe("declared tools' warnings", () => {
  it("emits each warning through the nerves runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-events-"))
    try {
      expect(loadDeclaredTools(root, "missing.json", "shop")).toBeNull()
      fs.writeFileSync(path.join(root, "part.json"), JSON.stringify({ tools: [tool("ok", "read"), tool("bad")] }))
      expect([...loadDeclaredTools(root, "part.json", "shop")!.keys()]).toEqual(["ok"])
      const declared = parseDeclaredTools({ tools: [tool("ok", "read"), tool("gone", "read")] }).tools
      const view = makeMcpView([{ server: "shop", tools: [{ name: "ok", description: "", inputSchema: { type: "object" } }], declared } as never])
      expect(mcpToolsAsDefinitions(view).map((d) => d.tool.function.name)).toEqual(["shop_ok"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
