"use strict";
exports.restTool = { type: "function", function: { name: "rest", description: "End the turn.", parameters: {} } };
exports.toolCards = [{ id: "tool:rest", group: "notes", when: "Finish a private turn once nothing more needs doing until the next wake.", effect: "write", errors: [{ code: "unknown-tool", means: "The engine has no rest step in this turn.", fix: "End the turn with a plain reply instead." }] }];
