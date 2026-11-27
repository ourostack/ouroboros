// Unit tests run on machines with no Butler image, and many mock fs, so a process that hasn't loaded a product must not
// read /opt/ouro/container-runtime.json on its first productFor. This sets the switch src/heart/product/active.ts reads,
// without importing that module, so each test file's mocks still apply to it. Tests that need a product load it
// (useButlerProduct); the product seam's own tests clear the switch to read a policy.
;(globalThis as Record<symbol, unknown>)[Symbol.for("ouro.test.noImageProduct")] = true
