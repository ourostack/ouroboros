# Bundle-declared tools

An agent bundle can declare the tools one of its own MCP servers serves, so their schemas and their Ouro AX cards come from one declaration.

1. Declare the server's tools as actions with Ouro UI core's action model (`defineAction`, with `when` and `errors`). Generate `tools.json` with the in-turn tools projection, `ouro-actions-tools.mts`, vendored from an ouro-ui-core release (v1.11.0 or later): `node ouro-actions-tools.mts generate <actions.mts> <dir>`.
2. Commit `tools.json` into the bundle, and name it on the server in `agent.json`:

   ```json
   "mcpServers": {
     "shop": { "command": "node", "args": ["mcp/shop-mcp.mjs"], "tools": "mcp/tools.json" }
   }
   ```

The path is inside the bundle, either relative to it or absolute. The harness reads it each time it freezes a turn's MCP view (`src/repertoire/mcp-declared-tools.ts`), and only for the bundle's own `mcpServers`, never for plugin or runtime servers.

The harness handles each tool like this:

- **A served tool the declaration names** reaches the model with the declared description and parameters, and carries the declared card as `ax` (id `tool:<surfaced name>`). Its risk comes from the card's effect: low only for `read`, high for `write` and `consequential`. The call still goes to the server under the served schema's binding.
- **A served tool the declaration doesn't name** stays as every MCP tool is (`mcpToolsAsDefinitions`): its card is made from what its server says, and it's high risk unless the agent's own server marks it read-only.
- **A declared tool the server doesn't serve** is not surfaced, and the `mcp.declared_tool_unserved` nerves event names it.
- **A tool declared `person-only`** is never surfaced.
- **An entry that isn't a whole declaration** (no effect, no `when`, a consequential one with no confirm question) is left out with `mcp.declared_tools_incomplete`, and its tool stays undeclared. A path outside the bundle, or a file that isn't JSON, gives `mcp.declared_tools_unreadable`.

`src/__tests__/repertoire/fixtures/declared-tools/tools.json` is core's fixture at v1.11.0, byte for byte.
