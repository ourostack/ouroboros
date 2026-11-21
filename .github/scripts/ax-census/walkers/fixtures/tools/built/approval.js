"use strict";
const card = (name, effect, extra = {}) => ({ id: `tool:${name}`, group: "notes", effect, errors: [{ code: "box-unreachable", means: `The ${name} target didn't answer.`, fix: `Check the ${name} target is up, then call again.` }], ...extra });
exports.approvalTools = [
  { tool: { type: "function", function: { name: "restart_box", description: "Restart the box.", parameters: {} } }, handler: () => "", riskProfile: { mutates: "external_side_effect", risk: "high", reason: "restarts" }, approvalPolicy: () => ({ kind: "required" }),
    ax: card("restart_box", "consequential", { when: "Bring a hung box back after its health check fails twice in a row.", confirm: "Restart the box now?" }) },
  { tool: { type: "function", function: { name: "list_contacts", description: "List contacts.", parameters: {} } }, handler: () => "[]", riskProfile: { mutates: "none", risk: "low" }, approvalPolicy: () => ({ kind: "not_required" }),
    ax: card("list_contacts", "read", { when: "See who may reach the agent before granting someone new access." }) },
  { tool: { type: "function", function: { name: "resume_queue", description: "Resume the queue.", parameters: {} } }, handler: () => "", riskProfile: { mutates: "external_side_effect", risk: "high", reason: "spends" }, approvalPolicy: () => ({ kind: "required" }),
    ax: card("resume_queue", "write", { when: "Restart paused downloads once the spending guard says credit remains." }) },
  { tool: { type: "function", function: { name: "send_mail", description: "Send mail.", parameters: {} } }, handler: () => "", riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends" },
    ax: card("send_mail", "consequential", { when: "Deliver a drafted reply after its recipient list has been checked.", confirm: "Send this mail?" }) },
  { tool: { type: "function", function: { name: "hidden_policy", description: "Policy set elsewhere.", parameters: {} } }, handler: () => "", approvalPolicy: () => ({ kind: "required" }) },
];
