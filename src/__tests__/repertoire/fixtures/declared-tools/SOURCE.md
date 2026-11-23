# Declared tools fixture

`tools.json` is ourostack/ouro-ui-core's `test/fixtures/actions/generated-tools/tools.json` at tag v1.11.0, byte for byte. It is what the ouro-actions-tools projection writes for core's synthetic shopping action set, which is not Spoonjoy's code or data. `mcp-declared-tools.test.ts` loads it as a bundle MCP server's declaration, and the AX census's MCP walker can read it as a bundle's declared doors.
