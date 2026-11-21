const def = (name) => ({ tool: { type: "function", function: { name, description: "d" } }, handler: () => "" })
exports.readDef = def
exports.one = def("direct_one")
