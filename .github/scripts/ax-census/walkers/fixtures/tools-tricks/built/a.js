const def = (name, extra = {}) => ({ tool: { type: "function", function: { name, description: "d" } }, handler: () => "", ...extra })
exports.readDef = (name) => def(name)
exports.defs = [def("direct_one"), def("mapped_ref"), def("helper_policy", { approvalPolicy: () => ({ kind: "required" }) }), def("never_asks", { approvalPolicy: () => ({ kind: "not_required" }) })]
exports.exportedOnly = def("built_only")
