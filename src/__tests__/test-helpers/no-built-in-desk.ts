// Unit tests run agent turns on synthetic bundles with a desk/ folder; they must not start the real Desk the package
// ships (vendor/desk). Desk's own tests pass a Desk copy explicitly, and the integration lane runs the real one.
// This is `overrideBundledDeskDirForTests(null)` from src/repertoire/desk-mcp.ts, set without importing that module so
// each test file's mocks still apply to it.
;(globalThis as Record<symbol, unknown>)[Symbol.for("ouro.test.bundledDeskDir")] = null
